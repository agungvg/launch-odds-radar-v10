# Launch-Odds Radar v10

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v10/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v10/reward.svg)](https://make.fun/bounty/token-radar-01)

**Which pre-token protocol is worth farming next — ranked by what its launch would be worth, with the steps to farm it.**

Launch-Odds Radar v10 is an entry in the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01). It reads the sealed snapshot of 758 protocols, learns how a token's market cap relates to its protocol's TVL from the 87 protocols that record a token, and ranks 198 pre-token protocols (the 40-protocol watchlist plus the 158 largest pre-token protocols below the $50M floor) by implied launch value. Every row carries a 10-step farm plan with cost and time, a net-of-fees FARM/SKIP verdict, bootstrap value and rank ranges, and a deposit grid with an exit rule.

Referral: `p9r33tb4`

## The model (radar-10)

- Target: log10(market-cap / TVL), winsorized to [-1, 1] (0.1x–10x).
- Fit: ridge regression, λ = 30, standardized features, chosen by held-out error only.
- Features: 19 numbers from the snapshot's own fields — log TVL and its square, 7-day growth (clamped) and its square, log age, age in years, log chain count, log TVL per chain, eight semantic category-group flags, a reported-change flag, logTVL × growth, and listing year. Category token-rate is banned self-leakage and appears nowhere.
- Farm economics: deposit 0.02% of implied value clamped $25–$500; expected airdrop = 10% community allocation × deposit × (implied / TVL); net = expected − $15 gas − 5% opportunity cost. FARM when net > 0.

## Measured validation (printed by the program at runtime)

- Leave-one-out miss ×2.658 (target ≤ ×3.33) — PASS
- Walk-forward miss ×2.848, 66 older → 29 newer (target ≤ ×2.53) — MISS, disclosed
- 5-fold worst: stratified ×3.003, sequential ×3.868, random ×3.252 (target ≤ ×4.5) — PASS
- Coverage P25–P75 57.5% (≥ 57%), P10–P90 90.8% (≥ 76%) — PASS
- AUC 0.692 (target ≥ 0.79) — MISS, disclosed; Brier 0.183 (≤ 0.215) — PASS
- Farm verdicts: 36 FARM / 162 SKIP, net −$33.90 to +$84.64

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22 or later, standard library only. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory. It is deterministic: the same snapshot in gives the same bytes out.

## Layout

- `main.ts` — entrypoint; anchor is the drand quicknet round from `makefun init`.
- `lib/model.ts` — the radar-10 model, validation, board build and farm plans.
- `dashboard/` — the static page (light theme, no network): board, detail view, filters, sliders, CSV/JSON export, peers, scatter, evidence tables.
- `screenshots/` — the board, a protocol's detail view and a FARM-filtered view (1280×800).
- `vendor/makefun-board.ts` — the kit's dossier library, as shipped.
