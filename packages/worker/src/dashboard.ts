/**
 * `GET /dashboard` —— 睇住而家出咗街嘅係咩。
 *
 * 點解由 Worker 出而唔係一個獨立頁：**同源**。`/v1/*` 冇出 CORS header，
 * 所以任何第三方頁面（本機 HTML、artifact、另一個網域）都讀唔到啲資料。
 * 由 Worker 自己出，個 dashboard 就 fetch 得返自己屋企啲 endpoint，
 * 唔使為咗睇一眼而開 CORS——開咗就係對全世界開。
 *
 * 揀 `/v1/snapshot/{version}/full.json` 而唔係 `/v1/latest` 俾嘅
 * `urls.full`：後者指住 `data.zavemate.com`（另一個 origin，一樣冇 CORS）。
 *
 * 呢頁淨係讀，冇任何寫入。所有資料本身已經係公開 API，所以擺出嚟冇多咗
 * 任何 exposure。
 */

const PAGE = String.raw`<!doctype html>
<html lang="zh-HK">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Zavemate — 出咗街嘅資料</title>
<style>
  :root {
    --bg: #f4f5f6; --surface: #fff; --ink: #14181c; --muted: #5b646c; --faint: #8b949c;
    --rule: #dcdfe2; --accent: #0e5460; --ok: #2c7a57; --warn: #8f6412; --bad: #a33a2e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1317; --surface: #161b20; --ink: #e3e7ea; --muted: #98a2aa; --faint: #6d7880;
      --rule: #262e35; --accent: #58b6c6; --ok: #63be92; --warn: #d2a44a; --bad: #e0796d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, "PingFang HK", "Noto Sans HK", "Microsoft JhengHei", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 80px; }
  code, .m { font-family: ui-monospace, "SF Mono", Menlo, monospace; }

  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
  .ver { font-family: ui-monospace, monospace; font-size: 13px; color: var(--accent); }
  .when { font-size: 12.5px; color: var(--faint); margin-left: auto; }
  button {
    font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 3px;
    border: 1px solid var(--rule); background: var(--surface); color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }

  .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(122px,1fr)); gap: 1px;
    background: var(--rule); border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; margin-bottom: 22px; }
  .cell { background: var(--surface); padding: 12px 14px; }
  .cell .k { font-family: ui-monospace, monospace; font-size: 10px; letter-spacing: .09em;
    text-transform: uppercase; color: var(--faint); display: block; }
  .cell .v { font-family: ui-monospace, monospace; font-size: 20px; font-variant-numeric: tabular-nums; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }

  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .bar .sp { margin-left: auto; font-size: 12.5px; color: var(--faint); }

  .card { background: var(--surface); border: 1px solid var(--rule); border-radius: 3px; margin-bottom: 14px; }
  .card > h2 { font-size: 15px; margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--rule);
    display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .card > h2 .id { font-family: ui-monospace, monospace; font-size: 12px; color: var(--faint); }
  .card > h2 .n { margin-left: auto; font-size: 12px; color: var(--muted); font-weight: 400; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-family: ui-monospace, monospace; font-weight: 500; font-size: 10px;
    letter-spacing: .08em; text-transform: uppercase; color: var(--faint);
    padding: 9px 10px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  td { padding: 9px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .sub { font-size: 11.5px; color: var(--faint); }
  .num { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .pill { display: inline-block; font-family: ui-monospace, monospace; font-size: 10.5px;
    padding: 1px 6px; border-radius: 2px; border: 1px solid currentColor; white-space: nowrap; }
  a { color: var(--accent); }
  .scroll { overflow-x: auto; }
  .empty { padding: 40px 16px; text-align: center; color: var(--faint); }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>出咗街嘅資料</h1>
    <span class="ver" id="ver">…</span>
    <span class="when" id="when"></span>
  </header>

  <div class="strip" id="strip"></div>

  <div class="bar">
    <button id="f-all" aria-pressed="true">全部</button>
    <button id="f-unconfirmed" aria-pressed="false">淨係 unconfirmed</button>
    <button id="f-stale" aria-pressed="false">淨係過期</button>
    <button id="reload">重新載入</button>
    <span class="sp" id="tick"></span>
  </div>

  <div id="body"><div class="empty">載入緊…</div></div>
</div>

<script>
const STALE_DAYS = 14;
let snapshot = null, status = null, filter = 'all';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const daysSince = (iso) => iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;

function ago(iso) {
  if (!iso) return '從未';
  const d = daysSince(iso);
  if (d < 1) return Math.max(1, Math.round(d * 24)) + ' 小時前';
  return Math.round(d) + ' 日前';
}

/** 一條 rule 值唔值得你留意。呢個判斷就係成個 dashboard 嘅重點。 */
function ruleFlags(p) {
  return {
    stale: daysSince(p.last_verified_at) > STALE_DAYS,
    unconfirmed: p.confidence !== 'official',
    broken: (p.check_fail_count ?? 0) > 0,
  };
}

function confPill(c) {
  const cls = c === 'official' ? 'ok' : c === 'crowdsourced' ? 'warn' : 'bad';
  return '<span class="pill ' + cls + '">' + esc(c) + '</span>';
}

function rewardText(r) {
  if (!r) return '—';
  if (r.rate != null) return (r.rate * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  if (r.multiplier != null) return r.multiplier + '×';
  if (r.hkd_per_mile != null) return 'HK$' + r.hkd_per_mile + '/里';
  if (r.bonus_amount != null) return '$' + r.bonus_amount;
  return esc(r.type ?? '—');
}

function renderStrip() {
  const s = status ?? {};
  const cells = [
    ['version', s.version ?? '—', '', 'ac'],
    ['rules', s.rules ?? '—', '', s.rules ? 'ok' : ''],
    ['過期 rule', s.stale_rules ?? '—', '超過 ' + STALE_DAYS + ' 日冇核實', s.stale_rules ? 'bad' : 'ok'],
    ['unconfirmed', s.unconfirmed_rules ?? '—', '出處撐唔實', s.unconfirmed_rules ? 'warn' : 'ok'],
    ['promotions', snapshot?.coverage?.promotions ?? '—', '', ''],
    ['健康', s.healthy ? 'yes' : 'NO', '', s.healthy ? 'ok' : 'bad'],
  ];
  document.getElementById('strip').innerHTML = cells.map(([k, v, note, cls]) =>
    '<div class="cell"><span class="k">' + esc(k) + '</span>' +
    '<span class="v ' + cls + '">' + esc(v) + '</span>' +
    (note ? '<span class="sub">' + esc(note) + '</span>' : '') + '</div>').join('');

  document.getElementById('ver').textContent = s.version ? '@ ' + s.version : '';
  document.getElementById('when').textContent = snapshot?.generated_at
    ? 'snapshot 產出於 ' + new Date(snapshot.generated_at).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong', hour12: false }) + ' HKT'
    : '';
}

function ruleRow(rule) {
  const p = rule.provenance ?? {};
  const f = ruleFlags(p);
  const host = (() => { try { return new URL(p.source_url).hostname.replace(/^www\./, ''); } catch { return '—'; } })();
  return '<tr data-unconfirmed="' + f.unconfirmed + '" data-stale="' + f.stale + '">' +
    '<td><div>' + esc(rule.label) + '</div><div class="sub m">' + esc(rule.rule_id) + '</div></td>' +
    '<td class="num">' + rewardText(rule.reward) + '</td>' +
    '<td>' + confPill(p.confidence) + (f.broken ? ' <span class="pill bad">fail×' + p.check_fail_count + '</span>' : '') + '</td>' +
    '<td class="num ' + (f.stale ? 'bad' : '') + '">' + esc(ago(p.last_verified_at)) + '</td>' +
    '<td>' + (p.source_url ? '<a href="' + esc(p.source_url) + '" rel="noopener noreferrer" target="_blank">' + esc(host) + '</a>' : '—') + '</td>' +
    '</tr>';
}

function promoRow(promo) {
  const p = promo.provenance ?? {};
  const f = ruleFlags(p);
  const ends = promo.end_date ?? '冇講';
  const endingSoon = promo.end_date && daysSince(promo.end_date) > -14;
  return '<tr data-unconfirmed="' + f.unconfirmed + '" data-stale="false">' +
    '<td><div>' + esc(promo.title) + '</div><div class="sub m">' + esc(promo.promotion_id) + '</div></td>' +
    '<td class="num">' + rewardText(promo.reward) + '</td>' +
    '<td>' + confPill(p.confidence) + (promo.requires_registration ? ' <span class="pill warn">要登記</span>' : '') + '</td>' +
    '<td class="num ' + (endingSoon ? 'warn' : '') + '">' + esc(promo.start_date ?? '?') + ' → ' + esc(ends) + '</td>' +
    '<td>' + (p.source_url ? '<a href="' + esc(p.source_url) + '" rel="noopener noreferrer" target="_blank">睇出處</a>' : '—') + '</td>' +
    '</tr>';
}

function renderCards() {
  const cards = snapshot?.cards ?? [];
  if (cards.length === 0) { document.getElementById('body').innerHTML = '<div class="empty">冇資料</div>'; return; }

  document.getElementById('body').innerHTML = cards.map((card) => {
    const promos = card.promotions ?? [];
    const rules = card.rewards ?? [];
    return '<section class="card">' +
      '<h2>' + esc(card.card_name) + ' <span class="id">' + esc(card.card_id) + '</span>' +
      '<span class="n">' + rules.length + ' 條 rule · ' + promos.length + ' 個限時優惠</span></h2>' +
      '<div class="scroll"><table>' +
      '<thead><tr><th>條款</th><th>回贈</th><th>出處性質</th><th>核實 / 期間</th><th>來源</th></tr></thead>' +
      '<tbody>' + rules.map(ruleRow).join('') + promos.map(promoRow).join('') + '</tbody>' +
      '</table></div></section>';
  }).join('');
  applyFilter();
}

function applyFilter() {
  for (const tr of document.querySelectorAll('tbody tr')) {
    const show = filter === 'all'
      || (filter === 'unconfirmed' && tr.dataset.unconfirmed === 'true')
      || (filter === 'stale' && tr.dataset.stale === 'true');
    tr.classList.toggle('hidden', !show);
  }
  for (const section of document.querySelectorAll('section.card')) {
    const any = [...section.querySelectorAll('tbody tr')].some((tr) => !tr.classList.contains('hidden'));
    section.classList.toggle('hidden', !any);
  }
}

async function load() {
  document.getElementById('tick').textContent = '載入緊…';
  try {
    status = await (await fetch('/v1/status', { cache: 'no-store' })).json();
    const res = await fetch('/v1/snapshot/' + status.version + '/full.json');
    snapshot = await res.json();
    renderStrip();
    renderCards();
    document.getElementById('tick').textContent = '更新於 ' +
      new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Hong_Kong', hour12: false });
  } catch (err) {
    document.getElementById('body').innerHTML = '<div class="empty">讀唔到：' + esc(err.message) + '</div>';
    document.getElementById('tick').textContent = '';
  }
}

for (const [id, mode] of [['f-all', 'all'], ['f-unconfirmed', 'unconfirmed'], ['f-stale', 'stale']]) {
  document.getElementById(id).addEventListener('click', () => {
    filter = mode;
    for (const b of ['f-all', 'f-unconfirmed', 'f-stale']) {
      document.getElementById(b).setAttribute('aria-pressed', String(b === id));
    }
    applyFilter();
  });
}
document.getElementById('reload').addEventListener('click', load);

load();
// /v1/status 好平（一個 KV read + 一個 R2 read），一分鐘一次唔會有壓力。
setInterval(load, 60000);
</script>
</body>
</html>`;

export function dashboardResponse(): Response {
  return new Response(PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 頁面本身係靜態嘅，但佢入面 fetch 嘅資料唔係——所以頁面快取得，
      // 資料新鮮度由 /v1/status 自己個 cache-control 話事。
      'cache-control': 'public, max-age=300',
      'x-robots-tag': 'noindex',
    },
  });
}
