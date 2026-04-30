import { promises as fs } from "fs";
import path from "path";

export interface State {
  lastSeen: Record<string, number>;
  seenTrades: Record<string, number>;
  dailyVolume: {
    day: string;
    spentUsd: number;
  };
  redeemAttempts: Record<string, number>;
}

const defaultState = (): State => ({
  lastSeen: {},
  seenTrades: {},
  dailyVolume: {
    day: "",
    spentUsd: 0,
  },
  redeemAttempts: {},
});

// ✅ 关键修复：统一路径（避免 /data 报错）
const normalizePath = (p: string): string => {
  if (!p) return path.join(process.cwd(), "data/processed_conditions.json");

  // 如果是绝对路径（/data/...），转为当前目录
  if (path.isAbsolute(p)) {
    return path.join(process.cwd(), p.replace(/^\/+/, ""));
  }

  return p;
};

const dayKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ✅ 加强版 load（不会再 ENOENT / JSON 崩）
export const loadState = async (filePath: string): Promise<State> => {
  filePath = normalizePath(filePath);

  try {
    const raw = await fs.readFile(filePath, "utf-8");

    try {
      const parsed = JSON.parse(raw) as State;

      return {
        ...defaultState(),
        ...parsed,
        lastSeen: parsed.lastSeen ?? {},
        seenTrades: parsed.seenTrades ?? {},
        dailyVolume: parsed.dailyVolume ?? { day: "", spentUsd: 0 },
        redeemAttempts: parsed.redeemAttempts ?? {},
      };
    } catch {
      // JSON 损坏
      return defaultState();
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;

    if (e.code === "ENOENT") {
      // ✅ 文件不存在 → 自动创建
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(defaultState(), null, 2));
      return defaultState();
    }

    throw err;
  }
};

// ✅ 保存前保证目录存在
export const saveState = async (filePath: string, state: State): Promise<void> => {
  filePath = normalizePath(filePath);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
};

// ✅ 每日重置
export const ensureDailyVolume = (state: State, now = new Date()): void => {
  const key = dayKeyUtc(now);
  if (state.dailyVolume.day !== key) {
    state.dailyVolume.day = key;
    state.dailyVolume.spentUsd = 0;
  }
};

// ✅ 标记已处理交易
export const noteSeenTrade = (
  state: State,
  tradeKey: string,
  timestamp: number
): void => {
  state.seenTrades[tradeKey] = timestamp;
};

// ✅ 清理过期交易
export const pruneSeenTrades = (state: State, maxAgeSec: number): void => {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;

  for (const [key, ts] of Object.entries(state.seenTrades)) {
    if (ts < cutoff) delete state.seenTrades[key];
  }
};

// ✅ 标记 redeem
export const markRedeemAttempt = (
  state: State,
  conditionId: string
): void => {
  state.redeemAttempts[conditionId] = Math.floor(Date.now() / 1000);
};
