import fs from 'fs';
import { ClobClient } from '@polymarket/clob-client';
import { GammaClient } from '@polymarket/gamma-client';
import dotenv from 'dotenv';

dotenv.config();

// ---------- 配置 ----------
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const PROFILE_ADDRESS = process.env.PROFILE_ADDRESS!;
const COPY_TRADERS = process.env.COPY_TRADERS?.split(',') || [];
const COPY_STRATEGY = process.env.COPY_STRATEGY || 'FIXED_USD';
const FIXED_TRADE_USD = parseFloat(process.env.FIXED_TRADE_USD || '5');
const MIN_TRADE_USD = parseFloat(process.env.MIN_TRADE_USD || '5');
const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_USD || '5');
const MAX_DAILY_VOLUME_USD = parseFloat(process.env.MAX_DAILY_VOLUME_USD || '40');
const DRY_RUN = process.env.DRY_RUN === 'true';
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1');

// ---------- 初始化客户端 ----------
const clob = new ClobClient({
  host: 'https://clob.polymarket.com',
  chainId: 137,
  privateKey: PRIVATE_KEY,
  signatureType: SIGNATURE_TYPE,
});

const gamma = new GammaClient();

// ---------- 持久化已跟单市场 ----------
const PROCESSED_FILE = '/data/processed_conditions.json';
let processedConditions: Set<string> = new Set();

try {
  const data = fs.readFileSync(PROCESSED_FILE, 'utf-8');
  const arr = JSON.parse(data);
  processedConditions = new Set(arr);
  console.log(`已加载 ${processedConditions.size} 个已跟单市场`);
} catch (err) {
  console.log('未找到历史记录，将创建新文件');
}

function saveProcessedConditions() {
  const arr = Array.from(processedConditions);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr, null, 2));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function placeOrder(tokenId: string, side: 'BUY' | 'SELL', notional: number) {
  if (DRY_RUN) {
    log(`DRY_RUN 订单 ${side} ${tokenId} ${notional} USD`);
    return;
  }
  // 真实下单逻辑（此处简化，实际需获取价格、计算份额）
  log(`真实下单 ${side} ${tokenId} ${notional} USD`);
}

async function handleCopyTrade(trade: any) {
  try {
    const tokenId = trade.tokenId;
    let conditionId = trade.conditionId;

    if (!conditionId) {
      const market = await gamma.markets.getMarketByTokenId(tokenId);
      conditionId = market?.conditionId;
    }

    if (!conditionId) return;

    if (processedConditions.has(conditionId)) {
      log(`跳过已跟单市场: ${conditionId}`);
      return;
    }

    await placeOrder(tokenId, trade.side, FIXED_TRADE_USD);

    processedConditions.add(conditionId);
    saveProcessedConditions();
    log(`跟单成功: ${conditionId} ${FIXED_TRADE_USD} USD`);
  } catch (err) {
    log(`跟单失败: ${err}`);
  }
}

async function fetchTrades(trader: string, since: number) {
  const trades = await gamma.trades.getTrades({ trader, start: since, limit: 50 });
  for (const trade of trades) {
    await handleCopyTrade(trade);
  }
}

async function main() {
  log('启动机器人 (每场比赛仅跟单一次)');
  if (!COPY_TRADERS.length) {
    log('未配置 COPY_TRADERS');
    return;
  }

  let lastTimestamp = Math.floor(Date.now() / 1000) - 3600;
  while (true) {
    for (const trader of COPY_TRADERS) {
      await fetchTrades(trader, lastTimestamp);
    }
    lastTimestamp = Math.floor(Date.now() / 1000);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
}

main().catch(log);
