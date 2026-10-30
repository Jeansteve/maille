import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  allocate,
  feeHurdle,
  runBacktest,
  suggestGridCount,
  suggestRange,
  validateParams,
  proposeGrids,
  type BacktestResult,
  type BacktestSummary,
  type Fill,
  type GridMode,
  type GridParams,
} from "@/lib/grid/engine";
import {
  btc,
  compactNumber,
  dayLabel,
  downsample,
  parseLoose,
  pctPoints,
  pctRatio,
  price,
  signedUsdt,
  stampLabel,
  usdt,
} from "@/lib/format";
import { fetchOkxCandles, type CandlePack, type OkxBar } from "@/lib/okx";

const STORAGE_KEY = "maille-grid-v2";

const SPANS: Record<OkxBar, { days: number; label: string }[]> = {
  "15m": [
    { days: 7, label: "7 j" },
    { days: 14, label: "14 j" },
    { days: 30, label: "30 j" },
    { days: 90, label: "90 j" },
  ],
  "1H": [
    { days: 30, label: "30 j" },
    { days: 90, label: "90 j" },
    { days: 180, label: "6 mois" },
    { days: 365, label: "1 an" },
  ],
  "4H": [
    { days: 180, label: "6 mois" },
    { days: 365, label: "1 an" },
    { days: 730, label: "2 ans" },
    { days: 1460, label: "4 ans" },
  ],
  "1D": [
    { days: 730, label: "2 ans" },
    { days: 1460, label: "4 ans" },
    { days: 2190, label: "6 ans" },
    { days: 3400, label: "9 ans" },
  ],
};

const BAR_LABEL: Record<OkxBar, string> = {
  "15m": "15 min",
  "1H": "1 h",
  "4H": "4 h",
  "1D": "1 j",
};

const BAR_MS: Record<OkxBar, number> = {
  "15m": 900_000,
  "1H": 3_600_000,
  "4H": 14_400_000,
  "1D": 86_400_000,
};

type Fit = "wide" | "balanced" | "tight" | "custom";

type Params = {
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  investment: number;
  feePct: number;
  stopLoss: number | null;
  takeProfit: number | null;
  trailUp: number | null;
  trailDown: number | null;
  reinvest: boolean;
};

type Spec = { bar: OkxBar; days: number };

type AppliedGrid = Pick<
  Params,
  "lower" | "upper" | "grids" | "mode" | "trailUp" | "trailDown" | "stopLoss" | "takeProfit" | "reinvest"
>;

const DEFAULT_PARAMS: Params = {
  lower: 70_000,
  upper: 90_000,
  grids: 20,
  mode: "arithmetic",
  investment: 10_000,
  feePct: 0.08,
  stopLoss: null,
  takeProfit: null,
  trailUp: null,
  trailDown: null,
  reinvest: false,
};

const DEFAULT_SPEC: Spec = { bar: "1D", days: 1460 };

function limitFor(spec: Spec): number {
  return Math.max(80, Math.min(10_000, Math.round((spec.days * 86_400_000) / BAR_MS[spec.bar])));
}

function normalizeSpec(spec: Spec): Spec {
  const options = SPANS[spec.bar];
  if (options.some((option) => option.days === spec.days)) return spec;
  const nearest = options.reduce((best, option) =>
    Math.abs(option.days - spec.days) < Math.abs(best.days - spec.days) ? option : best,
  );
  return { bar: spec.bar, days: nearest.days };
}

function toGrid(params: Params): GridParams {
  return {
    lower: params.lower,
    upper: params.upper,
    grids: params.grids,
    mode: params.mode,
    investment: params.investment,
    feeRate: params.feePct / 100,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    trailUp: params.trailUp,
    trailDown: params.trailDown,
    reinvest: params.reinvest,
  };
}

function sanitizeParams(input: unknown): Params | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<Params>;
  const params: Params = {
    lower: Number(raw.lower),
    upper: Number(raw.upper),
    grids: Math.round(Number(raw.grids)),
    mode: raw.mode === "geometric" ? "geometric" : "arithmetic",
    investment: Number(raw.investment),
    feePct: Number(raw.feePct),
    stopLoss: raw.stopLoss == null ? null : Number(raw.stopLoss),
    takeProfit: raw.takeProfit == null ? null : Number(raw.takeProfit),
    trailUp: raw.trailUp == null ? null : Number(raw.trailUp),
    trailDown: raw.trailDown == null ? null : Number(raw.trailDown),
    reinvest: raw.reinvest === true,
  };
  return validateParams(toGrid(params)) ? null : params;
}

function sanitizeSpec(input: unknown): Spec | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<Spec>;
  if (raw.bar !== "15m" && raw.bar !== "1H" && raw.bar !== "4H" && raw.bar !== "1D") return null;
  const days = Number(raw.days);
  if (!Number.isFinite(days)) return null;
  return normalizeSpec({ bar: raw.bar, days });
}

function toneOf(n: number): "up" | "down" | undefined {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return undefined;
}

function entryPriceOf(fill: Fill, feeRate: number): number | null {
  if (fill.basis == null || !(fill.qty > 0)) return null;
  return (fill.basis * (1 - feeRate)) / fill.qty;
}

export function MailleApp() {
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [spec, setSpec] = useState<Spec>(DEFAULT_SPEC);
  const [fit, setFit] = useState<Fit>("balanced");
  const [pack, setPack] = useState<CandlePack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const skipPersist = useRef(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { params?: unknown; spec?: unknown };
      const nextParams = sanitizeParams(saved.params);
      const nextSpec = sanitizeSpec(saved.spec);
      if (!nextParams || !nextSpec) return;
      setParams(nextParams);
      setSpec(nextSpec);
      setFit("custom");
    } catch {
      /* ignore broken local settings */
    }
  }, []);

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ params, spec }));
  }, [params, spec]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOkxCandles({ data: { bar: spec.bar, limit: limitFor(spec) } })
      .then((next) => {
        if (!cancelled) setPack(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Impossible de joindre OKX.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spec.bar, spec.days, reloadKey]);

  useEffect(() => {
    if (!pack || fit === "custom") return;
    const last = pack.candles.at(-1)?.c;
    if (!last) return;
    const range = suggestRange(pack.candles, fit, last);
    setParams((current) => {
      const grids = suggestGridCount(range.lower, range.upper, current.feePct / 100);
      if (current.lower === range.lower && current.upper === range.upper && current.grids === grids) {
        return current;
      }
      return { ...current, ...range, grids };
    });
  }, [pack, fit]);

  const gridParams = useMemo(() => toGrid(params), [params]);
  const validation = validateParams(gridParams);
  const result = useMemo(() => {
    if (!pack || validation) return null;
    const ran = runBacktest(pack.candles, gridParams);
    return "error" in ran ? null : ran;
  }, [pack, gridParams, validation]);

  const lastPrice = pack?.candles.at(-1)?.c ?? null;
  const firstPrice = pack?.candles[0]?.c ?? null;
  const plan = lastPrice != null && !validation ? allocate(gridParams, lastPrice) : null;

  function applyFit(next: Exclude<Fit, "custom">) {
    setFit(next);
    if (!pack) return;
    const last = pack.candles.at(-1)?.c;
    if (!last) return;
    const range = suggestRange(pack.candles, next, last);
    setParams((current) => ({
      ...current,
      ...range,
      grids: suggestGridCount(range.lower, range.upper, current.feePct / 100),
    }));
  }

  function patch(partial: Partial<Params>, custom = true) {
    if (custom) setFit("custom");
    setParams((current) => ({ ...current, ...partial }));
  }

  return (
    <div className="min-h-screen bg-ink text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-gold uppercase">BTC-USDT · spot · OKX</p>
            <h1 className="font-display text-4xl text-fg italic">Maille</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Backtest d'un bot de grille sur l'historique public OKX. Le même capital est comparé à un achat
              conservé.
            </p>
          </div>
          <Quote last={lastPrice} first={firstPrice} loading={loading && !pack} />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl grid-cols-1 items-start gap-4 px-4 py-4 lg:grid-cols-12">
        <aside className="grid min-w-0 grid-cols-1 gap-4 lg:col-span-4">
          <section className="rounded-lg border border-line bg-panel p-4">
            <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Historique</h2>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {(Object.keys(BAR_LABEL) as OkxBar[]).map((bar) => (
                <SegButton
                  key={bar}
                  pressed={spec.bar === bar}
                  onClick={() => setSpec((current) => normalizeSpec({ bar, days: current.days }))}
                >
                  {BAR_LABEL[bar]}
                </SegButton>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {SPANS[spec.bar].map((span) => (
                <SegButton
                  key={span.days}
                  pressed={spec.days === span.days}
                  onClick={() => setSpec({ bar: spec.bar, days: span.days })}
                >
                  {span.label}
                </SegButton>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              {pack
                ? `${pack.candles.length.toLocaleString("fr-FR")} bougies · ${dayLabel(pack.candles[0].t)} → ${dayLabel(pack.candles.at(-1)!.t)}`
                : "Lecture des chandeliers OKX"}
              {loading ? " · actualisation" : ""}
            </p>
            {pack && pack.candles.length < pack.requested * 0.85 ? (
              <p className="mt-1 text-xs text-muted">L'historique OKX est plus court que la fenêtre demandée.</p>
            ) : null}
            {spec.bar === "1D" ? (
              <p className="mt-1 text-xs text-muted">Le journalier BTC-USDT remonte à octobre 2017.</p>
            ) : null}
            <button
              type="button"
              className="mt-3 h-11 w-full rounded-lg border border-line text-sm text-fg transition-colors hover:border-gold disabled:opacity-50"
              onClick={() => setReloadKey((n) => n + 1)}
              disabled={loading}
            >
              {loading ? "Chargement OKX…" : "Recharger les données"}
            </button>
            {error ? <p className="mt-2 text-sm text-down">{error}</p> : null}
          </section>

          <section className="rounded-lg border border-line bg-panel p-4">
            <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Grille</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <SegButton pressed={params.mode === "arithmetic"} onClick={() => patch({ mode: "arithmetic" }, false)}>
                Arithmétique
              </SegButton>
              <SegButton pressed={params.mode === "geometric"} onClick={() => patch({ mode: "geometric" }, false)}>
                Géométrique
              </SegButton>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <SegButton pressed={fit === "wide"} onClick={() => applyFit("wide")}>
                Large
              </SegButton>
              <SegButton pressed={fit === "balanced"} onClick={() => applyFit("balanced")}>
                Équilibré
              </SegButton>
              <SegButton pressed={fit === "tight"} onClick={() => applyFit("tight")}>
                Serré
              </SegButton>
            </div>
            <div className="mt-3 grid gap-3">
              <NumField
                label="Prix bas"
                value={params.lower}
                suffix="USDT"
                onCommit={(n) => {
                  if (n != null && n > 0) patch({ lower: n });
                }}
              />
              <NumField
                label="Prix haut"
                value={params.upper}
                suffix="USDT"
                onCommit={(n) => {
                  if (n != null && n > 0) patch({ upper: n });
                }}
              />
            </div>
            <label className="mt-3 block">
              <span className="flex items-baseline justify-between text-xs tracking-wide text-muted uppercase">
                Grilles
                <span className="text-sm text-fg tabular-nums normal-case">{params.grids}</span>
              </span>
              <input
                className="mt-1 w-full"
                type="range"
                min={2}
                max={100}
                step={1}
                value={params.grids}
                suppressHydrationWarning
                onChange={(event) => patch({ grids: Number(event.target.value) })}
                aria-valuemin={2}
                aria-valuemax={100}
                aria-valuenow={params.grids}
              />
            </label>
            <GridSketch levels={plan?.levels ?? []} price={lastPrice} />
            <Preview plan={plan} params={params} validation={validation} />
          </section>

          <section className="rounded-lg border border-line bg-panel p-4">
            <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Capital</h2>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[1000, 10_000, 50_000].map((amount) => (
                <SegButton
                  key={amount}
                  pressed={params.investment === amount}
                  onClick={() => patch({ investment: amount }, false)}
                >
                  {amount >= 1000 ? `${amount / 1000} k` : String(amount)}
                </SegButton>
              ))}
            </div>
            <div className="mt-3 grid gap-3">
              <NumField
                label="Investissement"
                value={params.investment}
                suffix="USDT"
                onCommit={(n) => {
                  if (n != null && n > 0) patch({ investment: n }, false);
                }}
              />
              <NumField
                label="Frais"
                value={params.feePct}
                suffix="%"
                hint="Maker OKX standard : 0,08 %. L'achat initial est souvent taker."
                onCommit={(n) => {
                  if (n != null && n >= 0 && n < 5) patch({ feePct: n }, false);
                }}
              />
              <SegButton pressed={params.reinvest} onClick={() => patch({ reinvest: !params.reinvest }, false)}>
                {params.reinvest ? "Profits réinvestis" : "Réinvestir les profits"}
              </SegButton>
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Stop, objectif et trailing</h3>
              <div className="mt-3 grid gap-3">
                <NumField
                  label="Prise de profit"
                  value={params.takeProfit}
                  suffix="USDT"
                  hint="Au-dessus du haut de grille. Le bot vend tout le BTC et s'arrête. Ce prix ne bouge pas."
                  onCommit={(n) => patch({ takeProfit: n }, false)}
                />
                <NumField
                  label="Stop loss"
                  value={params.stopLoss}
                  suffix="USDT"
                  hint="Sous le bas de grille. Le bot vend tout le BTC et s'arrête. Il monte avec le trailing haut."
                  onCommit={(n) => patch({ stopLoss: n }, false)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <SegButton
                    pressed={params.trailUp != null}
                    onClick={() =>
                      patch(
                        {
                          trailUp:
                            params.trailUp == null ? Math.round(params.upper * 1.5) : null,
                        },
                        false,
                      )
                    }
                  >
                    Trailing haut
                  </SegButton>
                  <SegButton
                    pressed={params.trailDown != null}
                    onClick={() =>
                      patch(
                        {
                          trailDown:
                            params.trailDown == null ? Math.round(params.lower * 0.7) : null,
                        },
                        false,
                      )
                    }
                  >
                    Trailing bas
                  </SegButton>
                </div>
                {params.trailUp != null ? (
                  <NumField
                    label="Plafond trailing haut"
                    value={params.trailUp}
                    suffix="USDT"
                    hint="Si le cours dépasse le haut, la grille entière monte d'un cran, jusqu'à ce plafond."
                    onCommit={(n) => {
                      if (n != null && n > 0) patch({ trailUp: n }, false);
                    }}
                  />
                ) : null}
                {params.trailDown != null ? (
                  <NumField
                    label="Plancher trailing bas"
                    value={params.trailDown}
                    suffix="USDT"
                    hint="Si le cours passe sous le bas, la grille s'allonge vers le bas, sans dépasser ce plancher. Le capital manquant est ajouté."
                    onCommit={(n) => {
                      if (n != null && n > 0) patch({ trailDown: n }, false);
                    }}
                  />
                ) : null}
              </div>
            </div>
          </section>

          <details className="rounded-lg border border-line bg-panel p-4 text-sm text-muted">
            <summary className="cursor-pointer text-fg">Méthode</summary>
            <div className="mt-3 grid gap-2">
              <p>
                N grilles découpent la zone en N intervalles. Arithmétique : écart de prix fixe. Géométrique :
                ratio fixe.
              </p>
              <p>
                La quantité de BTC est la même sur chaque grille, calculée pour employer tout le capital. Sous le
                prix d'entrée, des USDT restent réservés pour des achats limites. Au-dessus, le BTC est acheté tout
                de suite au marché — comme sur OKX, souvent à un meilleur prix que le niveau théorique.
              </p>
              <p>
                Chaque bougie est lue dans l'ordre ouverture, mèche adverse, mèche favorable, clôture. Un seul
                aller-retour intra-bougie est donc compté. Hors zone, aucun nouvel ordre, sauf trailing. La position
                restante est marquée au dernier cours. Les frais sortent en BTC à l'achat et en USDT à la vente.
              </p>
              <p>
                Trailing haut : quand le cours dépasse le haut de grille, l'achat le plus bas est annulé et la grille
                monte d'un cran, jusqu'au plafond. Le stop et le plancher du trailing bas montent avec elle.
                L'objectif reste fixe. Trailing bas : la grille s'allonge d'un cran vers le plancher, le haut ne
                bouge pas, et le capital manquant est compté à part. Réinvestir les profits augmente la taille des
                ordres après chaque cycle gagnant.
              </p>
            </div>
          </details>
        </aside>

        <section className="grid min-w-0 grid-cols-1 gap-4 lg:col-span-8">
          <Results
            pack={pack}
            loading={loading}
            error={error}
            validation={validation}
            result={result}
            feeRate={params.feePct / 100}
            onApply={(next) => {
              setFit("custom");
              setParams((current) => ({ ...current, ...next }));
            }}
            onRetry={() => setReloadKey((n) => n + 1)}
          />
        </section>
      </main>
      <footer className="mx-auto max-w-7xl px-4 py-6 text-xs text-muted">
        Données de marché publiques OKX. Simulation, pas un conseil. Le glissement, le funding et la file d'attente
        réelle ne sont pas modélisés.
      </footer>
    </div>
  );
}

function Quote({ last, first, loading }: { last: number | null; first: number | null; loading: boolean }) {
  if (last == null || first == null) {
    return (
      <div>
        <div className="text-xs tracking-wide text-muted uppercase">Dernier cours</div>
        <div className="text-2xl font-medium tabular-nums">{loading ? "…" : "—"}</div>
      </div>
    );
  }
  const delta = (last - first) / first;
  return (
    <div className="sm:text-right">
      <div className="text-xs tracking-wide text-muted uppercase">Dernier cours</div>
      <div className="text-2xl font-medium tabular-nums">{price(last)} USDT</div>
      <div className={`text-sm tabular-nums ${delta >= 0 ? "text-up" : "text-down"}`}>
        {pctRatio(delta)} sur la fenêtre
      </div>
    </div>
  );
}

function SegButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex h-11 items-center justify-center rounded-lg border px-1 text-center text-xs leading-tight transition-colors ${
        pressed
          ? "border-gold bg-panel-2 text-fg"
          : "border-line bg-ink text-muted hover:border-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function NumField({
  label,
  value,
  suffix,
  hint,
  onCommit,
}: {
  label: string;
  value: number | null;
  suffix: string;
  hint?: string;
  onCommit: (n: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? "" : String(value));
  }, [value, focused]);
  return (
    <label className="block">
      <span className="text-xs tracking-wide text-muted uppercase">{label}</span>
      <span className="mt-1 flex h-11 items-center rounded-lg border border-line bg-ink focus-within:border-gold">
        <input
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-fg tabular-nums outline-none"
          inputMode="decimal"
          value={text}
          suppressHydrationWarning
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            const parsed = parseLoose(text);
            if (text.trim() === "") {
              onCommit(null);
              setText("");
              return;
            }
            onCommit(parsed);
            setText(parsed == null ? (value == null ? "" : String(value)) : String(parsed));
          }}
          onChange={(event) => setText(event.target.value)}
        />
        <span className="pr-3 text-xs text-muted">{suffix}</span>
      </span>
      {hint ? <span className="mt-1 block text-xs text-muted normal-case">{hint}</span> : null}
    </label>
  );
}

function GridSketch({ levels, price: mark }: { levels: number[]; price: number | null }) {
  if (levels.length < 2) return null;
  const lo = levels[0];
  const hi = levels[levels.length - 1];
  const span = hi - lo || 1;
  const xOf = (level: number) => 8 + ((level - lo) / span) * 184;
  const stride = Math.max(1, Math.ceil(levels.length / 16));
  const shown = levels.filter((_, index) => index % stride === 0 || index === levels.length - 1);
  const markInside = mark != null && mark >= lo && mark <= hi;
  return (
    <svg viewBox="0 0 200 44" className="mt-3 h-11 w-full" role="img" aria-hidden="true">
      <line x1="8" y1="22" x2="192" y2="22" stroke="var(--color-line)" />
      {shown.map((level) => (
        <line
          key={level}
          x1={xOf(level)}
          y1="12"
          x2={xOf(level)}
          y2="32"
          stroke="var(--color-muted)"
          strokeWidth="1"
        />
      ))}
      {markInside ? <circle cx={xOf(mark)} cy="22" r="3.5" fill="var(--color-gold)" /> : null}
    </svg>
  );
}

function Preview({
  plan,
  params,
  validation,
}: {
  plan: ReturnType<typeof allocate>;
  params: Params;
  validation: string | null;
}) {
  if (validation) return <p className="mt-3 text-sm text-down">{validation}</p>;
  if (!plan) return null;
  const hurdle = feeHurdle(params.feePct / 100);
  const tight = plan.minReturn <= hurdle;
  const reserve = plan.limits.reduce((sum, index) => sum + plan.qty * plan.levels[index], 0);
  const deployed = plan.qty * plan.entryPrice * plan.market.length;
  const step =
    params.mode === "arithmetic"
      ? (params.upper - params.lower) / params.grids
      : Math.pow(params.upper / params.lower, 1 / params.grids);
  return (
    <div className="mt-3 grid gap-1 text-sm">
      <p className="tabular-nums text-fg">
        {params.mode === "arithmetic"
          ? `Écart ${price(step)} USDT`
          : `Ratio ${step.toLocaleString("fr-FR", { maximumFractionDigits: 4 })}`}
        {" · "}
        {plan.minReturn === plan.maxReturn
          ? pctRatio(plan.minReturn, false)
          : `${pctRatio(plan.minReturn, false)} → ${pctRatio(plan.maxReturn, false)}`}
        {" / grille"}
      </p>
      <p className="text-muted tabular-nums">
        {plan.entry === "inside"
          ? `${btc(plan.qty)} / grille · ${plan.market.length} achats au marché · ${plan.limits.length} limites`
          : `Cours hors zone. À l'entrée : ${btc(plan.qty)} / grille.`}
      </p>
      {plan.entry === "inside" ? (
        <p className="text-muted tabular-nums">
          {usdt(deployed, true)} en BTC au départ · {usdt(reserve, true)} réservés aux achats
        </p>
      ) : null}
      {tight ? (
        <p className="text-down">
          Le gain minimum par grille ne couvre pas les frais aller-retour ({pctRatio(hurdle, false)}). Élargissez
          l'écart ou réduisez le nombre de grilles.
        </p>
      ) : null}
    </div>
  );
}

function Results({
  pack,
  loading,
  error,
  validation,
  result,
  feeRate,
  onApply,
  onRetry,
}: {
  pack: CandlePack | null;
  loading: boolean;
  error: string | null;
  validation: string | null;
  result: BacktestResult | null;
  feeRate: number;
  onApply: (next: AppliedGrid) => void;
  onRetry: () => void;
}) {
  if (!pack && loading) {
    return (
      <div className="rounded-lg border border-line bg-panel p-6">
        <h2 className="font-display text-2xl">Lecture de l'historique OKX</h2>
        <p className="mt-2 text-sm text-muted">Chandeliers BTC-USDT en cours de téléchargement.</p>
      </div>
    );
  }
  if (!pack && error) {
    return (
      <div className="rounded-lg border border-line bg-panel p-6">
        <h2 className="font-display text-2xl">OKX ne répond pas</h2>
        <p className="mt-2 text-sm text-down">{error}</p>
        <button
          type="button"
          className="mt-4 h-11 rounded-lg bg-gold px-4 text-sm font-medium text-ink"
          onClick={onRetry}
        >
          Réessayer
        </button>
      </div>
    );
  }
  if (validation) {
    return (
      <div className="rounded-lg border border-line bg-panel p-6">
        <h2 className="font-display text-2xl">Paramètres à corriger</h2>
        <p className="mt-2 text-sm text-down">{validation}</p>
      </div>
    );
  }
  if (!result || !pack) return null;
  return <Report pack={pack} result={result} loading={loading} feeRate={feeRate} onApply={onApply} />;
}

function Report({
  pack,
  result,
  loading,
  feeRate,
  onApply,
}: {
  pack: CandlePack;
  result: BacktestResult;
  loading: boolean;
  feeRate: number;
  onApply: (next: AppliedGrid) => void;
}) {
  const { summary } = result;
  const [tab, setTab] = useState<"price" | "equity" | "months">("price");
  const [cursor, setCursor] = useState(Number.MAX_SAFE_INTEGER);
  const [playing, setPlaying] = useState(false);
  const sells = result.fills.filter((fill) => fill.reason === "grid" && fill.side === "sell").slice().reverse();
  const length = result.equity.length;
  const frame = result.equity[Math.min(cursor, Math.max(0, length - 1))];

  useEffect(() => {
    setCursor(Math.max(0, length - 1));
    setPlaying(false);
  }, [result, length]);

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.round(length / 280));
    const id = window.setInterval(() => {
      setCursor((current) => {
        if (current >= length - 1) {
          setPlaying(false);
          return length - 1;
        }
        return Math.min(length - 1, current + step);
      });
    }, 40);
    return () => window.clearInterval(id);
  }, [playing, length]);

  return (
    <>
      <div className="rounded-lg border border-line bg-panel p-4 sm:p-5">
        <Headline summary={summary} />
        <p className="mt-1 text-sm text-muted tabular-nums">
          Grille {pctRatio(summary.roi)} · hold {pctRatio(summary.holdRoi)}
          {summary.apr != null ? ` · ${pctRatio(summary.apr)} en rythme annuel, linéaire` : ""}
          {summary.activationPrice != null
            ? ` · activée à ${price(summary.activationPrice)}`
            : ""}
          {loading ? " · données en cours" : ""}
        </p>
        {summary.stopped ? (
          <p className="mt-2 text-sm text-gold">
            {summary.stopped === "sl" ? "Stop loss atteint" : "Objectif atteint"} — le bot est figé ensuite, le hold
            continue.
          </p>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="PnL total" value={signedUsdt(summary.pnl)} tone={toneOf(summary.pnl)} />
          <Stat label="Rendement" value={pctRatio(summary.roi)} tone={toneOf(summary.roi)} />
          <Stat label="Écart vs hold" value={signedUsdt(summary.alpha)} tone={toneOf(summary.alpha)} />
          <Stat
            label="Allers-retours"
            value={summary.cycles ? summary.cycles.toLocaleString("fr-FR") : "0"}
          />
          <Stat
            label="Drawdown max"
            value={`${pctRatio(summary.maxDrawdown, false)} · ${usdt(summary.maxDrawdownUsdt, true)}`}
            tone={summary.maxDrawdown > 0 ? "down" : undefined}
          />
          <Stat label="Frais" value={usdt(summary.fees)} />
          <Stat
            label="Trailing haut"
            value={summary.trailUpCount ? summary.trailUpCount.toLocaleString("fr-FR") : "0"}
          />
          <Stat
            label="Trailing bas"
            value={summary.trailDownCount ? summary.trailDownCount.toLocaleString("fr-FR") : "0"}
          />
          <Stat label="Capital ajouté" value={usdt(summary.extraCapital)} />
          {summary.reinvested > 0 ? <Stat label="Réinvesti" value={usdt(summary.reinvested)} /> : null}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
          <Fact label="Équité finale" value={usdt(summary.finalEquity)} />
          <Fact label="Cash" value={usdt(summary.finalCash)} />
          <Fact label="BTC restant" value={btc(summary.finalBtc)} />
          <Fact label="Profits de grille" value={signedUsdt(summary.gridPnl)} />
          <Fact label="Position ouverte" value={signedUsdt(summary.unrealizedPnl)} />
          <Fact
            label="Dans la zone"
            value={`${pctPoints(summary.inRangePct * 100)} · exposition ${pctPoints(summary.avgExposure * 100)}`}
          />
        </dl>
      </div>

      <Proposals candles={pack.candles} investment={summary.investment} feeRate={feeRate} onApply={onApply} />

      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="flex flex-wrap gap-2">
          <SegButton pressed={tab === "price"} onClick={() => setTab("price")}>
            Cours
          </SegButton>
          <SegButton pressed={tab === "equity"} onClick={() => setTab("equity")}>
            Équité
          </SegButton>
          <SegButton pressed={tab === "months"} onClick={() => setTab("months")}>
            Mois
          </SegButton>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
          {tab === "price" ? (
            <>
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-gold" /> Cours de clôture
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block h-px w-4 bg-gold" /> Niveaux à cette date
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-up" /> Trailing haut
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-down" /> Trailing bas
              </span>
            </>
          ) : tab === "equity" ? (
            <>
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-gold" /> Grille
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-muted" /> Achat conservé
              </span>
            </>
          ) : (
            <span>Profits réalisés des cycles bouclés, par mois UTC.</span>
          )}
        </div>
        {tab === "price" && frame ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="h-11 rounded-lg border border-line px-3 text-sm text-fg hover:border-gold"
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  return;
                }
                setCursor((current) => (current >= length - 1 ? 0 : current));
                setPlaying(true);
              }}
            >
              {playing ? "Pause" : "Lecture"}
            </button>
            <input
              className="min-w-0 flex-1"
              type="range"
              min={0}
              max={Math.max(0, length - 1)}
              step={1}
              value={Math.min(cursor, Math.max(0, length - 1))}
              suppressHydrationWarning
              aria-label="Avancer dans le temps"
              onChange={(event) => {
                setPlaying(false);
                setCursor(Number(event.target.value));
              }}
            />
            <div className="text-xs text-muted tabular-nums">
              <div>{pack.bar === "1D" ? dayLabel(frame.t) : stampLabel(frame.t)}</div>
              <div>
                Grille {price(frame.lower)} – {price(frame.upper)}
              </div>
            </div>
          </div>
        ) : null}
        <div className="mt-2 h-64 sm:h-80">
          {tab === "price" ? (
            <PriceChart result={result} bar={pack.bar} at={frame?.t ?? 0} />
          ) : tab === "equity" ? (
            <EquityChart result={result} bar={pack.bar} />
          ) : (
            <MonthChart result={result} />
          )}
        </div>
      </div>

      <details className="rounded-lg border border-line bg-panel p-4">
        <summary className="cursor-pointer text-xs font-medium tracking-wide text-muted uppercase">
          Cycles bouclés · {sells.length.toLocaleString("fr-FR")}
        </summary>
        {sells.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Aucun aller-retour sur cette fenêtre.</p>
        ) : (
          <CycleTable sells={sells.slice(0, 80)} total={sells.length} feeRate={feeRate} />
        )}
      </details>
    </>
  );
}

function Headline({ summary }: { summary: BacktestSummary }) {
  if (summary.activationPrice == null) {
    return (
      <h2 className="font-display text-2xl text-balance sm:text-3xl">Le cours n'a pas touché cette zone.</h2>
    );
  }
  if (summary.alpha >= 0) {
    return (
      <h2 className="font-display text-2xl text-balance sm:text-3xl">
        La grille bat le hold de <span className="text-up">{usdt(summary.alpha)}</span>.
      </h2>
    );
  }
  return (
    <h2 className="font-display text-2xl text-balance sm:text-3xl">
      Le hold bat la grille de <span className="text-down">{usdt(-summary.alpha)}</span>.
    </h2>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border border-line bg-ink px-3 py-3">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div
        className={`mt-1 text-base font-medium break-words tabular-nums sm:text-lg ${
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted uppercase">{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}

type TipRow = { name?: string; value?: number; color?: string; dataKey?: string | number };

function ChartTip({
  active,
  payload,
  label,
  kind,
  bar,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: number | string;
  kind: "price" | "equity";
  bar: OkxBar;
}) {
  if (!active || !payload?.length || typeof label !== "number") return null;
  return (
    <div className="rounded-lg border border-line bg-ink px-3 py-2 text-xs">
      <div className="text-muted">{bar === "1D" ? dayLabel(label) : stampLabel(label)}</div>
      {payload.map((row) => (
        <div key={String(row.dataKey)} className="mt-1 tabular-nums" style={{ color: row.color ?? "var(--color-fg)" }}>
          {row.name} · {kind === "price" ? price(Number(row.value)) : usdt(Number(row.value))}
        </div>
      ))}
    </div>
  );
}

function Proposals({
  candles,
  investment,
  feeRate,
  onApply,
}: {
  candles: CandlePack["candles"];
  investment: number;
  feeRate: number;
  onApply: (next: AppliedGrid) => void;
}) {
  const rows = useMemo(() => {
    const entry = candles[0]?.c;
    if (!entry) return [];
    const ranked = proposeGrids(entry).flatMap((proposal) => {
      const ran = runBacktest(candles, {
        lower: proposal.lower,
        upper: proposal.upper,
        grids: proposal.grids,
        mode: proposal.mode,
        investment,
        feeRate,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        trailUp: proposal.trailUp,
        trailDown: proposal.trailDown,
        reinvest: proposal.reinvest,
      });
      if ("error" in ran) return [];
      return [{ proposal, summary: ran.summary }];
    });
    ranked.sort((a, b) => b.summary.alpha - a.summary.alpha);
    return ranked;
  }, [candles, investment, feeRate]);
  const first = candles[0];
  if (!rows.length || !first) return null;
  const best = rows[0].proposal.id;
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Propositions</h2>
      <p className="mt-1 text-sm text-muted">
        Calées sur le cours du {dayLabel(first.t)} ({price(first.c)} USDT). La zone ne regarde pas le futur. Le
        classement rejoue toute la fenêtre : c'est le backtest, pas une prévision.
      </p>
      <div className="mt-3 grid gap-2">
        {rows.map(({ proposal, summary }) => (
          <button
            key={proposal.id}
            type="button"
            onClick={() =>
              onApply({
                lower: proposal.lower,
                upper: proposal.upper,
                grids: proposal.grids,
                mode: proposal.mode,
                trailUp: proposal.trailUp,
                trailDown: proposal.trailDown,
                stopLoss: proposal.stopLoss,
                takeProfit: proposal.takeProfit,
                reinvest: proposal.reinvest,
              })
            }
            className={`rounded-lg border px-3 py-2 text-left ${
              proposal.id === best ? "border-gold bg-panel-2" : "border-line bg-ink hover:border-muted"
            }`}
          >
            <span className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm text-fg">
                {proposal.name}
                {proposal.id === best ? <span className="ml-2 text-xs text-gold">meilleur écart</span> : null}
              </span>
              <span className={`text-sm tabular-nums ${summary.alpha >= 0 ? "text-up" : "text-down"}`}>
                {pctRatio(summary.roi)} · écart {signedUsdt(summary.alpha)}
              </span>
            </span>
            <span className="mt-1 block text-xs text-muted">
              {proposal.note} Drawdown {pctRatio(summary.maxDrawdown, false)}.
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function bandAt(result: BacktestResult, t: number): number[] {
  let chosen = result.bands[0]?.levels ?? result.summary.levels;
  for (const band of result.bands) {
    if (band.t <= t) chosen = band.levels;
    else break;
  }
  return chosen;
}

function PriceChart({ result, bar, at }: { result: BacktestResult; bar: OkxBar; at: number }) {
  const data = useMemo(
    () => downsample(result.equity.map((point) => ({ t: point.t, c: point.price })), 480),
    [result],
  );
  const shown = useMemo(() => {
    const levels = bandAt(result, at);
    const stride = Math.max(1, Math.ceil(levels.length / 18));
    return levels.flatMap((level, index) => {
      const edge = index === 0 || index === levels.length - 1;
      if (!edge && index % stride !== 0) return [];
      return [{ level, edge }];
    });
  }, [result, at]);
  const [yMin, yMax] = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of data) {
      if (row.c < min) min = row.c;
      if (row.c > max) max = row.c;
    }
    for (const band of result.bands) {
      const lo = band.levels[0];
      const hi = band.levels[band.levels.length - 1];
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    const pad = (max - min) * 0.06 || max * 0.01;
    return [min - pad, max + pad];
  }, [data, result.bands]);
  const upMarks = result.trails.filter((mark) => mark.dir === "up" && mark.t <= at).map((mark) => ({ t: mark.t, c: mark.price }));
  const downMarks = result.trails
    .filter((mark) => mark.dir === "down" && mark.t <= at)
    .map((mark) => ({ t: mark.t, c: mark.price }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-line)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t: number) => (bar === "1D" ? dayLabel(t).replace(/\s?\d{4}$/, "") : dayLabel(t))}
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          minTickGap={32}
        />
        <YAxis
          domain={[yMin, yMax]}
          tickFormatter={(n: number) => compactNumber(n)}
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          width={56}
        />
        <Tooltip content={(props) => <ChartTip {...tipOf(props)} kind="price" bar={bar} />} />
        {shown.map((row) => (
          <ReferenceLine
            key={row.level}
            y={row.level}
            stroke="var(--color-gold)"
            strokeOpacity={row.edge ? 0.9 : 0.4}
            strokeDasharray={row.edge ? undefined : "3 4"}
          />
        ))}
        <ReferenceLine x={at} stroke="var(--color-fg)" strokeOpacity={0.65} />
        <Line
          type="monotone"
          dataKey="c"
          name="Cours"
          stroke="var(--color-gold)"
          dot={false}
          strokeWidth={1.6}
          isAnimationActive={false}
        />
        <Scatter data={upMarks} dataKey="c" name="Trailing haut" fill="var(--color-up)" isAnimationActive={false} />
        <Scatter data={downMarks} dataKey="c" name="Trailing bas" fill="var(--color-down)" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EquityChart({ result, bar }: { result: BacktestResult; bar: OkxBar }) {
  const data = useMemo(
    () =>
      downsample(
        result.equity.map((point) => ({ t: point.t, grille: point.equity, hold: point.hold })),
        480,
      ),
    [result],
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-line)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t: number) => dayLabel(t)}
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          minTickGap={32}
        />
        <YAxis
          tickFormatter={(n: number) => compactNumber(n)}
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          width={56}
        />
        <Tooltip content={(props) => <ChartTip {...tipOf(props)} kind="equity" bar={bar} />} />
        <Area
          type="monotone"
          dataKey="grille"
          name="Grille"
          stroke="var(--color-gold)"
          fill="var(--color-gold)"
          fillOpacity={0.12}
          strokeWidth={1.6}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="hold"
          name="Hold"
          stroke="var(--color-muted)"
          dot={false}
          strokeDasharray="4 4"
          strokeWidth={1.4}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function MonthChart({ result }: { result: BacktestResult }) {
  const data = useMemo(() => monthBuckets(result.fills), [result]);
  if (!data.length) {
    return <p className="text-sm text-muted">Pas encore de cycle réalisé à regrouper.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-line)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(n: number) => compactNumber(n)}
          tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          stroke="var(--color-line)"
          width={56}
        />
        <Tooltip
          content={(props) => {
            const row = props.payload?.[0];
            if (!props.active || !row) return null;
            return (
              <div className="rounded-lg border border-line bg-ink px-3 py-2 text-xs">
                <div className="text-muted">{String(props.label ?? "")}</div>
                <div className="mt-1 tabular-nums text-fg">{signedUsdt(Number(row.value))}</div>
              </div>
            );
          }}
        />
        <Bar dataKey="pnl" isAnimationActive={false}>
          {data.map((row) => (
            <Cell key={row.key} fill={row.pnl >= 0 ? "var(--color-up)" : "var(--color-down)"} />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function monthBuckets(fills: Fill[]): { key: string; label: string; pnl: number }[] {
  const totals = new Map<string, number>();
  for (const fill of fills) {
    if (fill.reason !== "grid" || fill.side !== "sell" || fill.cyclePnl == null) continue;
    const date = new Date(fill.t);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    totals.set(key, (totals.get(key) ?? 0) + fill.cyclePnl);
  }
  const keys = [...totals.keys()].sort();
  if (!keys.length) return [];
  const [startY, startM] = keys[0].split("-").map(Number);
  const [endY, endM] = keys[keys.length - 1].split("-").map(Number);
  const rows: { key: string; label: string; pnl: number }[] = [];
  let year = startY;
  let month = startM;
  while (year < endY || (year === endY && month <= endM)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    rows.push({
      key,
      label: new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" }).format(
        Date.UTC(year, month - 1, 1),
      ),
      pnl: totals.get(key) ?? 0,
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return rows;
}

function CycleTable({ sells, total, feeRate }: { sells: Fill[]; total: number; feeRate: number }) {
  return (
    <div className="mt-3 w-full overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="text-xs tracking-wide text-muted uppercase">
          <tr className="border-b border-line">
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 font-medium">Achat</th>
            <th className="py-2 pr-3 font-medium">Vente</th>
            <th className="py-2 pr-3 font-medium">Qté</th>
            <th className="py-2 font-medium">PnL</th>
          </tr>
        </thead>
        <tbody>
          {sells.map((fill, index) => {
            const entry = entryPriceOf(fill, feeRate);
            const pnl = fill.cyclePnl ?? 0;
            const ret = fill.basis ? pnl / fill.basis : 0;
            return (
              <tr key={`${fill.t}-${fill.grid}-${index}`} className="border-b border-line/70">
                <td className="py-2 pr-3 text-muted tabular-nums">{stampLabel(fill.t)}</td>
                <td className="py-2 pr-3 tabular-nums">{entry == null ? "—" : price(entry)}</td>
                <td className="py-2 pr-3 tabular-nums">{price(fill.price)}</td>
                <td className="py-2 pr-3 tabular-nums">{btc(fill.qty)}</td>
                <td className={`py-2 tabular-nums ${pnl >= 0 ? "text-up" : "text-down"}`}>
                  {signedUsdt(pnl)} · {pctRatio(ret)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total > sells.length ? (
        <p className="mt-2 text-xs text-muted">
          {sells.length} derniers cycles affichés sur {total.toLocaleString("fr-FR")}.
        </p>
      ) : null}
    </div>
  );
}

function tipOf(props: { active?: boolean; payload?: readonly unknown[]; label?: unknown }): {
  active?: boolean;
  payload?: TipRow[];
  label?: number | string;
} {
  const payload = (props.payload ?? []).map((row) => {
    const item = row as TipRow;
    return { name: item.name, value: item.value, color: item.color, dataKey: item.dataKey };
  });
  const label = typeof props.label === "number" || typeof props.label === "string" ? props.label : undefined;
  return { active: props.active, payload, label };
}
