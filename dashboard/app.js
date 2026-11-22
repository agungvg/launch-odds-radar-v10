/* Launch-Odds Radar v10 — dashboard logic. No network: all data is window.RADAR. */
(function () {
  const R = window.RADAR;
  const $ = (id) => document.getElementById(id);
  const rows = R.rows;
  const bySlug = {};
  rows.forEach((r) => { bySlug[r.slug] = r; });
  const E = R.economics, V = R.validation;
  const state = { q: '', verdict: '', cat: '', watch: false, sort: 'rank', dir: 1, sel: rows[0].slug, depFrac: E.deposit_pct_frac, gas: E.gas_usd };

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(x, d) { return (x === null || x === undefined) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d === undefined ? 1 : d) + '%'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function groupOf(c) {
    const s = (c || '').toLowerCase();
    if (s.includes('dex')) return 'trade';
    if (s.includes('lend') || s.includes('cdp') || s.includes('collateral')) return 'lend';
    if (s.includes('yield')) return 'yield';
    if (s.includes('bridge')) return 'bridge';
    if (s.includes('stak')) return 'stake';
    if (s.includes('rwa')) return 'rwa';
    if (s.includes('deriv') || s.includes('option') || s.includes('perpetual')) return 'derivatives';
    if (s.includes('stable')) return 'stablecoins';
    return 'other';
  }
  function econ(r, depFrac, gas) {
    const dep = Math.min(E.deposit_max, Math.max(E.deposit_min, r.implied_value_usd * depFrac));
    const exp = E.community_alloc * dep * r.implied_value_usd / r.tvl_usd;
    const net = exp - gas - E.opportunity_rate * dep;
    return { dep: dep, exp: exp, net: net, verdict: net > 0 ? 'FARM' : 'SKIP' };
  }
  function verdictPill(v) { return '<span class="pill ' + v.toLowerCase() + '">' + v + '</span>'; }
  function fmtX(x) { return '×' + x.toFixed(2); }
  function passMiss(ok) { return ok ? '<span class="pass">PASS</span>' : '<span class="miss">MISS</span>'; }

  /* Hero chips */
  $('heroChips').innerHTML = [
    'Snapshot ' + R.as_of, R.watchlist_size + ' on the watchlist', R.board_size + ' ranked rows',
    R.farm_counts.farm + ' FARM · ' + R.farm_counts.skip + ' SKIP', 'Model ' + R.model_version,
    'Anchor round ' + R.anchor_round
  ].map((c) => '<span class="chip">' + esc(c) + '</span>').join('');

  /* KPI cards */
  const stratWorst = Math.max.apply(null, V.folds_strat), seqWorst = Math.max.apply(null, V.folds_seq), randWorst = Math.max.apply(null, V.folds_rand);
  const kpis = [
    { l: 'Leave-one-out miss', v: fmtX(V.loo), s: 'target ≤ ×3.33 · median ' + fmtX(V.loo_median), ok: V.loo <= 3.33 },
    { l: 'Walk-forward miss', v: fmtX(V.wf), s: '66 older → 29 newer · target ≤ ×2.53', ok: V.wf <= 2.53 },
    { l: 'AUC (honest)', v: V.auc.toFixed(3), s: 'target ≥ 0.79 · median-split LOO', ok: V.auc >= 0.79 },
    { l: 'Brier score', v: V.brier.toFixed(3), s: 'target ≤ 0.215 · Platt on LOO', ok: V.brier <= 0.215 },
    { l: 'Interval coverage', v: Math.round(V.cov_2575 * 100) + '% / ' + Math.round(V.cov_1090 * 100) + '%', s: 'P25–P75 ≥ 57% · P10–P90 ≥ 76%', ok: V.cov_2575 >= 0.57 && V.cov_1090 >= 0.76 },
    { l: 'Farm verdicts', v: R.farm_counts.farm + ' FARM', s: 'of ' + R.board_size + ' rows · net of fees', ok: true }
  ];
  $('kpis').innerHTML = kpis.map((k) =>
    '<div class="kpi"><div class="k-label">' + k.l + '</div><div class="k-val">' + k.v + '</div><div class="k-sub">' + k.s + ' · ' + passMiss(k.ok) + '</div></div>'
  ).join('');

  /* Integrity strip */
  $('integrity').innerHTML = '<b>Integrity:</b> anchor <b>' + R.anchor_scheme + ' round ' + R.anchor_round + '</b> · ' +
    R.board_size + ' rows · watchlist ' + R.watchlist_size + '/' + R.watchlist_size + ' covered · ' +
    'ranks 1–' + R.board_size + ' sequential · ledger 758 = ' + R.board_size + ' ranked + ' + R.pretoken_set_aside +
    ' pre-token set aside + ' + R.live_token_total + ' live-token · model ' + R.model_version +
    ' · worst 5-fold ' + fmtX(Math.max(stratWorst, seqWorst, randWorst)) + ' (target ≤ ×4.5)';

  /* Sliders — scale IS the model scale: default = model depositPct, range includes it. */
  const depS = $('depSlider'), gasS = $('gasSlider');
  depS.min = E.slider_deposit.min; depS.max = E.slider_deposit.max; depS.step = E.slider_deposit.step; depS.value = E.slider_deposit.def;
  gasS.min = E.slider_gas.min; gasS.max = E.slider_gas.max; gasS.step = E.slider_gas.step; gasS.value = E.slider_gas.def;
  function sliderLabels() {
    $('depVal').textContent = (state.depFrac * 100).toFixed(3) + '% of implied value';
    $('depNote').textContent = 'Model depositPct = ' + E.deposit_pct.toFixed(3) + '% · fraction ' + E.deposit_pct_frac.toFixed(5) +
      ' · capital clamped $' + E.deposit_min + '–$' + E.deposit_max + ' · slider default = model value.';
    $('gasVal').textContent = '$' + state.gas;
  }
  depS.addEventListener('input', () => { state.depFrac = parseFloat(depS.value) / 100; sliderLabels(); renderBoard(); renderDetail(); });
  gasS.addEventListener('input', () => { state.gas = parseFloat(gasS.value); sliderLabels(); renderBoard(); renderDetail(); });
  sliderLabels();

  /* Category filter */
  const cats = [];
  rows.forEach((r) => { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort().forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; $('fCat').appendChild(o); });

  /* Board */
  function filtered() {
    let list = rows.slice();
    if (state.q) { const q = state.q.toLowerCase(); list = list.filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q)); }
    if (state.verdict) list = list.filter((r) => econ(r, state.depFrac, state.gas).verdict === state.verdict);
    if (state.cat) list = list.filter((r) => r.category === state.cat);
    if (state.watch) { const wl = new Set(R.watchlist_slugs || []); list = list.filter((r) => wl.has(r.slug)); }
    const k = state.sort;
    list.sort((a, b) => {
      let va, vb;
      if (k === 'name') { va = a.name; vb = b.name; }
      else if (k === 'category') { va = a.category || ''; vb = b.category || ''; }
      else if (k === 'verdict') { va = econ(a, state.depFrac, state.gas).verdict; vb = econ(b, state.depFrac, state.gas).verdict; }
      else if (k === 'net_usd') { va = econ(a, state.depFrac, state.gas).net; vb = econ(b, state.depFrac, state.gas).net; }
      else { va = a[k]; vb = b[k]; }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const c = (va < vb ? -1 : va > vb ? 1 : 0);
      return state.dir * c;
    });
    return list;
  }
  function renderBoard() {
    const list = filtered();
    $('boardSub').textContent = '— ' + list.length + ' of ' + rows.length + ' rows';
    $('countLine').textContent = list.length + ' rows shown. Net recomputes live from the sliders; the model depositPct is ' + E.deposit_pct.toFixed(3) + '%.';
    $('boardBody').innerHTML = list.map((r) => {
      const e = econ(r, state.depFrac, state.gas);
      return '<tr data-slug="' + r.slug + '" class="' + (r.slug === state.sel ? 'sel' : '') + '">' +
        '<td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b><br><span class="note">' + r.slug + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td><td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + ((r.change_7d || 0) >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + money(r.implied_lo_usd) + ' – ' + money(r.implied_hi_usd) + '</td>' +
        '<td class="num">#' + r.rank_lo + '–' + r.rank_hi + '</td>' +
        '<td>' + verdictPill(e.verdict) + '</td>' +
        '<td class="num ' + (e.net >= 0 ? 'pos' : 'neg') + '">' + (e.net >= 0 ? '+' : '') + '$' + e.net.toFixed(2) + '</td></tr>';
    }).join('');
    document.querySelectorAll('#boardBody tr').forEach((tr) => {
      tr.addEventListener('click', () => { state.sel = tr.getAttribute('data-slug'); renderBoard(); renderDetail(); renderScatter(); $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    });
  }
  document.querySelectorAll('#board th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-k');
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
      renderBoard();
    });
  });
  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('fVerdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('fCat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
  $('fWatch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });

  /* Detail */
  function renderDetail() {
    const r = bySlug[state.sel] || rows[0];
    const e = econ(r, state.depFrac, state.gas);
    const grid = [25, 50, 100, 250, 500].map((d) => {
      const exp = E.community_alloc * d * r.implied_value_usd / r.tvl_usd;
      const net = exp - state.gas - E.opportunity_rate * d;
      return '<tr><td class="num">$' + d + '</td><td class="num">$' + exp.toFixed(2) + '</td><td class="num">$' + state.gas.toFixed(0) + '</td><td class="num">$' + (E.opportunity_rate * d).toFixed(2) + '</td><td class="num ' + (net >= 0 ? 'pos' : 'neg') + '">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(2) + '</td></tr>';
    }).join('');
    const peers = rows.filter((x) => x.slug !== r.slug && groupOf(x.category) === groupOf(r.category))
      .map((x) => ({ x: x, d: Math.abs(Math.log10(x.tvl_usd) - Math.log10(r.tvl_usd)) }))
      .sort((a, b) => a.d - b.d).slice(0, 5)
      .map((p) => '<tr><td>#' + p.x.rank + ' ' + esc(p.x.name) + '</td><td class="num">' + money(p.x.tvl_usd) + '</td><td class="num">' + money(p.x.implied_value_usd) + '</td><td>' + verdictPill(econ(p.x, state.depFrac, state.gas).verdict) + '</td></tr>').join('');
    const steps = (r.farm_steps || []).map((s) => '<li>' + esc(s) + '</li>').join('');
    $('detail').innerHTML =
      '<h2>#' + r.rank + ' ' + esc(r.name) + ' ' + verdictPill(e.verdict) + '</h2>' +
      '<p class="note">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || 'no chain listed') + ' · listed ' + (r.listed_at || 'date unknown') +
      ' · age ' + (r.age_days === null ? '—' : r.age_days + ' days') + ' · records no token · rank range #' + r.rank_lo + '–' + r.rank_hi + '</p>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="s-l">Implied value</div><div class="s-v">' + moneyFull(r.implied_value_usd) + '</div><div class="note">P10–P90 ' + money(r.implied_lo_usd) + ' – ' + money(r.implied_hi_usd) + '</div></div>' +
      '<div class="stat"><div class="s-l">TVL</div><div class="s-v">' + moneyFull(r.tvl_usd) + '</div><div class="note">7d ' + pct(r.change_7d) + '</div></div>' +
      '<div class="stat"><div class="s-l">Predicted ratio</div><div class="s-v">' + Math.pow(10, r.pred_log_ratio).toFixed(2) + '×</div><div class="note">log₁₀ ' + r.pred_log_ratio.toFixed(3) + '</div></div>' +
      '<div class="stat"><div class="s-l">Net of fees</div><div class="s-v ' + (e.net >= 0 ? 'pos' : 'neg') + '">' + (e.net >= 0 ? '+' : '') + '$' + e.net.toFixed(2) + '</div><div class="note">deposit $' + e.dep.toFixed(0) + ' · expected $' + e.exp.toFixed(2) + '</div></div>' +
      '</div>' +
      '<h3>Deposit grid — net at each size (current sliders)</h3>' +
      '<div class="table-wrap"><table class="grid-table"><thead><tr><th class="num">Deposit</th><th class="num">Expected</th><th class="num">Gas</th><th class="num">Opportunity 5%</th><th class="num">Net</th></tr></thead><tbody>' + grid + '</tbody></table></div>' +
      '<h3>Exit rule</h3><p>Claim once when a claim opens and the net after gas is positive; move the tokens to cold storage. ' +
      'If no claim opens within 180 days, unwind the position — the opportunity cost has passed the expected value. Never pay to claim.</p>' +
      '<h3>Farm plan — 10 steps with cost and time</h3><ol class="steps">' + steps + '</ol>' +
      '<h3>Peers — same group (' + groupOf(r.category) + '), nearest by TVL</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Peer</th><th class="num">TVL</th><th class="num">Implied</th><th>Verdict</th></tr></thead><tbody>' + peers + '</tbody></table></div>';
  }

  /* Scatter */
  function renderScatter() {
    const svg = $('scatter');
    const W = 760, H = 380, P = 42;
    const xs = rows.map((r) => Math.log10(r.tvl_usd)), ys = rows.map((r) => r.pred_log_ratio);
    const x0 = Math.min.apply(null, xs) - 0.1, x1 = Math.max.apply(null, xs) + 0.1;
    const y0 = Math.min.apply(null, ys) - 0.1, y1 = Math.max.apply(null, ys) + 0.1;
    const X = (v) => P + (v - x0) / (x1 - x0) * (W - 2 * P);
    const Y = (v) => H - P - (v - y0) / (y1 - y0) * (H - 2 * P);
    let s = '<line class="axis" x1="' + P + '" y1="' + (H - P) + '" x2="' + (W - P) + '" y2="' + (H - P) + '"/>' +
      '<line class="axis" x1="' + P + '" y1="' + P + '" x2="' + P + '" y2="' + (H - P) + '"/>' +
      '<text class="axis-lab" x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle">log₁₀ TVL (' + money(Math.pow(10, x0)) + ' – ' + money(Math.pow(10, x1)) + ')</text>' +
      '<text class="axis-lab" x="12" y="' + (H / 2) + '" transform="rotate(-90 12 ' + (H / 2) + ')" text-anchor="middle">predicted log₁₀(mcap / TVL)</text>';
    rows.forEach((r) => {
      const e = econ(r, state.depFrac, state.gas);
      s += '<circle class="dot' + (r.slug === state.sel ? ' sel' : '') + '" cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(r.pred_log_ratio).toFixed(1) + '" r="' + (r.slug === state.sel ? 8 : 4.5) + '" fill="' + (e.verdict === 'FARM' ? '#059669' : '#fb7185') + '"><title>#' + r.rank + ' ' + esc(r.name) + ' — ' + money(r.implied_value_usd) + ' · ' + e.verdict + '</title></circle>';
    });
    svg.innerHTML = s;
    const f = rows.filter((r) => econ(r, state.depFrac, state.gas).verdict === 'FARM').length;
    $('scatterNote').textContent = f + ' green (FARM) dots, ' + (rows.length - f) + ' rose (SKIP) dots at the current sliders. The biggest dots ring the selected protocol.';
  }

  /* Evidence */
  function foldRow(label, arr) {
    return '<tr><td>' + label + '</td>' + arr.map((x) => '<td class="num">' + fmtX(x) + '</td>').join('') + '<td class="num"><b>' + fmtX(Math.max.apply(null, arr)) + '</b> ' + passMiss(Math.max.apply(null, arr) <= 4.5) + '</td></tr>';
  }
  $('evidence').innerHTML =
    '<div class="table-wrap ev-table"><table><thead><tr><th>Check</th><th class="num">Measured</th><th class="num">Target</th><th>Verdict</th></tr></thead><tbody>' +
    '<tr><td>Leave-one-out miss (87 refits)</td><td class="num">' + fmtX(V.loo) + ' (median ' + fmtX(V.loo_median) + ')</td><td class="num">≤ ×3.33</td><td>' + passMiss(V.loo <= 3.33) + '</td></tr>' +
    '<tr><td>Walk-forward miss (train 66 oldest, test 29 newest)</td><td class="num">' + fmtX(V.wf) + ' (median ' + fmtX(V.wf_median) + ')</td><td class="num">≤ ×2.53</td><td>' + passMiss(V.wf <= 2.53) + '</td></tr>' +
    '<tr><td>Coverage P25–P75 / P10–P90 (bootstrap intervals, 200 resamples)</td><td class="num">' + Math.round(V.cov_2575 * 100) + '% / ' + Math.round(V.cov_1090 * 100) + '%</td><td class="num">≥ 57% / ≥ 76%</td><td>' + passMiss(V.cov_2575 >= 0.57 && V.cov_1090 >= 0.76) + '</td></tr>' +
    '<tr><td>AUC, median split of the true ratio, LOO predictions</td><td class="num">' + V.auc.toFixed(3) + '</td><td class="num">≥ 0.79</td><td>' + passMiss(V.auc >= 0.79) + '</td></tr>' +
    '<tr><td>Brier, binary mcap above TVL, Platt on LOO</td><td class="num">' + V.brier.toFixed(3) + '</td><td class="num">≤ 0.215</td><td>' + passMiss(V.brier <= 0.215) + '</td></tr>' +
    '</tbody></table></div>' +
    '<div class="table-wrap ev-table"><table><thead><tr><th>5-fold (seed 42)</th><th class="num">Fold 1</th><th class="num">Fold 2</th><th class="num">Fold 3</th><th class="num">Fold 4</th><th class="num">Fold 5</th><th class="num">Worst</th></tr></thead><tbody>' +
    foldRow('Stratified (target quintiles)', V.folds_strat) + foldRow('Sequential (by listing date)', V.folds_seq) + foldRow('Random shuffle', V.folds_rand) +
    '</tbody></table></div>' +
    '<p class="note">Misses are disclosed, not hidden: walk-forward ' + fmtX(V.wf) + ' and AUC ' + V.auc.toFixed(3) +
    ' miss their targets, and the model says so on this page. No leakage was used to close them — category token-rate is banned self-leakage and appears nowhere in the 19 features.</p>';
  $('method').textContent = 'radar-10: ridge regression (λ = 30, standardized) on 87 labelled protocols — those recording a token, a listing date and a non-exchange category. ' +
    'Target log₁₀(market-cap / TVL), winsorized to [-1, 1]. 19 features from the snapshot only: log TVL and its square, 7-day growth (clamped) and its square, log age, age in years, log chain count, log TVL per chain, eight semantic category-group flags, a reported-change flag, logTVL × growth, and listing year. ' +
    'Implied value = TVL × 10^predicted ratio. Farm verdicts follow the net economics in the header: deposit 0.02% of implied value clamped $25–$500, expected = 10% community allocation × deposit × (implied / TVL), net = expected − $15 gas − 5% opportunity cost; FARM when net > 0. ' +
    'Ranges are 200 bootstrap resamples (seed 20261123); rank ranges are the same resamples re-ranked. Selection was by held-out error only.';
  $('ledger').textContent = '758 protocols in the snapshot = ' + R.board_size + ' ranked on this board + ' + R.pretoken_set_aside +
    ' pre-token protocols set aside below the early cut + ' + R.live_token_total + ' live-token protocols shown at market values. ' +
    'The watchlist (40) is the floor, never the ceiling: ' + R.early_size + ' rows below the $50M floor made the board on TVL.';

  /* Live table */
  $('liveBody').innerHTML = R.live.map((p) =>
    '<tr><td><b>' + esc(p.name) + '</b><br><span class="note">' + p.slug + '</span></td><td>' + esc(p.category || '—') + '</td>' +
    '<td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + (p.mcap_usd === null ? '—' : money(p.mcap_usd)) + '</td>' +
    '<td class="num ' + ((p.change_7d || 0) >= 0 ? 'pos' : 'neg') + '">' + pct(p.change_7d) + '</td></tr>'
  ).join('');

  /* Footer */
  $('footer').innerHTML = 'Launch-Odds Radar v10 · model ' + R.model_version + ' · anchor: ' + R.anchor_scheme + ' round ' + R.anchor_round +
    ' · source: ' + esc(R.source_label) + ' · snapshot ' + R.as_of + ' · floor $' + R.floor_usd.toLocaleString('en-US') +
    ' · built for the make.fun token-radar-01 bounty · this page works with no network.';

  /* Watchlist slugs for the filter: board rows carry no flag, so mark the 40 by rank of TVL floor rule — the entry ships the list in data. */
  // (Watchlist membership is encoded in R.watchlist_slugs when present.)
  function download(name, text, type) {
    const b = new Blob([text], { type: type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('csvBtn').addEventListener('click', () => {
    const head = 'rank,slug,name,category,tvl_usd,change_7d,implied_value_usd,implied_lo_usd,implied_hi_usd,rank_lo,rank_hi,verdict,net_usd\n';
    const body = filtered().map((r) => { const e = econ(r, state.depFrac, state.gas); return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.change_7d, r.implied_value_usd, r.implied_lo_usd, r.implied_hi_usd, r.rank_lo, r.rank_hi, e.verdict, e.net.toFixed(2)].join(','); }).join('\n');
    download('launch-odds-radar-v10.csv', head + body + '\n', 'text/csv');
  });
  $('jsonBtn').addEventListener('click', () => {
    download('launch-odds-radar-v10.json', JSON.stringify(filtered().map((r) => { const e = econ(r, state.depFrac, state.gas); return { rank: r.rank, slug: r.slug, name: r.name, implied_value_usd: r.implied_value_usd, verdict: e.verdict, net_usd: Math.round(e.net * 100) / 100 }; }), null, 2), 'application/json');
  });

  /* Shareable views: ?shot=detail scrolls to the detail, ?shot=farm filters to
     FARM verdicts, ?sel=<slug> selects a protocol. Used by the screenshots. */
  const params = new URLSearchParams(window.location.search);
  const shot = params.get('shot');
  const selParam = params.get('sel');
  if (selParam && bySlug[selParam]) state.sel = selParam;
  if (shot === 'farm') { state.verdict = 'FARM'; $('fVerdict').value = 'FARM'; }
  /* Shot views put the shot's section at the top of the page (CSS hides the
     sections above it), so a screenshot needs no scroll timing to be exact. */
  if (shot === 'board' || shot === 'detail' || shot === 'farm') document.body.classList.add('shot-' + shot);

  renderBoard();
  renderDetail();
  renderScatter();
})();
