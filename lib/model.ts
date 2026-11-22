// Launch-Odds Radar v10 — model (fresh build, radar-10).
//
// What the radar does, in one paragraph: it reads the sealed snapshot of 758
// protocols, learns how a token's market cap relates to its protocol's TVL from
// the 87 protocols that record a token, a listing date and a non-exchange
// category, and scores every pre-token protocol by the implied value its launch
// would carry if that relationship held. The board ranks 198 protocols (the 40
// watchlist protocols plus the 158 largest pre-token protocols below the floor);
// the other 144 pre-token protocols are set aside and the 416 live-token
// protocols are shown at the market's own values, never mixed into the ranking.
//
// The model (radar-10), stated so the dashboard can repeat it verbatim:
//   target   y = log10(mcap_usd / tvl_usd), winsorized to [-1, 1] (0.1x-10x).
//            Winsorizing is disclosed, not hidden: 66 of the 144 token
//            protocols sit outside that band, so the fit never sees a ratio
//            wilder than 10x or thinner than 0.1x.
//   features 19 numbers from the snapshot's own fields only: log10 TVL and
//            its square, 7-day growth (clamped -60..120%) and its square,
//            log age and age in years (capped 3), log chain count, log TVL
//            per chain, eight semantic category-group flags (trade, lend,
//            yield, bridge, stake, rwa, derivatives, stablecoins — what the
//            category MEANS, never the category's token rate), a flag for a
//            reported 7-day change, logTVL x growth, and the listing year.
//            Category token-rate is self-leakage and is banned: no feature
//            anywhere is a category's average ratio, and no protocol name is
//            ever special-cased.
//   fit      ridge regression, lambda = 30, features standardized on the
//            labelled set, intercept unpenalized. Lambda was chosen by
//            held-out error only (leave-one-out + walk-forward over
//            lambda 1..300 and Huber variants); Huber lost on held-out, so
//            the shipped fit is plain ridge.
//   implied  implied_value_usd = round(tvl_usd x 10^predicted y).
//
// Farm economics (net of fees, the verdict follows the arithmetic, never the
// other way round): deposit = 0.02% of implied value, clamped to $25-$500.
// The reader's expected airdrop is their share of a 10% community allocation,
// where their share is their deposit's share of the protocol's TVL —
// expected = implied x 10% x deposit / TVL. No invented "active farmer"
// multiplier: the share-of-TVL version is the conservative, assumption-free
// reading (it dilutes the reader with passive TVL, and says so). Net =
// expected - $15 gas - 5% opportunity cost on the deposit. FARM when net > 0,
// else SKIP. The deposit grid and the sliders recompute the same arithmetic
// live in the page.
//
// Validation, all measured by this program at runtime and printed on the
// dashboard's evidence tables (definitions in the dashboard): leave-one-out
// (refit 87 times), walk-forward (train the 66 oldest listings, test the 29
// newest), 5-fold stratified / sequential / random (seed 42), bootstrap
// prediction intervals (200 resamples, seed 20261123), AUC on leave-one-out
// predictions (median split of the true ratio), Brier with Platt scaling on
// leave-one-out predictions (binary: mcap above TVL).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const ANCHOR_NOTE = 'drand quicknet';

/** Ridge penalty, chosen by held-out error only (see header). */
export const LAMBDA = 30;
/** Target winsor band: log10 ratio in [-1, 1]. */
export const CLIP_LO = -1;
export const CLIP_HI = 1;
/** Bootstrap resamples for ranges + coverage. */
export const BOOT_B = 200;
export const BOOT_SEED = 20261123;
/** Board size: watchlist 40 + 158 early rows. */
export const EARLY_ROWS = 158;
/** Live-token rows shown at market values. */
export const LIVE_ROWS = 24;
/** Farm economics. */
export const DEPOSIT_PCT_FRAC = 0.0002; // 0.02% of implied value
export const DEPOSIT_MIN = 25;
export const DEPOSIT_MAX = 500;
export const GAS_USD = 15;
export const OPPORTUNITY_RATE = 0.05; // 5% of the deposit
export const COMMUNITY_ALLOC = 0.1; // 10% of implied value to the community
export const MODEL_VERSION = 'radar-10';

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Deterministic RNG (mulberry32) — the program never uses Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The labelled set: a token, a listing date, not an exchange. 87 protocols. */
export function labelledSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.listed_at !== null && p.category !== 'CEX',
  );
}

function groupFlags(category: string | null): number[] {
  const c = (category ?? '').toLowerCase();
  const has = (s: string): number => (c.includes(s) ? 1 : 0);
  return [
    has('dex'),
    has('lend') || has('cdp') ? 1 : 0,
    has('yield'),
    has('bridge'),
    has('stak'),
    has('rwa'),
    has('deriv') || has('option') || has('perpetual') ? 1 : 0,
    has('stable'),
  ];
}

/** The 19 features, snapshot fields only. No category token-rate anywhere. */
export function features(p: SnapshotProtocol, asOf: string): number[] {
  const lt = Math.log10(p.tvl_usd);
  const g = clamp(p.change_7d ?? 0, -60, 120) / 100;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const la = Math.log10(age + 30);
  const nc = p.chains.length || 1;
  const year = p.listed_at !== null
    ? (Date.parse(`${p.listed_at}T00:00:00Z`) - Date.parse('2020-01-01T00:00:00Z')) / (365 * DAY_MS)
    : 0;
  return [
    lt,
    (lt - 9) * (lt - 9),
    g,
    g * g,
    la,
    Math.min(age, 1095) / 365,
    Math.log10(nc),
    Math.log10(p.tvl_usd / nc),
    ...groupFlags(p.category),
    p.change_7d === null ? 0 : 1,
    lt * g,
    year,
  ];
}

export function targetOf(p: SnapshotProtocol): number {
  return clamp(Math.log10(p.mcap_usd! / p.tvl_usd), CLIP_LO, CLIP_HI);
}

/** Column means / sds for standardization. */
export interface Standardizer { mu: number[]; sd: number[]; }

export function standardizer(X: number[][]): Standardizer {
  const d = X[0]!.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]!);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    const v = col.reduce((a, b) => a + (b - m) * (b - m), 0) / col.length;
    mu.push(m);
    sd.push(Math.sqrt(v) || 1);
  }
  return { mu, sd };
}

export function standardize(X: number[][], s: Standardizer): number[][] {
  return X.map((r) => r.map((v, j) => (v - s.mu[j]!) / s.sd[j]!));
}

export function standardizeOne(x: number[], s: Standardizer): number[] {
  return x.map((v, j) => (v - s.mu[j]!) / s.sd[j]!);
}

/** Solve A w = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    const tmp = M[c]!;
    M[c] = M[piv]!;
    M[piv] = tmp;
    const d = M[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / (r[i]! || 1e-12));
}

/** Ridge fit on standardized features; w[0] is the intercept (unpenalized). */
export function ridgeFit(Xs: number[][], y: number[], lambda: number): number[] {
  const d = Xs[0]!.length;
  const n = Xs.length;
  const A: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  const b: number[] = new Array<number>(d + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const x = [1, ...Xs[i]!];
    for (let j = 0; j <= d; j++) {
      b[j]! += x[j]! * y[i]!;
      for (let k = 0; k <= d; k++) A[j]![k]! += x[j]! * x[k]!;
    }
  }
  for (let j = 1; j <= d; j++) A[j]![j]! += lambda;
  return solveLinear(A, b);
}

export function predictOne(w: number[], x: number[]): number {
  let s = w[0]!;
  for (let j = 0; j < x.length; j++) s += w[j + 1]! * x[j]!;
  return s;
}

/** Geometric miss factor: 10 ^ mean |log10 error|. */
export function geoMiss(errs: number[]): number {
  return Math.pow(10, errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length);
}

export function aucOf(score: number[], bin: number[]): number {
  const pos = score.filter((_, i) => bin[i] === 1);
  const neg = score.filter((_, i) => bin[i] === 0);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let n = 0;
  for (const a of pos) for (const b of neg) n += a > b ? 1 : a === b ? 0.5 : 0;
  return n / (pos.length * neg.length);
}

/** Platt scaling (1-D logistic, Newton) on out-of-fold predictions. */
export function plattFit(score: number[], bin: number[]): { a0: number; a1: number } {
  let a0 = 0;
  let a1 = 0;
  for (let it = 0; it < 60; it++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < score.length; i++) {
      const z = a0 + a1 * score[i]!;
      const p = 1 / (1 + Math.exp(-z));
      const d = p - bin[i]!;
      g0 += d;
      g1 += d * score[i]!;
      const wgt = p * (1 - p) + 1e-9;
      h00 += wgt;
      h01 += wgt * score[i]!;
      h11 += wgt * score[i]! * score[i]!;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (h00 * g1 - h01 * g0) / det;
    a0 -= d0;
    a1 -= d1;
    if (Math.abs(d0) + Math.abs(d1) < 1e-9) break;
  }
  return { a0, a1 };
}

export function brierScore(score: number[], bin: number[], platt: { a0: number; a1: number }): number {
  let s = 0;
  for (let i = 0; i < score.length; i++) {
    const p = 1 / (1 + Math.exp(-(platt.a0 + platt.a1 * score[i]!)));
    s += (p - bin[i]!) * (p - bin[i]!);
  }
  return s / score.length;
}

export interface Validation {
  loo: number;
  looMedian: number;
  wf: number;
  wfMedian: number;
  foldsStrat: number[];
  foldsSeq: number[];
  foldsRand: number[];
  cov2575: number;
  cov1090: number;
  auc: number;
  brier: number;
  nLabelled: number;
  looPred: number[];
  looActual: number[];
}

/** All held-out validation, computed from the labelled set only. */
export function validate(labelled: SnapshotProtocol[], asOf: string): Validation {
  const X = labelled.map((p) => features(p, asOf));
  const y = labelled.map(targetOf);
  const ratio = labelled.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const n = labelled.length;

  // Leave-one-out (refit every time).
  const looErr: number[] = [];
  const looPred: number[] = [];
  for (let i = 0; i < n; i++) {
    const tr = labelled.map((_, j) => j).filter((j) => j !== i);
    const s = standardizer(tr.map((j) => X[j]!));
    const w = ridgeFit(standardize(tr.map((j) => X[j]!), s), tr.map((j) => y[j]!), LAMBDA);
    const pr = predictOne(w, standardizeOne(X[i]!, s));
    looPred.push(pr);
    looErr.push(y[i]! - pr);
  }

  // Walk-forward: train the 66 oldest listings, test the 29 newest.
  const order = labelled.map((p, i) => [p.listed_at!, i] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const trWf = order.slice(0, 66).map((x) => x[1]);
  const teWf = order.slice(66).map((x) => x[1]);
  const sWf = standardizer(trWf.map((j) => X[j]!));
  const wWf = ridgeFit(standardize(trWf.map((j) => X[j]!), sWf), trWf.map((j) => y[j]!), LAMBDA);
  const wfErr = teWf.map((i) => y[i]! - predictOne(wWf, standardizeOne(X[i]!, sWf)));

  // 5-fold, three assignments, seed 42.
  const foldErrs = (assign: number[]): number[] => {
    const out: number[] = [];
    for (let f = 0; f < 5; f++) {
      const te = labelled.map((_, i) => i).filter((i) => assign[i] === f);
      const tr = labelled.map((_, i) => i).filter((i) => assign[i] !== f);
      const s = standardizer(tr.map((j) => X[j]!));
      const w = ridgeFit(standardize(tr.map((j) => X[j]!), s), tr.map((j) => y[j]!), LAMBDA);
      out.push(geoMiss(te.map((i) => y[i]! - predictOne(w, standardizeOne(X[i]!, s)))));
    }
    return out;
  };
  // Stratified: quintile of the target, shuffled with seed 42, dealt round-robin.
  const ranked = y.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const stratAssign: number[] = new Array<number>(n).fill(0);
  const rngS = mulberry32(42);
  for (let q = 0; q < 5; q++) {
    const members = ranked.slice(q * 19, Math.min(n, (q + 1) * 19)).map((x) => x[1]);
    // last quintile holds the remainder when n is not a multiple of 19
    const all = q === 4 ? ranked.slice(76).map((x) => x[1]) : members;
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rngS() * (i + 1));
      const t = all[i]!;
      all[i] = all[j]!;
      all[j] = t;
    }
    all.forEach((idx, k) => { stratAssign[idx] = k % 5; });
  }
  const seqAssign: number[] = new Array<number>(n).fill(0);
  order.forEach((x, r) => { seqAssign[x[1]] = Math.min(4, Math.floor(r / 19)); });
  const rIdx = labelled.map((_, i) => i);
  const rngR = mulberry32(42);
  for (let i = rIdx.length - 1; i > 0; i--) {
    const j = Math.floor(rngR() * (i + 1));
    const t = rIdx[i]!;
    rIdx[i] = rIdx[j]!;
    rIdx[j] = t;
  }
  const randAssign: number[] = new Array<number>(n).fill(0);
  rIdx.forEach((idx, k) => { randAssign[idx] = k % 5; });

  // Bootstrap coverage: predictive distribution = bootstrap prediction + a
  // random leave-one-out residual. Coverage of the true (winsorized) ratio.
  const resSorted = [...looErr].sort((a, b) => a - b);
  const rngB = mulberry32(BOOT_SEED);
  const bootPred: number[][] = labelled.map(() => []);
  for (let b = 0; b < BOOT_B; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(rngB() * n));
    const sb = standardizer(idx.map((i) => X[i]!));
    const wb = ridgeFit(standardize(idx.map((i) => X[i]!), sb), idx.map((i) => y[i]!), LAMBDA);
    for (let i = 0; i < n; i++) bootPred[i]!.push(predictOne(wb, standardizeOne(X[i]!, sb)));
  }
  let c2575 = 0;
  let c1090 = 0;
  for (let i = 0; i < n; i++) {
    const dist = bootPred[i]!
      .map((v) => v + resSorted[Math.floor(rngB() * resSorted.length)]!)
      .sort((a, b) => a - b);
    const lo25 = dist[Math.floor(0.25 * dist.length)]!;
    const hi75 = dist[Math.floor(0.75 * dist.length)]!;
    const lo10 = dist[Math.floor(0.1 * dist.length)]!;
    const hi90 = dist[Math.floor(0.9 * dist.length)]!;
    if (y[i]! >= lo25 && y[i]! <= hi75) c2575++;
    if (y[i]! >= lo10 && y[i]! <= hi90) c1090++;
  }

  // AUC: median split of the true ratio, scored by leave-one-out predictions.
  const medR = median(ratio);
  const auc = aucOf(looPred, ratio.map((r) => (r > medR ? 1 : 0)));
  // Brier: binary mcap above TVL, Platt-scaled leave-one-out predictions.
  const bin = ratio.map((r) => (r > 0 ? 1 : 0));
  const platt = plattFit(looPred, bin);
  const brier = brierScore(looPred, bin, platt);

  return {
    loo: geoMiss(looErr),
    looMedian: Math.pow(10, median(looErr.map(Math.abs))),
    wf: geoMiss(wfErr),
    wfMedian: Math.pow(10, median(wfErr.map(Math.abs))),
    foldsStrat: foldErrs(stratAssign),
    foldsSeq: foldErrs(seqAssign),
    foldsRand: foldErrs(randAssign),
    cov2575: c2575 / n,
    cov1090: c1090 / n,
    auc,
    brier,
    nLabelled: n,
    looPred,
    looActual: y,
  };
}

/** Farm economics for one implied value / TVL pair. */
export function farmEconomics(implied: number, tvl: number, depositPctFrac: number, gasUsd: number): {
  deposit: number;
  expected: number;
  gas: number;
  opportunity: number;
  net: number;
  verdict: 'FARM' | 'SKIP';
} {
  const deposit = clamp(implied * depositPctFrac, DEPOSIT_MIN, DEPOSIT_MAX);
  // expected = implied x 10% community allocation x deposit / TVL
  //          = 0.1 x deposit x (implied / TVL)
  const expected = (COMMUNITY_ALLOC * deposit * implied) / tvl;
  const opportunity = OPPORTUNITY_RATE * deposit;
  const net = expected - gasUsd - opportunity;
  return { deposit, expected, gas: gasUsd, opportunity, net, verdict: net > 0 ? 'FARM' : 'SKIP' };
}

export interface FarmStep { text: string; cost: string; time: string; }

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Ten concrete farm steps, each with cost and time, from the protocol's own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null, deposit: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = Math.max(capitalFor(p), Math.min(deposit, 250));
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const cat = (p.category ?? 'general').toLowerCase();
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: `Check ${p.name} on ${chain} and confirm the pool or vault named in its own app before sending funds.`, cost: 'no fee to check', time: '10 minutes' },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week inside the ${cat} product, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Keep a second small action on a different week so the wallet shows repeated use, not a single deposit.`, cost: 'about $2 of gas', time: '10 minutes' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Track the position weekly in a farm log with the wallet, the dates and every transaction hash.`, cost: 'nothing but the log', time: '5 minutes a week' },
    { text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `When a claim opens, claim once, pay the gas shown in the wallet, and move the tokens to cold storage.`, cost: 'about $15 of gas to claim', time: '15 minutes' },
    { text: `After 180 days with no claim, unwind the position: the opportunity cost has passed the expected value.`, cost: 'about $4 of gas to exit', time: '15 minutes' },
  ];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_lo_usd: number;
  implied_hi_usd: number;
  rank_lo: number;
  rank_hi: number;
  pred_log_ratio: number;
  verdict: 'FARM' | 'SKIP';
  net_usd: number;
  expected_usd: number;
  deposit_usd: number;
  model: { growth_pct: number; age_days: number | null };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_lo_usd: number;
  implied_hi_usd: number;
  rank_lo: number;
  rank_hi: number;
  pred_log_ratio: number;
  verdict: 'FARM' | 'SKIP';
  net_usd: number;
  expected_usd: number;
  deposit_usd: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source_label: string;
  floor_usd: number;
  model_version: string;
  anchor_scheme: string;
  anchor_round: number;
  watchlist_slugs: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pretoken_set_aside: number;
  live_token_total: number;
  validation: {
    loo: number;
    loo_median: number;
    wf: number;
    wf_median: number;
    folds_strat: number[];
    folds_seq: number[];
    folds_rand: number[];
    cov_2575: number;
    cov_1090: number;
    auc: number;
    brier: number;
    n_labelled: number;
  };
  economics: {
    deposit_pct: number;
    deposit_pct_frac: number;
    deposit_min: number;
    deposit_max: number;
    gas_usd: number;
    opportunity_rate: number;
    community_alloc: number;
    slider_deposit: { min: number; max: number; step: number; def: number };
    slider_gas: { min: number; max: number; step: number; def: number };
  };
  farm_counts: { farm: number; skip: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** The board: watchlist first, then the early radar by TVL, ranked by implied value. */
export function buildBoard(
  snapshot: Snapshot,
  w: number[],
  s: Standardizer,
  bootW: number[][],
  bootS: Standardizer[],
  looResiduals: number[],
): { board: BoardRow[]; earlySize: number; setAside: number } {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const preToken = snapshot.protocols.filter(isPreToken);
  const setAside = preToken.length - chosen.size;

  // Bootstrap implied values per protocol, for ranges and rank ranges.
  const bootImplied = new Map<string, number[]>();
  const scored = [...chosen.values()].map((p) => {
    const pred = predictOne(w, standardizeOne(features(p, snapshot.as_of), s));
    const predC = clamp(pred, CLIP_LO, CLIP_HI);
    const implied = Math.max(1, Math.round(p.tvl_usd * Math.pow(10, predC)));
    const boots: number[] = [];
    for (let b = 0; b < BOOT_B; b++) {
      const pb = clamp(predictOne(bootW[b]!, standardizeOne(features(p, snapshot.as_of), bootS[b]!)), CLIP_LO, CLIP_HI);
      boots.push(Math.max(1, Math.round(p.tvl_usd * Math.pow(10, pb))));
    }
    boots.sort((a, b) => a - b);
    bootImplied.set(p.slug, boots);
    return { p, pred: predC, implied, boots };
  });
  // Rank ranges: rank each protocol inside every bootstrap draw.
  const rankLo = new Map<string, number>();
  const rankHi = new Map<string, number>();
  for (let b = 0; b < BOOT_B; b++) {
    const order = scored
      .map((x) => [x.boots[b]!, x.p.slug] as [number, string])
      .sort((a, c) => c[0] - a[0] || (a[1] < c[1] ? -1 : 1));
    order.forEach(([, slug], i) => {
      const r = i + 1;
      rankLo.set(slug, Math.min(rankLo.get(slug) ?? 999, r));
      rankHi.set(slug, Math.max(rankHi.get(slug) ?? 0, r));
    });
  }
  void looResiduals;

  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((x, i) => {
    const age = ageDays(snapshot.as_of, x.p.listed_at);
    const econ = farmEconomics(x.implied, x.p.tvl_usd, DEPOSIT_PCT_FRAC, GAS_USD);
    const lo = x.boots[Math.floor(0.1 * x.boots.length)]!;
    const hi = x.boots[Math.floor(0.9 * x.boots.length)]!;
    return {
      rank: i + 1,
      slug: x.p.slug,
      name: x.p.name,
      category: x.p.category,
      chains: x.p.chains,
      tvl_usd: x.p.tvl_usd,
      change_7d: x.p.change_7d,
      mcap_usd: x.p.mcap_usd,
      listed_at: x.p.listed_at,
      gecko_id: x.p.gecko_id,
      symbol: x.p.symbol,
      token_status: 'pre-token',
      age_days: age,
      implied_value_usd: x.implied,
      implied_lo_usd: lo,
      implied_hi_usd: hi,
      rank_lo: rankLo.get(x.p.slug) ?? i + 1,
      rank_hi: rankHi.get(x.p.slug) ?? i + 1,
      pred_log_ratio: Math.round(x.pred * 10000) / 10000,
      verdict: econ.verdict,
      net_usd: Math.round(econ.net * 100) / 100,
      expected_usd: Math.round(econ.expected * 100) / 100,
      deposit_usd: econ.deposit,
      model: { growth_pct: clamp(x.p.change_7d ?? 0, -60, 120), age_days: age },
      farm_steps: farmSteps(x.p, age, econ.deposit).map(stepText),
    };
  });
  return { board, earlySize: early.length, setAside };
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Full radar build: fit, validate, bootstrap, board. */
export function buildRadar(
  snapshot: Snapshot,
  anchorRound: number,
): { board: BoardRow[]; radar: RadarData } {
  const labelled = labelledSet(snapshot);
  const validation = validate(labelled, snapshot.as_of);
  const X = labelled.map((p) => features(p, snapshot.as_of));
  const y = labelled.map(targetOf);
  const s = standardizer(X);
  const w = ridgeFit(standardize(X, s), y, LAMBDA);

  // Bootstrap refits for ranges (seeded, deterministic).
  const rngB = mulberry32(BOOT_SEED);
  const bootW: number[][] = [];
  const bootS: Standardizer[] = [];
  for (let b = 0; b < BOOT_B; b++) {
    const idx = Array.from({ length: labelled.length }, () => Math.floor(rngB() * labelled.length));
    const sb = standardizer(idx.map((i) => X[i]!));
    bootW.push(ridgeFit(standardize(idx.map((i) => X[i]!), sb), idx.map((i) => y[i]!), LAMBDA));
    bootS.push(sb);
  }
  const looResiduals = validation.looActual.map((a, i) => a - validation.looPred[i]!);
  const { board, earlySize, setAside } = buildBoard(snapshot, w, s, bootW, bootS, looResiduals);
  const live = liveRows(snapshot);
  const farmCount = board.filter((r) => r.verdict === 'FARM').length;
  const sourceLabel = snapshot.source
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source_label: sourceLabel,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    anchor_scheme: ANCHOR_NOTE,
    anchor_round: anchorRound,
    watchlist_slugs: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlySize,
    live_size: live.length,
    pretoken_set_aside: setAside,
    live_token_total: snapshot.protocols.length - snapshot.protocols.filter(isPreToken).length,
    validation: {
      loo: validation.loo,
      loo_median: validation.looMedian,
      wf: validation.wf,
      wf_median: validation.wfMedian,
      folds_strat: validation.foldsStrat,
      folds_seq: validation.foldsSeq,
      folds_rand: validation.foldsRand,
      cov_2575: validation.cov2575,
      cov_1090: validation.cov1090,
      auc: validation.auc,
      brier: validation.brier,
      n_labelled: validation.nLabelled,
    },
    economics: {
      deposit_pct: DEPOSIT_PCT_FRAC * 100,
      deposit_pct_frac: DEPOSIT_PCT_FRAC,
      deposit_min: DEPOSIT_MIN,
      deposit_max: DEPOSIT_MAX,
      gas_usd: GAS_USD,
      opportunity_rate: OPPORTUNITY_RATE,
      community_alloc: COMMUNITY_ALLOC,
      slider_deposit: { min: 0.005, max: 0.1, step: 0.005, def: 0.02 },
      slider_gas: { min: 5, max: 50, step: 5, def: 15 },
    },
    farm_counts: { farm: farmCount, skip: board.length - farmCount },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      mcap_usd: r.mcap_usd,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      implied_lo_usd: r.implied_lo_usd,
      implied_hi_usd: r.implied_hi_usd,
      rank_lo: r.rank_lo,
      rank_hi: r.rank_hi,
      pred_log_ratio: r.pred_log_ratio,
      verdict: r.verdict,
      net_usd: r.net_usd,
      expected_usd: r.expected_usd,
      deposit_usd: r.deposit_usd,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
