// Spot grid backtest aligned with OKX's quote-investment model:
// equal base size per grid, limits below the entry, market buys for grids
// whose floor is already at or above the entry (filled at the market).

export type GridMode = "arithmetic" | "geometric";

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type GridParams = {
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  investment: number;
  feeRate: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Price cap. The whole grid may shift up until the upper limit reaches it. */
  trailUp: number | null;
  /** Price floor. The grid may extend down until the lower limit reaches it. */
  trailDown: number | null;
  /** Add each positive cycle profit back into the order size. */
  reinvest: boolean;
};

export type FillReason = "init" | "grid" | "sl" | "tp" | "trail";

export type Fill = {
  t: number;
  side: "buy" | "sell";
  price: number;
  qty: number;
  quote: number;
  feeQuote: number;
  grid: number;
  cyclePnl: number | null;
  /** Quote spent on the buy matched to this sell. */
  basis: number | null;
  reason: FillReason;
};

export type EquityPoint = {
  t: number;
  equity: number;
  hold: number;
  price: number;
  cash: number;
  btc: number;
  lower: number;
  upper: number;
};

export type TrailMark = {
  t: number;
  dir: "up" | "down";
  lower: number;
  upper: number;
  price: number;
};

export type GridBand = {
  t: number;
  levels: number[];
};

export type BacktestSummary = {
  investment: number;
  finalEquity: number;
  pnl: number;
  roi: number;
  holdEquity: number;
  holdPnl: number;
  holdRoi: number;
  alpha: number;
  gridPnl: number;
  exitPnl: number;
  unrealizedPnl: number;
  fees: number;
  cycles: number;
  wins: number;
  buys: number;
  sells: number;
  maxDrawdown: number;
  maxDrawdownUsdt: number;
  inRangePct: number;
  avgExposure: number;
  days: number;
  apr: number | null;
  qty: number;
  activationPrice: number | null;
  activationTime: number | null;
  endTime: number | null;
  stopped: "sl" | "tp" | null;
  finalCash: number;
  finalBtc: number;
  minGridReturn: number;
  maxGridReturn: number;
  openSlots: number;
  levels: number[];
  trailUpCount: number;
  trailDownCount: number;
  extraCapital: number;
  reinvested: number;
};

export type BacktestResult = {
  fills: Fill[];
  equity: EquityPoint[];
  trails: TrailMark[];
  bands: GridBand[];
  summary: BacktestSummary;
};

export function validateParams(p: GridParams): string | null {
  if (!(p.lower > 0)) return "Le prix bas doit être positif.";
  if (!(p.upper > p.lower)) return "Le prix haut doit être au-dessus du prix bas.";
  if (!Number.isInteger(p.grids) || p.grids < 2 || p.grids > 120) {
    return "Le nombre de grilles doit être un entier entre 2 et 120.";
  }
  if (!(p.investment > 0)) return "Le capital doit être positif.";
  if (!(p.feeRate >= 0 && p.feeRate < 0.05)) return "Les frais doivent être entre 0 % et 5 %.";
  if (p.stopLoss != null && !(p.stopLoss > 0 && p.stopLoss < p.lower)) {
    return "Le stop doit être un prix positif, sous le bas de la grille.";
  }
  if (p.takeProfit != null && !(p.takeProfit > p.upper)) {
    return "L'objectif doit être au-dessus du haut de la grille.";
  }
  if (p.stopLoss != null && p.takeProfit != null && p.stopLoss >= p.takeProfit) {
    return "Le stop doit rester sous l'objectif.";
  }
  if (p.trailUp != null && !(p.trailUp > p.upper)) {
    return "Le plafond du trailing haut doit être au-dessus du haut de grille.";
  }
  if (p.trailDown != null && !(p.trailDown > 0 && p.trailDown < p.lower)) {
    return "Le plancher du trailing bas doit être sous le bas de grille.";
  }
  return null;
}

export function buildLevels(lower: number, upper: number, grids: number, mode: GridMode): number[] {
  const levels = new Array<number>(grids + 1);
  if (mode === "arithmetic") {
    const step = (upper - lower) / grids;
    for (let i = 0; i <= grids; i++) levels[i] = lower + step * i;
  } else {
    const ratio = Math.pow(upper / lower, 1 / grids);
    for (let i = 0; i <= grids; i++) levels[i] = lower * Math.pow(ratio, i);
  }
  levels[0] = lower;
  levels[grids] = upper;
  return levels;
}

export function gridReturns(levels: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < levels.length - 1; i++) {
    const span = (levels[i + 1] - levels[i]) / levels[i];
    if (span < min) min = span;
    if (span > max) max = span;
  }
  if (!Number.isFinite(min)) min = 0;
  return { min, max };
}

/** Round-trip fee hurdle: sell must clear buy after base fee and quote fee. */
export function feeHurdle(feeRate: number): number {
  const kept = 1 - feeRate;
  if (!(kept > 0)) return Infinity;
  return 1 / (kept * kept) - 1;
}

export function nicePrice(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return p;
  const step = p >= 20000 ? 100 : p >= 5000 ? 50 : p >= 1000 ? 10 : p >= 100 ? 1 : 0.1;
  return Math.round(p / step) * step;
}

export function suggestGridCount(lower: number, upper: number, feeRate: number): number {
  const mid = (lower + upper) / 2;
  if (!(mid > 0) || !(upper > lower)) return 16;
  const target = Math.max(feeRate * 6, 0.005);
  const count = Math.round((upper - lower) / mid / target);
  return Math.min(80, Math.max(6, count));
}

export function suggestRange(
  candles: Candle[],
  mode: "wide" | "balanced" | "tight",
  lastPrice: number,
): { lower: number; upper: number } {
  const closes = candles.map((c) => c.c).sort((a, b) => a - b);
  const quantile = (p: number) => closes[Math.round((closes.length - 1) * p)] ?? lastPrice;
  let lo: number;
  let hi: number;
  if (mode === "tight") {
    lo = lastPrice * 0.94;
    hi = lastPrice * 1.06;
  } else if (mode === "wide") {
    lo = Math.min(...candles.map((c) => c.l));
    hi = Math.max(...candles.map((c) => c.h));
    const pad = (hi - lo) * 0.02;
    lo -= pad;
    hi += pad;
  } else {
    lo = quantile(0.08);
    hi = quantile(0.92);
  }
  if (!(hi > lo * 1.005)) {
    lo = lastPrice * 0.9;
    hi = lastPrice * 1.1;
  }
  let lower = nicePrice(lo);
  let upper = nicePrice(hi);
  if (!(upper > lower)) upper = nicePrice(lower * 1.08);
  if (!(upper > lower)) upper = lower + 1;
  return { lower, upper };
}

export type Allocation = {
  levels: number[];
  qty: number;
  market: number[];
  limits: number[];
  entryPrice: number;
  entry: "inside" | "below" | "above";
  minReturn: number;
  maxReturn: number;
};

/**
 * Equal base qty that spends the quote investment exactly:
 * market grids cost `qty * entryPrice`, limit grids reserve `qty * level`.
 * Mirrors the OKX worked example (10 000 USDC, 90–120k, 6 grids, price 100k → 0.01709 BTC).
 */
export function allocate(params: GridParams, price: number): Allocation | null {
  const { lower, upper, grids, mode } = params;
  if (!(lower > 0) || !(upper > lower) || grids < 2 || !(params.investment > 0)) return null;
  const levels = buildLevels(lower, upper, grids, mode);
  let entry: Allocation["entry"] = "inside";
  let entryPrice = price;
  if (price < lower) {
    entry = "below";
    entryPrice = lower;
  } else if (price >= upper) {
    entry = "above";
    entryPrice = upper;
  }
  const market: number[] = [];
  const limits: number[] = [];
  for (let i = 0; i < grids; i++) {
    if (levels[i] >= entryPrice) market.push(i);
    else limits.push(i);
  }
  let denom = entryPrice * market.length;
  for (const i of limits) denom += levels[i];
  if (!(denom > 0)) return null;
  const returns = gridReturns(levels);
  return {
    levels,
    qty: params.investment / denom,
    market,
    limits,
    entryPrice,
    entry,
    minReturn: returns.min,
    maxReturn: returns.max,
  };
}

type Slot = {
  side: "buy" | "sell";
  entryPrice: number;
  entryQuote: number;
  baseQty: number;
};

export function runBacktest(candles: Candle[], params: GridParams): BacktestResult | { error: string } {
  const problem = validateParams(params);
  if (problem) return { error: problem };
  if (candles.length < 2) return { error: "Pas assez de bougies pour simuler." };

  const { investment, feeRate } = params;
  let grids = params.grids;
  let lower = params.lower;
  let upper = params.upper;
  let stopLoss = params.stopLoss;
  const takeProfit = params.takeProfit;
  let trailUpCap = params.trailUp;
  let trailDownFloor = params.trailDown;
  const arithStep = (params.upper - params.lower) / params.grids;
  const geoRatio = Math.pow(params.upper / params.lower, 1 / params.grids);
  const planAt = (price: number) => allocate(params, price);
  const seed = planAt((lower + upper) / 2);
  if (!seed) return { error: "Grille impossible à construire." };
  const levels = seed.levels;

  const slots: Slot[] = Array.from({ length: grids }, () => ({
    side: "buy" as const,
    entryPrice: 0,
    entryQuote: 0,
    baseQty: 0,
  }));

  let cash = investment;
  let btc = 0;
  let fees = 0;
  let active = false;
  let stopped: "sl" | "tp" | null = null;
  let activationPrice: number | null = null;
  let activationTime: number | null = null;
  let holdQty = 0;
  let gridPnl = 0;
  let exitPnl = 0;
  let cycles = 0;
  let wins = 0;
  let buyCount = 0;
  let sellCount = 0;
  let extraCapital = 0;
  let trailUpCount = 0;
  let trailDownCount = 0;
  let reinvested = 0;
  const fills: Fill[] = [];
  const trails: TrailMark[] = [];
  const bands: GridBand[] = [{ t: candles[0].t, levels: [...seed.levels] }];
  const equity: EquityPoint[] = [];
  let qty = 0;

  const buy = (grid: number, price: number, t: number, reason: FillReason) => {
    const gross = qty;
    const cost = gross * price;
    if (!(cash + 1e-8 >= cost)) {
      const affordable = cash / price;
      if (!(affordable > qty * 0.5)) return;
    }
    const pay = Math.min(cash, cost);
    const filled = pay / price;
    const feeBase = filled * feeRate;
    const received = filled - feeBase;
    cash -= pay;
    btc += received;
    const feeQuote = feeBase * price;
    fees += feeQuote;
    slots[grid] = { side: "sell", entryPrice: price, entryQuote: pay, baseQty: received };
    buyCount += 1;
    fills.push({
      t,
      side: "buy",
      price,
      qty: filled,
      quote: pay,
      feeQuote,
      grid,
      cyclePnl: null,
      basis: null,
      reason,
    });
  };

  const sellSlot = (grid: number, price: number, t: number) => {
    const slot = slots[grid];
    if (slot.side !== "sell" || !(slot.baseQty > 0)) return;
    const sellQty = slot.baseQty;
    const gross = sellQty * price;
    const feeQuote = gross * feeRate;
    const proceeds = gross - feeQuote;
    cash += proceeds;
    btc -= sellQty;
    fees += feeQuote;
    const cyclePnl = proceeds - slot.entryQuote;
    gridPnl += cyclePnl;
    cycles += 1;
    if (cyclePnl > 0) wins += 1;
    sellCount += 1;
    fills.push({
      t,
      side: "sell",
      price,
      qty: sellQty,
      quote: proceeds,
      feeQuote,
      grid,
      cyclePnl,
      basis: slot.entryQuote,
      reason: "grid",
    });
    slots[grid] = { side: "buy", entryPrice: 0, entryQuote: 0, baseQty: 0 };
    compound(cyclePnl, price);
  };

  const compound = (pnl: number, at: number) => {
    if (!params.reinvest || !(pnl > 0) || !(at > 0) || !(grids > 0)) return;
    qty += pnl / (grids * at);
    reinvested += pnl;
  };

  const liquidate = (price: number, t: number, why: "sl" | "tp") => {
    let basis = 0;
    for (const slot of slots) {
      if (slot.side === "sell") basis += slot.entryQuote;
    }
    if (btc > 1e-12) {
      const gross = btc * price;
      const feeQuote = gross * feeRate;
      const proceeds = gross - feeQuote;
      cash += proceeds;
      fees += feeQuote;
      exitPnl += proceeds - basis;
      btc = 0;
      fills.push({
        t,
        side: "sell",
        price,
        qty: proceeds / price,
        quote: proceeds,
        feeQuote,
        grid: -1,
        cyclePnl: proceeds - basis,
        basis,
        reason: why,
      });
    }
    for (let i = 0; i < slots.length; i++) {
      slots[i] = { side: "buy", entryPrice: 0, entryQuote: 0, baseQty: 0 };
    }
    stopped = why;
  };

  const activate = (price: number, t: number) => {
    const plan = planAt(price);
    if (!plan) return;
    qty = plan.qty;
    active = true;
    activationPrice = plan.entryPrice;
    activationTime = t;
    holdQty = (investment / plan.entryPrice) * (1 - feeRate);
    for (const grid of plan.market) buy(grid, plan.entryPrice, t, "init");
  };

  const cross = (from: number, to: number, t: number) => {
    if (stopped || !(qty > 0) || to === from) return;
    if (to > from) {
      const events: { px: number; kind: "sell" | "tp"; grid: number }[] = [];
      for (let i = 0; i < grids; i++) {
        if (slots[i].side !== "sell") continue;
        const px = levels[i + 1];
        if (px > from && px <= to) events.push({ px, kind: "sell", grid: i });
      }
      if (takeProfit != null && takeProfit > from && takeProfit <= to) {
        events.push({ px: takeProfit, kind: "tp", grid: -1 });
      }
      events.sort((a, b) => a.px - b.px || (a.kind === "tp" ? 1 : -1));
      for (const event of events) {
        if (stopped) return;
        if (event.kind === "tp") liquidate(event.px, t, "tp");
        else sellSlot(event.grid, event.px, t);
      }
      return;
    }
    const events: { px: number; kind: "buy" | "sl"; grid: number }[] = [];
    for (let i = 0; i < grids; i++) {
      if (slots[i].side !== "buy") continue;
      const px = levels[i];
      if (px < from && px >= to) events.push({ px, kind: "buy", grid: i });
    }
    if (stopLoss != null && stopLoss < from && stopLoss >= to) {
      events.push({ px: stopLoss, kind: "sl", grid: -1 });
    }
    events.sort((a, b) => b.px - a.px || (a.kind === "sl" ? 1 : -1));
    for (const event of events) {
      if (stopped) return;
      if (event.kind === "sl") liquidate(event.px, t, "sl");
      else buy(event.grid, event.px, t, "grid");
    }
  };

  const enterPrice = (a: number, b: number): number | null => {
    if (a >= lower && a < upper) return a;
    if (a < lower && b > a && b >= lower) return lower;
    if (a >= upper && b < a && b < upper) return upper;
    return null;
  };

  const closeDropped = (slot: Slot, price: number, t: number) => {
    if (slot.side !== "sell" || !(slot.baseQty > 0)) return;
    const gross = slot.baseQty * price;
    const feeQuote = gross * feeRate;
    const proceeds = gross - feeQuote;
    cash += proceeds;
    btc -= slot.baseQty;
    fees += feeQuote;
    const cyclePnl = proceeds - slot.entryQuote;
    gridPnl += cyclePnl;
    cycles += 1;
    if (cyclePnl > 0) wins += 1;
    sellCount += 1;
    fills.push({
      t,
      side: "sell",
      price,
      qty: slot.baseQty,
      quote: proceeds,
      feeQuote,
      grid: -1,
      cyclePnl,
      basis: slot.entryQuote,
      reason: "trail",
    });
    compound(cyclePnl, price);
  };

  /** OKX trailing up: drop the bottom buy, shift every level up one spacing, buy the new top. */
  const shiftUp = (price: number, t: number): boolean => {
    if (trailUpCap == null || !(qty > 0)) return false;
    const nextUpper = params.mode === "arithmetic" ? upper + arithStep : upper * geoRatio;
    if (!(nextUpper > upper) || nextUpper > trailUpCap + 1e-8) return false;
    const dropped = slots[0];
    const freed =
      dropped && dropped.side === "sell" && dropped.baseQty > 0
        ? dropped.baseQty * price * (1 - feeRate)
        : 0;
    if (!(cash + freed + 1e-8 >= qty * price)) return false;
    slots.shift();
    if (dropped) closeDropped(dropped, price, t);
    if (params.mode === "arithmetic") {
      for (let i = 0; i < levels.length; i++) levels[i] += arithStep;
    } else {
      for (let i = 0; i < levels.length; i++) levels[i] *= geoRatio;
    }
    lower = levels[0];
    upper = levels[levels.length - 1];
    slots.push({ side: "buy", entryPrice: 0, entryQuote: 0, baseQty: 0 });
    buy(slots.length - 1, price, t, "trail");
    if (stopLoss != null) {
      stopLoss = params.mode === "arithmetic" ? stopLoss + arithStep : stopLoss * geoRatio;
    }
    if (trailDownFloor != null) {
      trailDownFloor = params.mode === "arithmetic" ? trailDownFloor + arithStep : trailDownFloor * geoRatio;
      if (!(trailDownFloor < lower)) trailDownFloor = null;
    }
    trailUpCount += 1;
    const snap = [...levels];
    bands.push({ t, levels: snap });
    trails.push({ t, dir: "up", lower: snap[0], upper: snap[snap.length - 1], price });
    return true;
  };

  /** OKX trailing down: extend the floor by one spacing. Upper limit stays. Extra quote is funded and counted. */
  const extendDown = (t: number): boolean => {
    if (trailDownFloor == null || !(qty > 0) || grids >= 200) return false;
    const nextLower = params.mode === "arithmetic" ? lower - arithStep : lower / geoRatio;
    if (!(nextLower > 0) || !(nextLower < lower) || nextLower + 1e-8 < trailDownFloor) return false;
    if (stopLoss != null && nextLower <= stopLoss) return false;
    const cost = qty * nextLower;
    if (!(cash + 1e-8 >= cost)) {
      const need = cost - cash;
      extraCapital += need;
      cash += need;
    }
    levels.unshift(nextLower);
    lower = nextLower;
    grids += 1;
    slots.unshift({ side: "buy", entryPrice: 0, entryQuote: 0, baseQty: 0 });
    buy(0, nextLower, t, "trail");
    trailDownCount += 1;
    const snap = [...levels];
    bands.push({ t, levels: snap });
    trails.push({ t, dir: "down", lower: snap[0], upper: snap[snap.length - 1], price: nextLower });
    return true;
  };

  const trailUpAlong = (b: number, t: number) => {
    let guard = 0;
    while (!stopped && trailUpCap != null && b >= upper && guard < 80) {
      guard += 1;
      const at = upper;
      if (!shiftUp(at, t)) break;
      const top = slots.length - 1;
      if (b >= upper && slots[top]?.side === "sell") sellSlot(top, upper, t);
    }
  };

  const trailDownAlong = (b: number, t: number) => {
    let guard = 0;
    while (!stopped && trailDownFloor != null && b <= lower && guard < 80) {
      guard += 1;
      if (!extendDown(t)) break;
    }
  };

  const move = (a: number, b: number, t: number) => {
    if (stopped || !(qty > 0) || a === b) return;
    if (b > a) {
      const cap = Math.min(b, upper);
      if (cap > a) cross(a, cap, t);
      if (!stopped && b >= upper) trailUpAlong(b, t);
      if (!stopped && takeProfit != null && b >= takeProfit) liquidate(takeProfit, t, "tp");
      return;
    }
    const floor = Math.max(b, lower);
    if (floor < a) cross(a, floor, t);
    if (!stopped && b <= lower) trailDownAlong(b, t);
    if (!stopped && stopLoss != null && b <= stopLoss) liquidate(stopLoss, t, "sl");
  };

  let cursor = candles[0].o;
  let inRange = 0;
  let activeBars = 0;
  let exposureSum = 0;

  for (const candle of candles) {
    const bullish = candle.c >= candle.o;
    const path = bullish
      ? [candle.o, candle.l, candle.h, candle.c]
      : [candle.o, candle.h, candle.l, candle.c];
    const seq = [cursor];
    for (const point of path) {
      if (point !== seq[seq.length - 1]) seq.push(point);
    }

    if (!active && !stopped && seq.length === 1) {
      const only = seq[0];
      if (only >= lower && only < upper) activate(only, candle.t);
      else if (only === upper) activate(upper, candle.t);
    }

    for (let s = 0; s < seq.length - 1; s++) {
      const a = seq[s];
      const b = seq[s + 1];
      if (stopped) break;
      if (!active) {
        const entry = enterPrice(a, b);
        if (entry == null) continue;
        activate(entry, candle.t);
        if (entry !== b) move(entry, b, candle.t);
      } else {
        move(a, b, candle.t);
      }
    }

    cursor = candle.c;
    const price = candle.c;
    const eq = active ? cash + btc * price - extraCapital : investment;
    const hold = active && activationPrice ? holdQty * price : investment;
    equity.push({
      t: candle.t,
      equity: eq,
      hold,
      price,
      cash: active ? cash : investment,
      btc,
      lower,
      upper,
    });
    if (active) {
      activeBars += 1;
      if (price >= lower && price <= upper) inRange += 1;
      if (eq > 0) exposureSum += (btc * price) / eq;
    }
  }

  const last = equity[equity.length - 1];
  const finalEquity = last?.equity ?? investment;
  const holdEquity = last?.hold ?? investment;
  const pnl = finalEquity - investment;
  const holdPnl = holdEquity - investment;
  const openSlots = slots.filter((slot) => slot.side === "sell").length;
  let peak = investment;
  let maxDrawdownUsdt = 0;
  let maxDrawdown = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    const drop = peak - point.equity;
    if (drop > maxDrawdownUsdt) {
      maxDrawdownUsdt = drop;
      maxDrawdown = peak > 0 ? drop / peak : 0;
    }
  }
  const days =
    activationTime != null && last
      ? Math.max(0, (last.t - activationTime) / 86_400_000)
      : 0;
  const roi = pnl / investment;
  const returns = gridReturns(levels);

  return {
    fills,
    equity,
    trails,
    bands,
    summary: {
      investment,
      finalEquity,
      pnl,
      roi,
      holdEquity,
      holdPnl,
      holdRoi: holdPnl / investment,
      alpha: pnl - holdPnl,
      gridPnl,
      exitPnl,
      unrealizedPnl: pnl - gridPnl - exitPnl,
      fees,
      cycles,
      wins,
      buys: buyCount,
      sells: sellCount,
      maxDrawdown,
      maxDrawdownUsdt,
      inRangePct: activeBars > 0 ? inRange / activeBars : 0,
      avgExposure: activeBars > 0 ? exposureSum / activeBars : 0,
      days,
      apr: days >= 1 ? roi * (365 / days) : null,
      qty,
      activationPrice,
      activationTime,
      endTime: last?.t ?? null,
      stopped,
      finalCash: active ? cash : investment,
      finalBtc: btc,
      minGridReturn: returns.min,
      maxGridReturn: returns.max,
      openSlots,
      levels: [...levels],
      trailUpCount,
      trailDownCount,
      extraCapital,
      reinvested,
    },
  };
}

export type GridProposal = {
  id: string;
  name: string;
  note: string;
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  trailUp: number | null;
  trailDown: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reinvest: boolean;
};

/** Rules anchored on the entry price only — the range does not look at later prices. */
export function proposeGrids(entry: number): GridProposal[] {
  if (!(entry > 0)) return [];
  const px = (factor: number) => nicePrice(entry * factor);
  const zone = (down: number, up: number) => ({ lower: px(1 - down), upper: px(1 + up) });
  const tight = zone(0.08, 0.08);
  const mid = zone(0.15, 0.18);
  const wide = zone(0.28, 0.35);
  return [
    {
      id: "tight",
      name: "Serré au départ",
      note: "±8 % autour du premier cours. Sans trailing.",
      ...tight,
      grids: 24,
      mode: "arithmetic",
      trailUp: null,
      trailDown: null,
      stopLoss: null,
      takeProfit: null,
      reinvest: false,
    },
    {
      id: "balanced",
      name: "Équilibré au départ",
      note: "−15 % / +18 %. Posable le premier jour, sans connaître la suite.",
      ...mid,
      grids: 16,
      mode: "arithmetic",
      trailUp: null,
      trailDown: null,
      stopLoss: null,
      takeProfit: null,
      reinvest: false,
    },
    {
      id: "wide",
      name: "Large au départ",
      note: "−28 % / +35 %, écart géométrique.",
      ...wide,
      grids: 12,
      mode: "geometric",
      trailUp: null,
      trailDown: null,
      stopLoss: null,
      takeProfit: null,
      reinvest: false,
    },
    {
      id: "trail-up",
      name: "Suit la hausse",
      note: "Même départ équilibré, plafond à 3× le premier cours. Le stop monte avec la grille.",
      ...mid,
      grids: 16,
      mode: "arithmetic",
      trailUp: px(3),
      trailDown: null,
      stopLoss: px(0.7),
      takeProfit: null,
      reinvest: false,
    },
    {
      id: "both",
      name: "Suit les deux sens",
      note: "Plafond 2,5×, plancher 0,45×. Le capital ajouté en bas est compté.",
      lower: px(0.8),
      upper: px(1.25),
      grids: 14,
      mode: "arithmetic",
      trailUp: px(2.5),
      trailDown: px(0.45),
      stopLoss: null,
      takeProfit: null,
      reinvest: false,
    },
    {
      id: "compound",
      name: "Profits réinvestis",
      note: "Zone équilibrée, plafond 2,2×. Chaque gain augmente la taille des ordres.",
      ...mid,
      grids: 16,
      mode: "arithmetic",
      trailUp: px(2.2),
      trailDown: null,
      stopLoss: null,
      takeProfit: null,
      reinvest: true,
    },
  ];
}
