import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, runBacktest, type Candle, type GridParams } from "./engine.ts";

const base = (over: Partial<GridParams> = {}): GridParams => ({
  lower: 100,
  upper: 120,
  grids: 2,
  mode: "arithmetic",
  investment: 1000,
  feeRate: 0,
  stopLoss: null,
  takeProfit: null,
  trailUp: null,
  trailDown: null,
  reinvest: false,
  ...over,
});

test("OKX worked example: equal base qty at the published figure", () => {
  const plan = allocate(
    base({
      lower: 90_000,
      upper: 120_000,
      grids: 6,
      investment: 10_000,
    }),
    100_000,
  );
  assert.ok(plan);
  assert.equal(plan.market.length, 4);
  assert.equal(plan.limits.length, 2);
  assert.ok(Math.abs(plan.qty - 10_000 / 585_000) < 1e-12);
  assert.ok(Math.abs(plan.qty - 0.017094017) < 1e-8);
  const btc = plan.qty * 4;
  const usdt = 10_000 - btc * 100_000;
  assert.ok(Math.abs(btc - 0.068376) < 1e-5);
  assert.ok(Math.abs(usdt - 3162.39) < 0.02);
});

test("two-grid path buys the dip and books both cycles", () => {
  const candles: Candle[] = [
    { t: 0, o: 110, h: 110, l: 110, c: 110 },
    { t: 86_400_000, o: 110, h: 120, l: 110, c: 120 },
    { t: 172_800_000, o: 120, h: 120, l: 100, c: 100 },
    { t: 259_200_000, o: 100, h: 110, l: 100, c: 110 },
  ];
  const result = runBacktest(candles, base());
  assert.ok(!("error" in result));
  const qty = 1000 / 210;
  assert.equal(result.summary.cycles, 2);
  assert.ok(Math.abs(result.summary.gridPnl - qty * 20) < 1e-6);
  assert.ok(Math.abs(result.summary.pnl - qty * 20) < 1e-6);
  assert.ok(Math.abs(result.summary.finalBtc - qty) < 1e-8);
  assert.equal(result.summary.wins, 2);
});

test("price never enters the range and nothing is deployed", () => {
  const candles: Candle[] = [
    { t: 0, o: 50, h: 55, l: 48, c: 52 },
    { t: 1, o: 52, h: 58, l: 51, c: 57 },
    { t: 2, o: 57, h: 60, l: 54, c: 56 },
  ];
  const result = runBacktest(candles, base());
  assert.ok(!("error" in result));
  assert.equal(result.summary.cycles, 0);
  assert.equal(result.summary.activationPrice, null);
  assert.equal(result.summary.pnl, 0);
  assert.equal(result.summary.finalCash, 1000);
});

test("stop below the range liquidates and freezes the book", () => {
  const candles: Candle[] = [
    { t: 0, o: 110, h: 110, l: 110, c: 110 },
    { t: 1, o: 110, h: 112, l: 90, c: 95 },
    { t: 2, o: 95, h: 130, l: 94, c: 125 },
  ];
  const result = runBacktest(candles, base({ stopLoss: 95 }));
  assert.ok(!("error" in result));
  assert.equal(result.summary.stopped, "sl");
  assert.equal(result.summary.finalBtc, 0);
  assert.ok(result.summary.finalEquity < 1000);
  assert.equal(result.fills.filter((fill) => fill.reason === "grid" && fill.side === "sell").length, 0);
});

test("trailing up shifts the grid and the stop, and leaves the take-profit fixed", () => {
  const candles: Candle[] = [
    { t: 0, o: 110, h: 110, l: 110, c: 110 },
    { t: 1, o: 110, h: 140, l: 110, c: 135 },
  ];
  const result = runBacktest(
    candles,
    base({ trailUp: 150, stopLoss: 90, takeProfit: 160 }),
  );
  assert.ok(!("error" in result));
  assert.ok(result.summary.trailUpCount >= 1);
  assert.ok(result.summary.levels[0] > 100);
  assert.ok(result.summary.levels.at(-1)! > 120);
  assert.equal(result.summary.stopped, null);
  assert.ok(result.trails.length >= 1);
  assert.equal(result.trails[0].dir, "up");
  assert.ok(result.bands.length > 1);
});

test("trailing down extends the floor and records the extra capital", () => {
  const candles: Candle[] = [
    { t: 0, o: 110, h: 110, l: 110, c: 110 },
    { t: 1, o: 110, h: 110, l: 80, c: 85 },
  ];
  const result = runBacktest(candles, base({ trailDown: 80, investment: 1000 }));
  assert.ok(!("error" in result));
  assert.ok(result.summary.trailDownCount >= 1);
  assert.ok(result.summary.levels[0] < 100);
  assert.equal(result.summary.levels.at(-1), 120);
  assert.ok(result.summary.extraCapital > 0);
});

test("reinvest grows the order size after a profitable cycle", () => {
  const candles: Candle[] = [
    { t: 0, o: 110, h: 110, l: 110, c: 110 },
    { t: 1, o: 110, h: 120, l: 110, c: 120 },
    { t: 2, o: 120, h: 120, l: 100, c: 100 },
    { t: 3, o: 100, h: 120, l: 100, c: 120 },
  ];
  const plain = runBacktest(candles, base());
  const compound = runBacktest(candles, base({ reinvest: true }));
  assert.ok(!("error" in plain) && !("error" in compound));
  assert.ok(compound.summary.reinvested > 0);
  assert.ok(compound.summary.qty > plain.summary.qty);
  assert.ok(compound.summary.gridPnl > plain.summary.gridPnl);
});

test("fees can make a tight grid cycle negative", () => {
  const candles: Candle[] = [
    { t: 0, o: 100, h: 100, l: 100, c: 100 },
    { t: 1, o: 100, h: 101, l: 99, c: 100 },
  ];
  const result = runBacktest(
    candles,
    base({
      lower: 99,
      upper: 101,
      grids: 2,
      feeRate: 0.01,
    }),
  );
  assert.ok(!("error" in result));
  assert.ok(result.summary.fees > 0);
});
