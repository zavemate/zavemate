import { describe, expect, it } from 'vitest';
import { inferRenderMode, selectWork } from '../scan.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

describe('inferRenderMode', () => {
  it('.pdf 結尾 → pdf', () => {
    expect(inferRenderMode('https://av.sc.com/hk/docs/tnc.pdf')).toBe('pdf');
    expect(inferRenderMode('https://av.sc.com/hk/docs/TNC.PDF')).toBe('pdf');
  });

  it('其他一律當 html', () => {
    expect(inferRenderMode('https://www.sc.com/hk/credit-cards/smart/')).toBe('html');
  });
});

describe('selectWork', () => {
  it('揀齊所有 active 卡嘅 rule，inactive 卡唔理', () => {
    const cards = [
      card({ card_id: 'a', rewards: [rewardRule({ rule_id: 'a_1' })] }),
      card({ card_id: 'b', active: false, rewards: [rewardRule({ rule_id: 'b_1' })] }),
    ];
    const work = selectWork(cards, 25);
    const ruleIds = work.flatMap((w) => w.rules.map((r) => r.rule_id));
    expect(ruleIds).toEqual(['a_1']);
  });

  it('同一個 source_url 嘅 rule 夾埋一組（一次 fetch 服務晒）', () => {
    const cards = [
      card({
        card_id: 'a',
        rewards: [
          rewardRule({ rule_id: 'a_1', provenance: provenance({ source_url: 'https://x.com/page' }) }),
          rewardRule({ rule_id: 'a_2', provenance: provenance({ source_url: 'https://x.com/page' }) }),
        ],
      }),
    ];
    const work = selectWork(cards, 25);
    expect(work).toHaveLength(1);
    expect(work[0]?.rules.map((r) => r.rule_id)).toEqual(['a_1', 'a_2']);
  });

  it('check_fail_count 高嘅優先（DESC）', () => {
    const cards = [
      card({
        card_id: 'a',
        rewards: [
          rewardRule({
            rule_id: 'a_low_fail',
            provenance: provenance({ source_url: 'https://x.com/1', check_fail_count: 0 }),
          }),
        ],
      }),
      card({
        card_id: 'b',
        rewards: [
          rewardRule({
            rule_id: 'b_high_fail',
            provenance: provenance({ source_url: 'https://x.com/2', check_fail_count: 3 }),
          }),
        ],
      }),
    ];
    const work = selectWork(cards, 25);
    expect(work[0]?.rules[0]?.rule_id).toBe('b_high_fail');
  });

  it('check_fail_count 一樣，未 check 過（null）排最前', () => {
    const cards = [
      card({
        card_id: 'a',
        rewards: [
          rewardRule({
            rule_id: 'a_checked',
            provenance: provenance({ source_url: 'https://x.com/1', last_checked_at: '2026-08-10T00:00:00.000Z' }),
          }),
        ],
      }),
      card({
        card_id: 'b',
        rewards: [
          rewardRule({
            rule_id: 'b_never_checked',
            provenance: provenance({ source_url: 'https://x.com/2', last_checked_at: null }),
          }),
        ],
      }),
    ];
    const work = selectWork(cards, 25);
    expect(work[0]?.rules[0]?.rule_id).toBe('b_never_checked');
  });

  it('去到 targetRuleCount 就唔再開新 source_url（唔會斬斷一個 URL 嘅集）', () => {
    const cards = [
      card({
        card_id: 'a',
        rewards: [
          rewardRule({ rule_id: 'a_1', provenance: provenance({ source_url: 'https://x.com/1' }) }),
          rewardRule({ rule_id: 'a_2', provenance: provenance({ source_url: 'https://x.com/1' }) }),
        ],
      }),
      card({
        card_id: 'b',
        rewards: [rewardRule({ rule_id: 'b_1', provenance: provenance({ source_url: 'https://x.com/2' }) })],
      }),
    ];
    const work = selectWork(cards, 1); // 淨係想要 1 條，但第一個 URL 就有 2 條
    expect(work).toHaveLength(1);
    expect(work[0]?.rules).toHaveLength(2); // 冇斬斷
  });
});
