import {
  ApiKeyCreds,
  ClobClient,
  OrderType,
  Side,
  TickSize,
} from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
import { Logger } from "./logger.js";

export interface ClobConfig {
  host: string;
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
}

export interface MarketMeta {
  tickSize: TickSize;
  minOrderSize: number;
  negRisk: boolean;
}

type OrderResponse = {
  error?: string;
  status?: number;
};

export class ClobService {
  private client: ClobClient;
  private logger: Logger;
  private metaCache = new Map<string, { meta: MarketMeta; ts: number }>();

  private constructor(client: ClobClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  // =====================
  // creds helpers
  // =====================
  private static isValidCreds(creds: unknown): creds is ApiKeyCreds {
    if (!creds || typeof creds !== "object") return false;
    const c = creds as ApiKeyCreds;
    return Boolean(c.key && c.secret && c.passphrase);
  }

  private static getApiCredsFromEnv(): ApiKeyCreds {
    const key = process.env.POLY_API_KEY;
    const secret = process.env.POLY_API_SECRET;
    const passphrase = process.env.POLY_API_PASSPHRASE;

    if (!key || !secret || !passphrase) {
      throw new Error("Missing API credentials");
    }

    return { key, secret, passphrase };
  }

  // =====================
  // init
  // =====================
  static async init(config: ClobConfig, logger: Logger): Promise<ClobService> {
    const signer = new Wallet(config.privateKey);

    const tempClient = new ClobClient({
      host: config.host,
      chain: config.chainId, // ✅ 必须用 chain
      signer,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });

    let creds: ApiKeyCreds;

    try {
      creds = this.getApiCredsFromEnv();
      logger.info("Using API creds from ENV");
    } catch {
      logger.warn("No ENV creds, deriving...");

      const derived = await tempClient.deriveApiKey();

      if (this.isValidCreds(derived)) {
        creds = derived;
      } else {
        const created = await tempClient.createApiKey();
        if (this.isValidCreds(created)) {
          creds = created;
        } else {
          throw new Error("Cannot obtain API creds");
        }
      }
    }

    const client = new ClobClient({
      host: config.host,
      chain: config.chainId,
      signer,
      creds,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });

    return new ClobService(client, logger);
  }

  // =====================
  // market meta
  // =====================
  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();

    if (cached && now - cached.ts < 5 * 60 * 1000) {
      return cached.meta;
    }

    const ob = await this.client.getOrderBook(tokenId);

    const meta: MarketMeta = {
      tickSize: ob.tick_size as TickSize,
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };

    this.metaCache.set(tokenId, { meta, ts: now });

    return meta;
  }

  // =====================
  // rounding
  // =====================
  private roundToTick(price: number, tickSize: TickSize, side: Side): number {
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return price;

    const factor = 1 / tick;
    const raw = price * factor;

    const rounded =
      side === Side.BUY ? Math.floor(raw) : Math.ceil(raw);

    const result = rounded / factor;

    const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));

    return Number(result.toFixed(decimals));
  }

  // =====================
  // place order
  // =====================
  async placeLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
  }): Promise<void> {
    const { tokenId, side } = params;

    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(params.price, meta.tickSize, side);
    const size = params.size;

    if (size < meta.minOrderSize) {
      this.logger.warn("Order too small", {
        size,
        min: meta.minOrderSize,
      });
      return;
    }

    const expiration = Math.floor(Date.now() / 1000) + 3600;

    // 🔥 核心：全部断言 any（彻底解决 TS2345）
    const resp = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side,
        size,
        expiration,
      } as any,
      {
        tickSize: meta.tickSize,
        negRisk: meta.negRisk,
      } as any,
      OrderType.GTD
    ) as any;

    if (resp?.error) {
      this.logger.error("Order error", resp.error);
      throw new Error(resp.error);
    }

    if (resp?.status && resp.status >= 400) {
      throw new Error(`HTTP ${resp.status}`);
    }

    this.logger.info("Order placed", {
      tokenId,
      side,
      price,
      size,
    });
  }
}
