import { Side } from "@polymarket/clob-client";
import { Config, CopyStrategy } from "./config.js";
import { ClobService } from "./clob.js";
import { DataApiClient } from "./dataApi.js";
import { Logger } from "./logger.js";
import { State, ensureDailyVolume, noteSeenTrade } from "./state.js";
import { ActivityTrade, Position } from "./types.js";
import { formatUsd, isPositive, nowSec } from "./utils.js";
import fs from "fs";

class PositionCache {
  private lastFetch = 0;
  private positions: Position[] = [];

  constructor(
    private dataApi: DataApiClient,
    private profileAddress: string,
    private ttlMs: number,
    private logger: Logger
  ) {}

  async getPositions(force = false): Promise<Position[]> {
    const now = Date.now();
    if (!force && now - this.lastFetch < this.ttlMs) return this.positions;
    this.positions = await this.dataApi.getPositions(this.profileAddress);
    this.lastFetch = now;
    return this.positions;
  }

  async getPositionByToken(tokenId: string): Promise<Position | undefined> {
    const positions = await this.getPositions();
    return positions.find((p) => p.asset === tokenId);
  }
}

export class CopyTrader {
  private positionCache: PositionCache;
  // conditionId 去重相关
  private processedConditions: Set<string> = new Set();
  private readonly processedFile = "/data/processed_conditions.json";
  private conditionIdCache: Map<string, string> = new Map();

  // 防抖保存相关
  private saveTimeout: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000; // 5秒内的多次保存合并为一次

  // 滑点阈值（从环境变量读取，默认 0.05 = 5%）
  private readonly slippageTolerance: number;

  constructor(
    private config: Config,
    private clob: ClobService,
    private dataApi: DataApiClient,
    private state: State,
    private logger: Logger
  ) {
    this.positionCache = new PositionCache(dataApi, config.profileAddress, 30000, logger);
    this.loadProcessedConditions();
    this.slippageTolerance = parseFloat(process.env.SLIPPAGE_TOLERANCE || "0.05");

    // 注册进程退出时的强制保存，防止防抖丢失数据
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown() {
    const forceSave = () => {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveProcessedConditionsImmediate();
      }
    };
    process.on("beforeExit", forceSave);
    process.on("SIGTERM", forceSave);
  }

  private loadProcessedConditions() {
    try {
      const data = fs.readFileSync(this.processedFile, "utf-8");
      const arr = JSON.parse(data);
      this.processedConditions = new Set(arr);
      this.logger.info(`已加载 ${this.processedConditions.size} 个已跟单市场 (conditionId)`);
    } catch (err) {
      this.logger.info("未找到历史记录，将创建新文件");
    }
  }

  private saveProcessedConditionsImmediate() {
    const arr = Array.from(this.processedConditions);
    fs.writeFileSync(this.processedFile, JSON.stringify(arr, null, 2));
  }

  private saveProcessedConditionsDebounced() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveProcessedConditionsImmediate();
      this.saveTimeout = null;
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async getConditionId(tokenId: string): Promise<string | null> {
    if (this.conditionIdCache.has(tokenId)) {
      return this.conditionIdCache.get(tokenId)!;
    }
    try {
      const market = await this.dataApi.getMarketByTokenId(tokenId);
      if (market?.conditionId) {
        this.conditionIdCache.set(tokenId, market.conditionId);
        return market.conditionId;
      }
    } catch (err) {
      this.logger.debug(`获取 conditionId 失败 ${tokenId}: ${err}`);
    }
    return null;
  }

  private tradeKey(trade: ActivityTrade): string {
    return `${trade.transactionHash}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}`;
  }

  private effectiveRatio(trader: string): number {
    return this.config.traderAllocations[trader] ?? this.config.copyRatio;
  }

  private computeSize(trade: ActivityTrade): { size: number; notional: number } | null {
    const price = typeof trade.price === "string" ? parseFloat(trade.price) : trade.price;
    if (!isPositive(price)) return null;

    const ratio = this.effectiveRatio(trade.proxyWallet.toLowerCase());
    let size = 0;
    let notional = 0;

    switch (this.config.copyStrategy as CopyStrategy) {
      case "PERCENT_USD":
        notional = trade.usdcSize * ratio;
        size = notional / price;
        break;
      case "PERCENT_SHARES":
        size = trade.size * ratio;
        notional = size * price;
        break;
      case "FIXED_USD":
        notional = this.config.fixedUsd;
        size = notional / price;
        break;
      case "FIXED_SHARES":
        size = this.config.fixedShares;
        notional = size * price;
        break;
      default:
        return null;
    }

    if (!isPositive(size) || !isPositive(notional)) return null;
    return { size, notional };
  }

  private clampToLimits(
    side: Side,
    size: number,
    notional: number,
    price: number
  ): { size: number; notional: number } | null {
    if (notional < this.config.minTradeUsd) return null;

    if (notional > this.config.maxTradeUsd) {
      notional = this.config.maxTradeUsd;
      size = notional / price;
    }

    if (!isPositive(size) || !isPositive(notional)) return null;

    if (side === Side.BUY) {
      ensureDailyVolume(this.state);
      const remaining = this.config.maxDailyVolumeUsd - this.state.dailyVolume.spentUsd;
      if (remaining <= 0) return null;
      if (notional > remaining) {
        notional = remaining;
        size = notional / price;
        if (notional < this.config.minTradeUsd) return null;
      }
    }

    return { size, notional };
  }

  private async clampToPosition(
    side: Side,
    tokenId: string,
    size: number,
    notional: number,
    price: number
  ) {
    if (side === Side.BUY) {
      const position = await this.positionCache.getPositionByToken(tokenId);
      const priceHint = position?.curPrice ?? position?.avgPrice ?? price;
      const currentValue = position ? priceHint * position.size : 0;
      const remaining = this.config.maxPositionSizeUsd - currentValue;
      if (remaining <= 0) return null;
      if (notional > remaining) {
        notional = remaining;
        size = notional / price;
        if (notional < this.config.minTradeUsd) return null;
      }
      return { size, notional };
    }

    const position = await this.positionCache.getPositionByToken(tokenId);
    if (!position || position.size <= 0) return null;
    if (size > position.size) {
      size = position.size;
      notional = size * price;
      if (notional < this.config.minTradeUsd) return null;
    }
    return { size, notional };
  }

  private shouldCopySide(trade: ActivityTrade): boolean {
    if (this.config.copySide === "BOTH") return true;
    return this.config.copySide === trade.side;
  }

  private async getBestPrice(tokenId: string, side: Side, retries = 1): Promise<number | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const orderBook = await this.clob.getOrderBook(tokenId);
        if (side === Side.BUY) {
          if (orderBook.asks.length) return parseFloat(orderBook.asks[0].price);
        } else {
          if (orderBook.bids.length) return parseFloat(orderBook.bids[0].price);
        }
      } catch (err) {
        this.logger.debug(`获取订单簿失败 (尝试 ${attempt + 1}): ${err}`);
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async handleTrade(trade: ActivityTrade, trader: string): Promise<void> {
    // 1. 禁止跟单自己的交易
    if (trader.toLowerCase() === this.config.profileAddress.toLowerCase()) {
      this.logger.debug(`跳过自己的交易: ${trader}`);
      return;
    }

    // 2. 方向过滤
    if (!this.shouldCopySide(trade)) return;

    // 3. 获取 conditionId（必须）
    let conditionId = (trade as any).conditionId;
    if (!conditionId) {
      conditionId = await this.getConditionId(trade.asset);
    }
    if (!conditionId) {
      this.logger.warn(`无法获取 conditionId，跳过交易: tokenId=${trade.asset}, trader=${trader}`);
      return;
    }

    // 4. 去重检查
    if (this.processedConditions.has(conditionId)) {
      this.logger.debug(`跳过已跟单市场 (conditionId): ${conditionId}, trader=${trader}`);
      return;
    }

    // 5. 业务逻辑：计算目标金额和份额
    const tradeKey = this.tradeKey(trade);
    if (this.state.seenTrades[tradeKey]) return;

    const computed = this.computeSize(trade);
    if (!computed) {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    let size = computed.size;
    let notional = computed.notional;

    // 风控1：全局限额、单笔限额
    const priceNum = typeof trade.price === "string" ? parseFloat(trade.price) : trade.price;
    const clamped = this.clampToLimits(side, size, notional, priceNum);
    if (!clamped) {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = clamped.size;
    notional = clamped.notional;

    // 风控2：单个市场持仓限额
    const positionClamped = await this.clampToPosition(side, trade.asset, size, notional, priceNum);
    if (!positionClamped) {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = positionClamped.size;
    notional = positionClamped.notional;

    // 6. 获取当前市场最优价格（带重试）
    const executionPrice = await this.getBestPrice(trade.asset, side, 1);
    if (executionPrice === null) {
      this.logger.warn(`无法获取订单簿价格，跳过订单`, { tokenId: trade.asset });
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    // 7. 滑点保护（使用可配置阈值）
    const originalPrice = priceNum;
    const slippage = Math.abs(executionPrice - originalPrice) / originalPrice;
    if (slippage > this.slippageTolerance) {
      this.logger.warn(`价格滑落过大 (${(slippage * 100).toFixed(1)}%)，放弃订单`, {
        tradePrice: originalPrice,
        executionPrice,
        trader,
        tokenId: trade.asset,
        tolerance: this.slippageTolerance,
      });
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    // 8. 模拟或真实下单
    if (this.config.dryRun) {
      this.logger.info("DRY_RUN order", {
        trader,
        side: trade.side,
        tokenId: trade.asset,
        conditionId,
        originalPrice,
        executionPrice,
        size,
        notional: formatUsd(notional),
      });
      // 模拟模式也记录已跟单
      if (!this.processedConditions.has(conditionId)) {
        this.processedConditions.add(conditionId);
        this.saveProcessedConditionsDebounced();
      }
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    try {
      await this.clob.placeLimitOrder({
        tokenId: trade.asset,
        side,
        price: executionPrice,
        size,
      });
      if (side === Side.BUY) {
        ensureDailyVolume(this.state);
        this.state.dailyVolume.spentUsd += notional;
      }
      this.logger.info("Order placed", {
        trader,
        side: trade.side,
        tokenId: trade.asset,
        conditionId,
        originalPrice,
        executionPrice,
        size,
        notional: formatUsd(notional),
      });

      // 记录已跟单（防抖保存）
      if (!this.processedConditions.has(conditionId)) {
        this.processedConditions.add(conditionId);
        this.saveProcessedConditionsDebounced();
        this.logger.info(`已记录市场: ${conditionId}`);
      }
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      if (message.includes("not enough balance") || message.includes("allowance")) {
        this.logger.error("Order rejected: insufficient USDC balance or allowance.", {
          profile: this.config.profileAddress,
          hint: "Deposit USDC to your Polymarket account and ensure allowance is set in the Polymarket UI.",
        });
      }
      this.logger.warn("Order failed", { error: message });
    } finally {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
    }
  }

  async runOnce(): Promise<void> {
    const now = nowSec();

    for (const trader of this.config.copyTraders) {
      this.logger.debug("Polling trader", { trader });
      const last = this.state.lastSeen[trader];
      const start = last ? last + 1 : now - this.config.tradeLookbackSec;

      let trades: ActivityTrade[] = [];
      try {
        trades = await this.dataApi.getTrades(trader, start, now, 100);
      } catch (err) {
        this.logger.warn("Failed to fetch trades", { trader, error: (err as Error).message });
        continue;
      }

      if (trades.length === 0) {
        this.logger.debug("No trades found", { trader, start, end: now });
        continue;
      }

      for (const trade of trades) {
        await this.handleTrade(trade, trader);
        this.state.lastSeen[trader] = Math.max(this.state.lastSeen[trader] || 0, trade.timestamp);
      }
    }
  }
}
