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

  it('冇 end_date 嗰條規則唔可以同「第三方一律 crowdsourced」打交', () => {
    // 舊版規則 3 淨係寫「冇明確結束日期就 confidence 填 unconfirmed」，同上面
    // 「第三方一律 crowdsourced」直接矛盾。第三方嗰條贏（apply.ts 本身都係
    // 噉行——crowdsourced 唔會再被降級），所以規則 3 要講明佢分官方定第三方。
    const prompt = buildPromoSystemPrompt({ ...base, sourceType: 'third_party' });
    expect(prompt).toContain('呢條規則唔會令佢變');
    expect(prompt).toContain('官方來源冇明確結束日期就填 "unconfirmed"');
  });

  it('講明「適用於多張卡」要逐張交一條，唔係填 null', () => {
    // 2026-08-27 第一次真跑（PR #153，已 close）就係死喺呢度：「滙豐最紅簽賬
    // 獎賞」嗰類優惠適用於全部滙豐卡，模型喺「揀一張／逐張交／填 null」之間
    // 搖擺——同一批文章跑兩次，hsbc_red 變咗 null、三條百老滙變返一條。
    // 規則 6 原本淨係寫「對唔上就填 null」，冇講「對上太多」點做。
    const prompt = buildPromoSystemPrompt(base);
    expect(prompt).toContain('每張卡各交一條');
    expect(prompt).toContain('唔係「對上太多」');
  });

  it('講明點認「攻略站自己俾嘅著數」', () => {
    const prompt = buildPromoSystemPrompt(base);
    expect(prompt).toContain('is_publisher_offer');
    expect(prompt).toContain('唔經呢個網站做嘢仲攞唔攞到');
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
    is_publisher_offer: false,
    official_source_url: null,
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
