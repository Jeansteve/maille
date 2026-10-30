import { createServerFn } from "@tanstack/react-start";
import type { Candle } from "@/lib/grid/engine";

const BARS = ["15m", "1H", "4H", "1D"] as const;
export type OkxBar = (typeof BARS)[number];

export type CandlePack = {
  instId: "BTC-USDT";
  bar: OkxBar;
  candles: Candle[];
  requested: number;
};

const cache = new Map<string, { at: number; pack: CandlePack }>();
const CACHE_MS = 60_000;

type RawCandle = Candle & { confirm: boolean };

function parseRow(row: string[]): RawCandle | null {
  const t = Number(row[0]);
  const o = Number(row[1]);
  const h = Number(row[2]);
  const l = Number(row[3]);
  const c = Number(row[4]);
  if (![t, o, h, l, c].every((n) => Number.isFinite(n)) || h < l) return null;
  return { t, o, h, l, c, confirm: row[8] !== "0" };
}

async function okxRows(url: string): Promise<string[][]> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 MailleBacktest" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Impossible de joindre OKX. Réessayez dans un instant.");
  }
  if (!res.ok) throw new Error(`OKX a répondu ${res.status}.`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: string[][] };
  if (body.code !== "0") throw new Error(body.msg || "Réponse OKX invalide.");
  return body.data ?? [];
}

async function loadCandles(bar: OkxBar, limit: number): Promise<Candle[]> {
  const want = limit + 1;
  const collected: RawCandle[] = [];
  const recent = await okxRows(
    `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${encodeURIComponent(bar)}&limit=${Math.min(300, want)}`,
  );
  for (const row of recent) {
    const candle = parseRow(row);
    if (candle) collected.push(candle);
  }

  let guard = 0;
  while (collected.length < want && guard < 130) {
    guard += 1;
    const oldest = collected[collected.length - 1];
    if (!oldest) break;
    const batch = Math.min(100, want - collected.length);
    const rows = await okxRows(
      `https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=${encodeURIComponent(bar)}&limit=${batch}&after=${oldest.t}`,
    );
    if (!rows.length) break;
    const sizeBefore = collected.length;
    for (const row of rows) {
      const candle = parseRow(row);
      if (candle && candle.t < oldest.t) collected.push(candle);
    }
    if (collected.length === sizeBefore) break;
  }

  const unique = new Map<number, Candle>();
  for (const candle of collected) {
    unique.set(candle.t, { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
  }
  const candles = [...unique.values()].sort((a, b) => a.t - b.t);
  const newest = recent[0] ? parseRow(recent[0]) : null;
  if (newest && !newest.confirm && candles.at(-1)?.t === newest.t) candles.pop();
  if (candles.length > limit) candles.splice(0, candles.length - limit);
  return candles;
}

export const fetchOkxCandles = createServerFn({ method: "GET" })
  .validator((input: { bar: OkxBar; limit: number }) => {
    if (!input || !BARS.includes(input.bar)) throw new Error("Unité de temps invalide.");
    const limit = Math.floor(Number(input.limit));
    if (!Number.isFinite(limit)) throw new Error("Période invalide.");
    return { bar: input.bar, limit: Math.max(80, Math.min(10_000, limit)) };
  })
  .handler(async ({ data }): Promise<CandlePack> => {
    const key = `${data.bar}:${data.limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.pack;
    const candles = await loadCandles(data.bar, data.limit);
    if (candles.length < 2) throw new Error("OKX n'a pas renvoyé assez de bougies.");
    const pack: CandlePack = {
      instId: "BTC-USDT",
      bar: data.bar,
      candles,
      requested: data.limit,
    };
    cache.set(key, { at: Date.now(), pack });
    return pack;
  });
