import { describe, expect, it } from 'vitest';
import type { ExistingPromotion, ExtractedPromotion } from '../extraction.ts';
import { findSuspectedDuplicates } from '../dedupe.ts';

function extracted(overrides: Partial<ExtractedPromotion> = {}): ExtractedPromotion {
  return {
    card_id: 'hsbc_red',
    slug: 'online',
    title: '網上簽賬 4%',
    reward: { type: 'flat_rate', rate: 0.04, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap_value: null,
    cap_unit: null,
    match_channel: ['online'],
    match_currency: null,
    match_merchant_include: null,
    scope_not_expressible: false,
    start_date: '2026-07-01',
    end_date: '2026-12-31',
    requires_registration: false,
    ended_early: false,
    reward_includes_base: true,
    looks_like_base_terms: false,
    is_publisher_offer: false,
    official_source_url: null,
    confidence: 'official',
    evidence_excerpt: '網上簽賬 4%',
    ...overrides,
  };
}

const existing: ExistingPromotion[] = [
  {
    promotion_id: 'hsbc_red_2026q3_online',
    card_id: 'hsbc_red',
    slug: 'online',
    title: '網上簽賬 4%',
    start_date: '2026-07-01',
    end_date: '2026-12-31',
  },
];

describe('findSuspectedDuplicates', () => {
  it('LLM 重用咗 slug → 冇問題', () => {
    expect(findSuspectedDuplicates([extracted({ slug: 'online' })], existing)).toEqual([]);
  });

  it('slug 變咗但卡同起訖日期完全一樣 → 標出嚟', () => {
    const suspects = findSuspectedDuplicates([extracted({ slug: 'online_spend' })], existing);
    expect(suspects).toHaveLength(1);
    expect(suspects[0]!.existingId).toBe('hsbc_red_2026q3_online');
    expect(suspects[0]!.reason).toContain('可能係同一個優惠開咗第二個名');
  });

  it('唔同卡 → 唔算重複', () => {
    expect(findSuspectedDuplicates([extracted({ slug: 'x', card_id: 'hsbc_everymile' })], existing)).toEqual([]);
  });

  it('日期唔同 → 唔算重複（可能真係新一期優惠）', () => {
    expect(findSuspectedDuplicates([extracted({ slug: 'x', end_date: '2027-06-30' })], existing)).toEqual([]);
  });

  it('大細楷差異當成同一個 slug', () => {
    expect(findSuspectedDuplicates([extracted({ slug: 'Online' })], existing)).toEqual([]);
  });

  it('只係標出嚟，唔會自動合併', () => {
    // 自動合併等於我哋自己做「似唔似」判斷，正正係 §6.5 叫唔好做嗰樣。
    const suspects = findSuspectedDuplicates([extracted({ slug: 'online_spend' })], existing);
    expect(suspects[0]).not.toHaveProperty('merged');
    expect(suspects[0]!.extractedSlug).toBe('online_spend'); // 原樣保留俾人睇
  });
});
