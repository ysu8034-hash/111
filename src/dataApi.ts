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

  // 新增：通过 tokenId 获取市场信息（含 conditionId）
  async getMarketByTokenId(tokenId: string): Promise<{ conditionId: string } | null> {
    const url = `${this.host}/markets/token/${tokenId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return data || null;
    } catch (err) {
      this.logger.debug(`Failed to fetch market for token ${tokenId}: ${err}`);
      return null;
    }
  }
}
