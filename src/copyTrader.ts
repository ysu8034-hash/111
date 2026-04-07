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

  constructor(
    private config: Config,
    private clob: ClobService,
    private dataApi: DataApiClient,
    private state: State,
    private logger: Logger
  ) {
    this.positionCache = new PositionCache(dataApi, config.profileAddress, 30000, logger);
    this.loadProcessedConditions();
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

  private saveProcessedConditions() {
    const arr = Array.from(this.processedConditions);
    fs.writeFileSync(this.processedFile, JSON.stringify(arr, null, 2));
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
    const price = trade.price;
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

  async handleTrade(trade: ActivityTrade): Promise<void> {
    if (!this.shouldCopySide(trade)) return;

    // 获取 conditionId 进行去重
    let conditionId = (trade as any).conditionId;
    if (!conditionId) {
      conditionId = await this.getConditionId(trade.asset);
    }

    if (conditionId) {
      if (this.processedConditions.has(conditionId)) {
        this.logger.debug(`跳过已跟单市场 (conditionId): ${conditionId}`);
        return;
      }
    } else {
      // 降级：使用 tokenId 去重
      this.logger.warn(`无法获取 conditionId，降级使用 tokenId 去重: ${trade.asset}`);
      // 这里可以保留一个基于 tokenId 的 Set，但为了简单，我们直接使用 tokenId 字符串去重
      // 为了不破坏原有逻辑，我们复用 processedConditions 但加上前缀 "token:" 
      const fallbackKey = `token:${trade.asset}`;
      if (this.processedConditions.has(fallbackKey)) {
        this.logger.debug(`跳过已跟单市场 (tokenId): ${trade.asset}`);
        return;
      }
      // 记录时也用 fallbackKey
      conditionId = fallbackKey;
    }

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

    const clamped = this.clampToLimits(side, size, notional, trade.price);
    if (!clamped) {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = clamped.size;
    notional = clamped.notional;

    const positionClamped = await this.clampToPosition(
      side,
      trade.asset,
      size,
      notional,
      trade.price
    );
    if (!positionClamped) {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = positionClamped.size;
    notional = positionClamped.notional;

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN order", {
        side: trade.side,
        tokenId: trade.asset,
        conditionId,
        price: trade.price,
        size,
        notional: formatUsd(notional),
      });
      // 模拟模式也记录已跟单
      if (!this.processedConditions.has(conditionId)) {
        this.processedConditions.add(conditionId);
        this.saveProcessedConditions();
      }
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    try {
      await this.clob.placeLimitOrder({
        tokenId: trade.asset,
        side,
        price: trade.price,
        size,
      });
      if (side === Side.BUY) {
        ensureDailyVolume(this.state);
        this.state.dailyVolume.spentUsd += notional;
      }
      this.logger.info("Order placed", {
        side: trade.side,
        tokenId: trade.asset,
        conditionId,
        price: trade.price,
        size,
        notional: formatUsd(notional),
      });

      // 记录已跟单
      if (!this.processedConditions.has(conditionId)) {
        this.processedConditions.add(conditionId);
        this.saveProcessedConditions();
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
        await this.handleTrade(trade);
        this.state.lastSeen[trader] = Math.max(this.state.lastSeen[trader] || 0, trade.timestamp);
      }
    }
  }
}
