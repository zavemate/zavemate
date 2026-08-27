import { describe, expect, it } from 'vitest';
import { buildPromoSystemPrompt, type ExistingPromotion, PromoExtractionResult } from '../extraction.ts';

const base = {
  sourceLabel: 'HSBC 信用卡優惠',
  sourceType: 'official' as const,
  cards: [{ card_id: 'hsbc_red', card_name: 'HSBC Red Credit Card' }],
  existing: [] as ExistingPromotion[],
  today: '2026-08-27',
};

describe('buildPromoSystemPrompt', () => {
  it('列晒現有 slug，同埋叫佢原封不動重用', () => {
    // id 係唯一去重機制，slug 唔一致就會同一個優惠有兩份檔。
    const prompt = buildPromoSystemPrompt({
      ...base,
      existing: [
        {
          promotion_id: 'hsbc_red_2026q3_online',
          card_id: 'hsbc_red',
          slug: 'online',
          title: '網上簽賬 4%',
          start_date: '2026-07-01',
          end_date: '2026-12-31',
        },
      ],
    });
    expect(prompt).toContain('slug "online"');
    expect(prompt).toContain('原封不動');
  });

  it('第三方來源 → 明確要求 confidence 一律 crowdsourced', () => {
    const prompt = buildPromoSystemPrompt({ ...base, sourceType: 'third_party' });
    expect(prompt).toContain('crowdsourced');
    expect(prompt).toContain('唔可以填 "official"');
  });

  it('官方來源 → 唔會叫佢用 crowdsourced', () => {
    expect(buildPromoSystemPrompt(base)).not.toContain('唔可以填 "official"');
  });

  it('講明冇明確結束日期唔好估', () => {
    expect(buildPromoSystemPrompt(base)).toContain('唔好估');
  });

  it('講明表達唔到範圍唔好當佢適用於全部', () => {
    // 呢個對應 match.scope = 'undetermined'——老實講明「知有範圍但界定唔到」。
    expect(buildPromoSystemPrompt(base)).toContain('唔好因為表達唔到就當佢適用於全部簽賬');
  });

  it('講明 reward_includes_base 唔好估，同埋點解重要', () => {
    // HSBC Red 個 8% 含基本獎賞——當佢可疊加就計成 8.4%，高報。
    const prompt = buildPromoSystemPrompt(base);
    expect(prompt).toContain('reward_includes_base');
    expect(prompt).toContain('報一個唔存在嘅回贈率');
  });

  it('講明空陣列係正確答案', () => {
    // 唔好為咗交嘢而將長期條款當成優惠。
    expect(buildPromoSystemPrompt(base)).toContain('空陣列係正確答案');
  });
});

describe('PromoExtractionResult schema', () => {
  const promo = {
    card_id: 'hsbc_red',
    slug: 'online',
    title: '網上簽賬 4%',
    reward: { type: 'flat_rate', rate: 0.04, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap_value: 10000,
    cap_unit: 'spend',
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
    confidence: 'official',
    evidence_excerpt: '網上簽賬 4%「獎賞錢」回贈',
  };

  it('接受一個完整優惠', () => {
    expect(PromoExtractionResult.parse({ promotions: [promo] }).promotions).toHaveLength(1);
  });

  it('接受空陣列（呢版冇優惠）', () => {
    expect(PromoExtractionResult.parse({ promotions: [] }).promotions).toEqual([]);
  });

  it('多咗欄位就唔收（strictObject，防 LLM 自己發明欄位）', () => {
    expect(() => PromoExtractionResult.parse({ promotions: [{ ...promo, extra: 1 }] })).toThrow();
  });

  it('evidence_excerpt 超過 500 字唔收', () => {
    expect(() =>
      PromoExtractionResult.parse({ promotions: [{ ...promo, evidence_excerpt: 'x'.repeat(501) }] }),
    ).toThrow();
  });
});
