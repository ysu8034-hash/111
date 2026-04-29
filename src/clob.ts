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
  apiCreds?: ApiKeyCreds;
}

export interface MarketMeta {
  tickSize: TickSize;
  minOrderSize: number;
  negRisk: boolean;
}

export class ClobService {
  private client: ClobClient;
  private logger: Logger;
  private metaCache: Map<string, { meta: MarketMeta; ts: number }> = new Map();

  private static isValidCreds(creds: unknown): creds is ApiKeyCreds {
    if (!creds || typeof creds !== "object") return false;
    const c = creds as ApiKeyCreds;
    return Boolean(c.key && c.secret && c.passphrase);
  }

  private constructor(client: ClobClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static async init(config: ClobConfig, logger: Logger): Promise<ClobService> {
    const signer = new Wallet(config.privateKey);
    
    logger.info(`Initializing ClobClient with signatureType: ${config.signatureType}`);
    
    // 临时硬编码，强制使用你的 API Key
    config.apiCreds = {
      key: "019dd991-8d22-73dd-a599-2d0e989e24a2",
      secret: "M_pUrU7MK7u03mEOrURiahHZ-PUF-kbS70Zhj08xgzw=",
      passphrase: "4e9ebc7566fec32862a17debaa819278b4d7e79c3dce405f9d418cc94e1ce14c"
    };
    
    const temp = new ClobClient({
      host: config.host,
      chain: config.chainId,
      signer: signer,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });

    // 优先使用 config 中已有的 API Key
    let creds = config.apiCreds;
    
    if (creds) {
      logger.info("Using provided API key");
    } else {
      // 如果没有提供，尝试派生
      logger.info("No API key provided, attempting to derive");
      const derived = await temp.deriveApiKey();
      if (ClobService.isValidCreds(derived)) {
        creds = derived;
        logger.info("Derived existing API key");
      } else {
        // 派生失败，创建新的
        logger.info("No existing API key found, creating new one");
        const created = await temp.createApiKey();
        if (ClobService.isValidCreds(created)) {
          creds = created;
          logger.info("Created new API key");
        } else {
          throw new Error(
            "Unable to create or derive API keys. Check SIGNATURE_TYPE, PRIVATE_KEY, and FUNDER_ADDRESS/PROFILE_ADDRESS.",
          );
        }
      }
    }

    const client = new ClobClient({
      host: config.host,
      chain: config.chainId,
      signer: signer,
      creds: creds,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });
    return new ClobService(client, logger);
  }

  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.meta;

    const ob = await this.client.getOrderBook(tokenId);
    const meta: MarketMeta = {
      tickSize: ob.tick_size as TickSize,
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };
    this.metaCache.set(tokenId, { meta, ts: now });
    return meta;
  }

  private roundToTick(price: number, tickSize: TickSize, side: Side): number {
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    const factor = 1 / tick;
    const raw = price * factor;
    const rounded = side === Side.BUY ? Math.floor(raw) : Math.ceil(raw);
    const result = rounded / factor;
    const decimals = tickSize.includes("0.0001")
      ? 4
      : tickSize.includes("0.001")
        ? 3
        : tickSize.includes("0.01")
          ? 2
          : 1;
    return Number(result.toFixed(decimals));
  }

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
      this.logger.warn("Order size below minimum", {
        tokenId,
        size,
        min: meta.minOrderSize,
      });
      return;
    }

    const expiration = Math.floor(Date.now() / 1000) + 300;

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side,
        size,
        expiration,
      },
      { tickSize: meta.tickSize, negRisk: meta.negRisk },
      OrderType.GTD,
    );
    
    if (resp?.error) {
      throw new Error(resp.error);
    }
    if (resp?.status && resp.status >= 400) {
      throw new Error(`Order failed (status ${resp.status})`);
    }
    
    this.logger.info("Order placed successfully (V2)", { tokenId, side, price, size });
  }
}
