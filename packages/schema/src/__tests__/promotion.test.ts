import { describe, expect, it } from 'vitest';
import { Promotion } from '../promotion.ts';
import { promotion, provenance } from './fixtures.ts';

describe('Promotion', () => {
  it('接受一個正常嘅限時優惠', () => {
    const parsed = Promotion.parse(promotion());
    expect(parsed.end_date).toBe('2026-09-30');
    expect(parsed.stacking.stackable_with_base).toBe(false);
  });

  it('冇 end_date 就一定要 unconfirmed —— 唔好估幾時完（§6.5）', () => {
    expect(() => Promotion.parse(promotion({ end_date: null }))).toThrow(/unconfirmed/);
    expect(() =>
      Promotion.parse(
        promotion({
          end_date: null,
          provenance: { ...provenance, confidence: 'unconfirmed' },
        }),
      ),
    ).not.toThrow();
  });

  it('rate_multiplier 要有 multiplier，唔可以填 rate', () => {
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'rate_multiplier', rate: null, multiplier: null, bonus_amount: null },
        }),
      ),
    ).toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'rate_multiplier', rate: 0.05, multiplier: 3, bonus_amount: null },
        }),
      ),
    ).toThrow();
    expect(() =>
      Promotion.parse(
        promotion({
          reward: { type: 'rate_multiplier', rate: null, multiplier: 3, bonus_amount: null },
        }),
      ),
    ).not.toThrow();
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
