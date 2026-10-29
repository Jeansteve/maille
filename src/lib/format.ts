const usdtFmt = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdtWhole = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const btcFmt = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const pxFmt = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const compactFmt = new Intl.NumberFormat("fr-FR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dayFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const stampFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function usdt(n: number, whole = false): string {
  const fmt = whole ? usdtWhole : usdtFmt;
  const sign = n < 0 ? "−" : "";
  return `${sign}${fmt.format(Math.abs(n))} USDT`;
}

export function signedUsdt(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${usdtFmt.format(Math.abs(n))} USDT`;
}

export function pctPoints(n: number, signed = false): string {
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  return `${sign}${pctFmt.format(Math.abs(n))} %`;
}

export function pctRatio(ratio: number, signed = true): string {
  return pctPoints(ratio * 100, signed);
}

export function btc(n: number): string {
  return `${btcFmt.format(n)} BTC`;
}

export function price(n: number): string {
  return pxFmt.format(n);
}

export function compactNumber(n: number): string {
  return compactFmt.format(n);
}

export function dayLabel(t: number): string {
  return dayFmt.format(t);
}

export function stampLabel(t: number): string {
  return `${stampFmt.format(t)} UTC`;
}

export function parseLoose(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!trimmed || trimmed === "." || trimmed === "-" || trimmed.endsWith(".")) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)] as T);
  return out;
}
