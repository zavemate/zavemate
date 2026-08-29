import { describe, expect, it } from 'vitest';
import type { Card } from '@zavemate/schema';
import type { EvidenceGap } from '../apply.ts';
import type { LLMProvider } from '../llm.ts';
import { runRepairPass } from '../repair-pass.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

const NOW = '2026-08-22T00:00:00.000Z';

/** 假原文。修復 agent 要喺呢度逐字搵到佢提出嘅引文先算數。 */
const SOURCE_TEXT = '指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）。所有合資格簽賬享 20% 現金回贈。';

function gap(overrides: Partial<EvidenceGap> = {}): EvidenceGap {
  return {
    cardId: 'demo_card',
    ruleId: 'demo_card_online',
    sourceUrl: 'https://www.example-bank.com.hk/cards/demo',
    sourceText: SOURCE_TEXT,
    ...overrides,
  } as EvidenceGap;
}

function cards(): Map<string, Card> {
  return new Map([
    [
      'demo_card',
      card({ rewards: [rewardRule({ provenance: provenance({ evidence_excerpt: '呢句唔喺原文入面' }) })] }),
    ],
  ]);
}

/** 修復 agent 交咩答案。 */
function provider(data: unknown): LLMProvider {
  return {
    name: 'stub',
    async extractJson() {
      return { data, usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.002, model: 'stub' } };
    },
  };
}

const supported = (excerpt: string) => provider({ verdict: 'supported', excerpt, contradicting_excerpt: null, reasoning: '搵到' });

describe('runRepairPass', () => {
  it('提出嘅引文喺原文逐字搵到 → 自動改，唔開 question', async () => {
    const workingCards = cards();
    const result = await runRepairPass({
      gaps: [gap()],
      workingCards,
      provider: supported('指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）'),
      nowIso: NOW,
    });

    expect(result.repaired).toBe(1);
    expect(result.questions.size).toBe(0);

    const rule = workingCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.evidence_excerpt).toContain('指定商戶簽賬回贈 3.8%');
    expect(rule.provenance.confidence).toBe('official');
    expect(rule.provenance.last_verified_at).toBe(NOW);
  });

  it('數值一個字都唔可以郁——修復淨係換引文', async () => {
    const workingCards = cards();
    const before = structuredClone(workingCards.get('demo_card')!.rewards[0]!.reward);

    await runRepairPass({
      gaps: [gap()],
      workingCards,
      provider: supported('指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）'),
      nowIso: NOW,
    });

    expect(workingCards.get('demo_card')!.rewards[0]!.reward).toEqual(before);
  });

  it('作嘢（引文喺原文搵唔到）→ 當佢冇提議過，開 question 兼降 unconfirmed', async () => {
    // 呢個係「自動改可以唔經人」成立嘅唯一理由：LLM 講咩都要過機器驗證。
    const workingCards = cards();
    const result = await runRepairPass({
      gaps: [gap()],
      workingCards,
      provider: supported('呢句係作出嚟嘅，原文完全冇'),
      nowIso: NOW,
    });

    expect(result.repaired).toBe(0);
    expect(result.questions.size).toBe(1);
    expect(workingCards.get('demo_card')!.rewards[0]!.provenance.confidence).toBe('unconfirmed');
    // 冇改過段引文——寧願留住舊嗰句，都好過寫一句作嘅落去。
    expect(workingCards.get('demo_card')!.rewards[0]!.provenance.evidence_excerpt).toBe('呢句唔喺原文入面');
  });

  it('原文講緊另一個數 → value_conflict，唔係 evidence_absent', async () => {
    // 兩種 kind 嘅跟進方法唔同：value_conflict 要人判邊個啱，
    // evidence_absent 要人睇係數錯定係揀錯咗份文件。撈埋就冇一種會被解決。
    const result = await runRepairPass({
      gaps: [gap()],
      workingCards: cards(),
      provider: provider({
        verdict: 'unsupported',
        excerpt: null,
        contradicting_excerpt: '所有合資格簽賬享 20% 現金回贈',
        reasoning: '文件講 20% 唔係 4%',
      }),
      nowIso: NOW,
    });

    const question = [...result.questions.values()][0]!;
    expect(question.kind).toBe('value_conflict');
    expect(question.evidence).toContain('20%');
  });

  it('原文根本冇提過 → evidence_absent', async () => {
    const result = await runRepairPass({
      gaps: [gap()],
      workingCards: cards(),
      provider: provider({ verdict: 'absent', excerpt: null, contradicting_excerpt: null, reasoning: '冇提過' }),
      nowIso: NOW,
    });

    expect([...result.questions.values()][0]!.kind).toBe('evidence_absent');
  });

  it('叫唔到 LLM → 當修唔掂，唔好炸咗成個 run', async () => {
    // 一條 rule 修唔到，唔應該連其他卡今個星期嘅核實都一齊冇咗。
    const result = await runRepairPass({
      gaps: [gap()],
      workingCards: cards(),
      provider: {
        name: 'boom',
        async extractJson() {
          throw new Error('429 Too Many Requests');
        },
      },
      nowIso: NOW,
    });

    expect(result.repaired).toBe(0);
    expect([...result.questions.values()][0]!.kind).toBe('evidence_absent');
    expect(result.totalCostUsd).toBe(0);
  });

  it('question_id 係決定性嘅——同一條問題唔會開兩次', async () => {
    const twice = await runRepairPass({
      gaps: [gap(), gap()],
      workingCards: cards(),
      provider: provider({ verdict: 'absent', excerpt: null, contradicting_excerpt: null, reasoning: '冇提過' }),
      nowIso: NOW,
    });

    expect(twice.questions.size).toBe(1);
  });

  it('搵唔到嗰張卡／嗰條 rule → 跳過，唔 throw', async () => {
    const result = await runRepairPass({
      gaps: [gap({ cardId: '唔存在'}), gap({ ruleId: '唔存在' })],
      workingCards: cards(),
      provider: supported('指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）'),
      nowIso: NOW,
    });

    expect(result.repaired).toBe(0);
    expect(result.questions.size).toBe(0);
  });

  it('冇 gap → 乜都唔使做，一個 LLM call 都唔叫', async () => {
    const result = await runRepairPass({
      gaps: [],
      workingCards: cards(),
      provider: {
        name: 'poison',
        async extractJson() {
          throw new Error('唔應該叫到 LLM');
        },
      },
      nowIso: NOW,
    });

    expect(result).toMatchObject({ repaired: 0, totalCostUsd: 0 });
    expect(result.questions.size).toBe(0);
  });
});
