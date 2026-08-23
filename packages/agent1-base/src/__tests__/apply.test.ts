import { FetchError } from '@zavemate/core';
import { describe, expect, it } from 'vitest';
import { applyWork } from '../apply.ts';
import type { SourceWork } from '../scan.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

const NOW = '2026-08-22T00:00:00.000Z';

/**
 * 假嘅「份文件原文」。applyWork 而家會驗 evidence_excerpt 撐唔撐得住——
 * 每句測試用嘅 evidence 都要喺呢度出現，否則會被降做 unconfirmed。
 */
const SOURCE = [
  '本卡網上簽賬回贈 4%，其他簽賬另計。',
  '由 2026 年 12 月 1 日起，網上簽賬回贈 4% 變咗 3.8%。',
  '網上簽賬回贈 3.8%（2026 年 12 月 1 日起生效）。',
  '網上簽賬回贈每月上限 $10,000。',
  '本行公布：上限降至 $8,000。',
  '4% 回贈適用於指定類別。',
].join('\n');


function makeWork(overrides: Partial<SourceWork> = {}): SourceWork {
  return {
    sourceUrl: 'https://x.com/page',
    renderMode: 'html',
    cardName: 'Demo Card',
    existingContentHash: 'old-hash',
    rules: [
      {
        cardId: 'demo_card',
        rule_id: 'demo_card_online',
        label: '網上簽賬',
        current: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
      },
    ],
    ...overrides,
  };
}

function cardsById() {
  return new Map([['demo_card', card()]]);
}

describe('applyWork（fetch_failed）', () => {
  it('check_fail_count += 1，唔改數值', () => {
    const result = applyWork(cardsById(), makeWork(), { kind: 'fetch_failed', error: new FetchError('HTTP 500', 'https://x.com/page') }, NOW);
    const updated = result.updatedCards.get('demo_card')!;
    const rule = updated.rewards[0]!;
    expect(rule.provenance.check_fail_count).toBe(1);
    expect(rule.provenance.last_checked_at).toBe(NOW);
    expect(rule.reward.rate).toBe(0.04); // 冇改
    expect(result.brokenSources).toEqual([]);
  });

  it('連續第 3 次失敗 → broken-source', () => {
    const cards = new Map([
      ['demo_card', card({ rewards: [rewardRule({ provenance: provenance({ check_fail_count: 2 }) })] })],
    ]);
    const result = applyWork(cards, makeWork(), { kind: 'fetch_failed', error: new FetchError('timeout', 'https://x.com/page') }, NOW);
    expect(result.brokenSources).toContain('https://x.com/page');
  });
});

describe('applyWork（extraction_too_thin）', () => {
  const thin = { kind: 'extraction_too_thin' as const, reason: '4 頁但只抽到 101 個字元', chars: 101, pages: 4 };

  it('當讀唔到處理：唔郁數值、唔郁 confidence、唔郁 last_verified_at', () => {
    const result = applyWork(cardsById(), makeWork(), thin, NOW);
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04);
    expect(rule.provenance.confidence).toBe('official');
    expect(rule.provenance.last_verified_at).toBe('2026-08-01T00:00:00.000Z'); // 冇郁
    expect(rule.provenance.last_checked_at).toBe(NOW);
    expect(rule.provenance.check_fail_count).toBe(1);
    expect(result.attentionNeeded.length).toBeGreaterThan(0);
  });

  it('連續第 3 次抽唔到 → broken-source', () => {
    const cards = new Map([
      ['demo_card', card({ rewards: [rewardRule({ provenance: provenance({ check_fail_count: 2 }) })] })],
    ]);
    const result = applyWork(cards, makeWork(), thin, NOW);
    expect(result.brokenSources).toContain('https://x.com/page');
  });
});

describe('applyWork（unchanged）', () => {
  it('更新 last_checked_at 同 last_verified_at，check_fail_count 歸零', () => {
    const cards = new Map([
      ['demo_card', card({ rewards: [rewardRule({ provenance: provenance({ check_fail_count: 2 }) })] })],
    ]);
    const result = applyWork(cards, makeWork(), { kind: 'unchanged', contentHash: 'old-hash', fetchedAt: NOW }, NOW);
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.check_fail_count).toBe(0);
    expect(rule.provenance.last_checked_at).toBe(NOW);
    expect(rule.provenance.last_verified_at).toBe(NOW);
  });
});

describe('applyWork（extracted）', () => {
  it('official + 數值變咗 → 更新 reward，記低 🔄 note', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.038, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '4% 變咗 3.8%',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.038);
    expect(rule.provenance.last_verified_at).toBe(NOW);
    expect(rule.provenance.content_hash).toBe('new-hash');
    expect(result.notes.some((n) => n.startsWith('🔄'))).toBe(true);
  });

  it('official + 數值不變 → 唔會標 🔄，但都算 verified', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '網上簽賬回贈 4%',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    expect(result.notes.some((n) => n.startsWith('🔄'))).toBe(false);
    expect(result.notes.some((n) => n.startsWith('✓'))).toBe(true);
  });

  it('official + 數值不變 → 唔覆寫人手寫嘅 evidence_excerpt', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '4% 回贈', // LLM 精簡版，冇咗限定語
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.evidence_excerpt).toBe('網上簽賬回贈 4%'); // 原本嗰句留返
  });

  it('official + 數值變咗 → 一定要換 evidence_excerpt（舊嗰句講緊已經唔存在嘅數字）', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.038, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '網上簽賬回贈 3.8%',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.evidence_excerpt).toBe('網上簽賬回贈 3.8%');
  });

  it('official + 數值不變 + 本身冇 evidence → 補返上去', () => {
    const cards = new Map([
      ['demo_card', card({ rewards: [rewardRule({ provenance: provenance({ evidence_excerpt: null }) })] })],
    ]);
    const result = applyWork(
      cards,
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '網上簽賬回贈 4%',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.evidence_excerpt).toBe('網上簽賬回贈 4%');
  });

  it('unconfirmed → 唔覆寫人手寫嘅 evidence_excerpt（數值根本冇郁）', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.09, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'unconfirmed',
              evidence_excerpt: '睇唔清',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.provenance.evidence_excerpt).toBe('網上簽賬回贈 4%');
  });

  it('confidence=unconfirmed → 唔改數值、唔改 last_verified_at', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.09, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'unconfirmed',
              evidence_excerpt: null,
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04); // 冇改
    expect(rule.provenance.confidence).toBe('unconfirmed');
    expect(rule.provenance.last_verified_at).toBe('2026-08-01T00:00:00.000Z'); // 冇改
  });

  it('LLM 話 official 但 evidence 喺份文件搵唔返 → 降做 unconfirmed，唔郁數值', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.06, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              // 一段自己寫嘅說明，唔係原文節錄——SOURCE 入面搵唔返。
              evidence_excerpt: '推算：base rate 乘換算率得出 6%，唔係官方直接寫明',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04); // 冇改
    expect(rule.provenance.confidence).toBe('unconfirmed');
    expect(rule.provenance.last_verified_at).toBe('2026-08-01T00:00:00.000Z'); // 冇郁
    expect(rule.provenance.evidence_excerpt).toBe('網上簽賬回贈 4%'); // 舊嗰句留返
    expect(result.attentionNeeded.some((n) => n.includes('evidence_excerpt'))).toBe(true);
  });

  it('found=false → 唔改數值，出 attentionNeeded', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: false,
              reward: null,
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'unconfirmed',
              evidence_excerpt: null,
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04);
    expect(result.attentionNeeded.length).toBeGreaterThan(0);
  });

  it('LLM 冇提到已知 rule_id → attentionNeeded，唔改數值', () => {
    const result = applyWork(cardsById(), makeWork(), { kind: 'extracted', contentHash: 'new-hash', fetchedAt: NOW, result: { rules: [] }, usage: [], mainContent: SOURCE }, NOW);
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04);
    expect(result.attentionNeeded.length).toBeGreaterThan(0);
  });

  it('抽到未來 effective_from → 唔自動改，出 attentionNeeded', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.08, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: '2026-12-01',
              confidence: 'official',
              evidence_excerpt: '12月1日起',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04); // 冇改
    expect(result.attentionNeeded.some((n) => n.includes('effective_from'))).toBe(true);
  });

  it('found=true/official 但 reward.type=null（自相矛盾）→ 唔信，出 attentionNeeded', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: null, rate: null, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: null,
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.reward.rate).toBe(0.04);
    expect(result.attentionNeeded.some((n) => n.includes('自相矛盾'))).toBe(true);
  });

  it('冇 cap 但抽到疑似有 cap → 唔自動整，出 attentionNeeded', () => {
    const result = applyWork(
      cardsById(),
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: 10000,
              cap_unit: 'spend',
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '每月上限 $10,000',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.cap).toBeNull();
    expect(result.attentionNeeded.some((n) => n.includes('cap'))).toBe(true);
  });

  it('有 cap，抽到新 cap.value → 更新，保留 pool_id/period/shared_with', () => {
    const cards = new Map([
      [
        'demo_card',
        card({
          rewards: [
            rewardRule({
              cap: { pool_id: 'p', value: 10000, unit: 'reward', period: 'year', shared_with: [] },
            }),
          ],
        }),
      ],
    ]);
    const result = applyWork(
      cards,
      makeWork(),
      {
        kind: 'extracted',
        contentHash: 'new-hash',
        fetchedAt: NOW,
        result: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: 8000,
              cap_unit: 'reward',
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '上限降至 $8,000',
            },
          ],
        },
        usage: [],
        mainContent: SOURCE,
      },
      NOW,
    );
    const rule = result.updatedCards.get('demo_card')!.rewards[0]!;
    expect(rule.cap?.value).toBe(8000);
    expect(rule.cap?.pool_id).toBe('p');
  });
});
