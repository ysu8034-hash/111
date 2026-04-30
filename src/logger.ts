import "dotenv/config";
import { webcrypto } from "crypto";
import { ClobService } from "./clob.js";
import { createLogger } from "./logger.js";

// 给签名用（必须）
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

const logger = createLogger(true);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const clob = await ClobService.init(
    {
      host: "https://clob.polymarket.com",
      chainId: 137,
      privateKey: process.env.PRIVATE_KEY!,
      signatureType: 1,
    },
    logger
  );

  logger.info("Bot started (idle mode)");

  // 👇 保持进程不退出（后面你可以加策略）
  while (true) {
    try {
      // 现在先空跑（你后面加 copy / strategy）
      logger.info("Heartbeat...");
    } catch (err) {
      logger.error("Loop error", err);
    }

    await sleep(10000); // 10秒一次
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
