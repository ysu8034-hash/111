import { Logger } from "./logger.js";
import { ActivityTrade, Position } from "./types.js";

export class DataApiClient {
  constructor(
    private host: string,
    private logger: Logger
  ) {}

  async getTrades(
    trader: string,
    start: number,
    end: number,
    limit: number
  ): Promise<ActivityTrade[]> {
    const url = `${this.host}/trades?trader=${trader}&start=${start}&end=${end}&limit=${limit}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      return data || [];
    } catch (err) {
      this.logger.error("Failed to fetch trades", { trader, error: (err as Error).message });
      return [];
    }
  }

  async getPositions(profileAddress: string, settled = false): Promise<Position[]> {
    const url = `${this.host}/positions?profile=${profileAddress}&settled=${settled}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      return data || [];
    } catch (err) {
      this.logger.error("Failed to fetch positions", { error: (err as Error).message });
      return [];
    }
  }

  /**
   * 通过 tokenId 获取市场信息（含 conditionId）
   * 使用 Gamma API 端点：https://gamma-api.polymarket.com/markets?token_id=
   */
  async getMarketByTokenId(tokenId: string): Promise<{ conditionId: string } | null> {
    const url = `https://gamma-api.polymarket.com/markets?token_id=${tokenId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0 && data[0].conditionId) {
        return { conditionId: data[0].conditionId };
      }
      return null;
    } catch (err) {
      this.logger.debug(`Failed to fetch market for token ${tokenId}: ${err}`);
      return null;
    }
  }
}
