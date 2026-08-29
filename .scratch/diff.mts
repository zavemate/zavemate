import { fetchSource } from '../packages/core/src/index.ts';
const docs: Record<string, string> = {};
for (const f of ['t0', 't1', 't2']) {
  docs[f] = (await fetchSource(`https://av.sc.com/hk/content/docs/hk-cx-${f}-tnc.pdf`, 'pdf')).content;
}
// 逐句切開，搵只出現喺其中一份嘅句
const sents = (t: string) => new Set(t.split(/(?<=\.)\s+|\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 25));
const S = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, sents(v)]));
for (const k of ['t0', 't1', 't2']) {
  const others = ['t0', 't1', 't2'].filter((x) => x !== k).flatMap((x) => [...S[x]!]);
  const uniq = [...S[k]!].filter((s) => !others.includes(s));
  console.log(`\n══ ${k} 獨有 ${uniq.length} 句`);
  for (const s of uniq.slice(0, 6)) console.log('   •', s.slice(0, 170));
}
