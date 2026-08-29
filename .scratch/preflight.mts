import { fetchSource, evidenceSupportedBy, sha256 } from '../packages/core/src/index.ts';
import { readFileSync } from 'node:fs';
const plan: Array<[string, string]> = [
  ['sc_cathay_mastercard_priority', 'https://av.sc.com/hk/content/docs/hk-cx-t1-tnc.pdf'],
  ['sc_cathay_mastercard_priority_private', 'https://av.sc.com/hk/content/docs/hk-cx-t2-tnc.pdf'],
  ['sc_simply_cash_visa', 'https://av.sc.com/hk/zh/content/docs/hk-promo-simply-cash-tnc-noc.pdf'],
];
for (const [cardId, url] of plan) {
  const d = JSON.parse(readFileSync(`data/cards/${cardId}.json`, 'utf8'));
  const body = (await fetchSource(url, 'pdf')).content;
  console.log(`\n══ ${cardId}\n   → ${url}\n   hash ${sha256(body).slice(0, 16)}…  ${body.length} 字元`);
  for (const r of d.rewards) {
    const ok = evidenceSupportedBy(body, r.provenance.evidence_excerpt);
    console.log(`   ${ok ? '✓' : '✗'} ${r.rule_id}  rate/mile=${r.reward.rate ?? r.reward.hkd_per_mile}`);
    if (!ok) console.log(`       evidence: ${String(r.provenance.evidence_excerpt).slice(0, 110)}`);
  }
}
