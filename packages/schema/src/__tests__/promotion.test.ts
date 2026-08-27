import { describe, expect, it } from 'vitest';
import { Promotion } from '../promotion.ts';
import { promotion, provenance } from './fixtures.ts';

describe('Promotion', () => {
  it('接受一個正常嘅限時優惠', () => {
    const parsed = Promotion.parse(promotion());
    expect(parsed.end_date).toBe('2026-09-30');
    expect(parsed.stacking.stackable_with_base).toBe(false);
  });

  it('冇 end_date 就唔可以 official —— 唔好估幾時完（§6.5）', () => {
    // 原本呢條寫死「一定要 unconfirmed」，但同「第三方來源一律 crowdsourced」
    // 撞板：一個第三方抽到、冇寫結束日嘅優惠兩條規則都符合唔到，於是 Agent 2
    // 產出嘅每一條都過唔到 validate。兩者講緊唔同嘅嘢——crowdsourced 講出處
    // 性質，unconfirmed 講資料完整度。真正要守住嘅係「唔可以聲稱 official」。
    expect(() =>
      Promotion.parse(promotion({ end_date: null, provenance: { ...provenance, confidence: 'official' } })),
    ).toThrow(/official/);

    for (const confidence of ['unconfirmed', 'crowdsourced'] as const) {
      expect(() =>
        Promotion.parse(promotion({ end_date: null, provenance: { ...provenance, confidence } })),
      ).not.toThrow();
    }
  });

  it('要登記但冇登記連結 —— 淨係 official 先擋', () => {
    // 第三方報導成日淨係寫「一經滙豐Reward+ App登記」，係 app 唔係 URL，
    // 冇連結可以抄。寧願講「要登記但唔知去邊」都好過隱瞞「要登記」——後者
    // 會令用戶以為碌咗就有，最後成個回贈攞唔到。
    const needsRegistration = { requires_registration: true, registration_url: null };
    expect(() =>
      Promotion.parse(
        promotion({ ...needsRegistration, provenance: { ...provenance, confidence: 'official' } }),
      ),
    ).toThrow(/registration_url/);
    expect(() =>
      Promotion.parse(
        promotion({ ...needsRegistration, provenance: { ...provenance, confidence: 'crowdsourced' } }),
      ),
    ).not.toThrow();
  });

  it('rate_multiplier 要有 multiplier，唔可以填 rate', () => {
    expect(() =>
      Promotion.parse(
        promotion({
          reward: {
            type: 'rate_multiplier',
            rate: null,
            multiplier: null,
            bonus_amount: null,
            hkd_per_mile: null,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: {
            type: 'rate_multiplier',
            rate: 0.05,
            multiplier: 3,
            bonus_amount: null,
            hkd_per_mile: null,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: {
            type: 'rate_multiplier',
            rate: null,
            multiplier: 3,
            bonus_amount: null,
            hkd_per_mile: null,
          },
        }),
      ),
    ).not.toThrow();
  });

  it('miles 要有 hkd_per_mile，唔可以填 rate/multiplier/bonus_amount', () => {
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'miles', rate: null, multiplier: null, bonus_amount: null, hkd_per_mile: null },
        }),
      ),
    ).toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'miles', rate: null, multiplier: null, bonus_amount: null, hkd_per_mile: 2 },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'miles', rate: null, multiplier: 3, bonus_amount: null, hkd_per_mile: 2 },
        }),
      ),
    ).toThrow();
  });

  it('miles 嘅 hkd_per_mile 要大過 0', () => {
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'miles', rate: null, multiplier: null, bonus_amount: null, hkd_per_mile: 0 },
        }),
      ),
    ).toThrow();
  });

  it('end_date 唔可以早過 start_date', () => {
    expect(() =>
      Promotion.parse(promotion({ start_date: '2026-09-30', end_date: '2026-07-01' })),
    ).toThrow();
  });

  it('cap.period = promo_period 就要有 end_date', () => {
    expect(() =>
      Promotion.parse(
        promotion({
          end_date: null,
          provenance: { ...provenance, confidence: 'unconfirmed' },
          cap: {
            pool_id: 'demo_promo_pool',
            value: 300,
            unit: 'reward',
            period: 'promo_period',
            shared_with: [],
          },
        }),
      ),
    ).toThrow(/promo_period/);
  });

  it('唔知名嘅欄位要報錯', () => {
    expect(() => Promotion.parse(promotion({ ends_date: '2026-09-30' }))).toThrow();
  });
});
