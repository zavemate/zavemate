import { describe, expect, it } from 'vitest';
import type { Promotion } from '@zavemate/schema';
import { applyExpiry, EXPIRY_GRACE_DAYS, findExpired } from '../expire.ts';

function promo(overrides: Partial<Promotion> = {}): Promotion {
  return {
    promotion_id: 'demo_card_2026q3_online',
    card_id: 'demo_card',
    end_date: '2026-07-31',
    active: true,
    ...overrides,
  } as Promotion;
}

const TODAY = '2026-08-27';

describe('findExpired', () => {
  it('過咗 end_date 超過緩衝期 → 標記', () => {
    const result = findExpired([promo({ end_date: '2026-07-31' })], TODAY);
    expect(result.expired).toEqual(['demo_card_2026q3_online']);
    expect(result.notes[0]).toContain('active: false');
  });

  it('啱啱過期但仲喺緩衝期內 → 唔郁', () => {
    // 銀行成日靜靜延期，過咗期第二日先改官網係常態。即刻熄咗，落到下次跑
    // 先發現「其實佢續咗」，中間我哋會少報一個仲有效嘅優惠。
    const justExpired = '2026-08-24'; // 3 日前
    expect(findExpired([promo({ end_date: justExpired })], TODAY).expired).toEqual([]);
  });

  it('緩衝期邊界：啱啱好 7 日唔郁，8 日先郁', () => {
    expect(findExpired([promo({ end_date: '2026-08-20' })], TODAY).expired).toEqual([]); // 7 日
    expect(findExpired([promo({ end_date: '2026-08-19' })], TODAY).expired).toHaveLength(1); // 8 日
    expect(EXPIRY_GRACE_DAYS).toBe(7);
  });

  it('仲未到期 → 唔郁', () => {
    expect(findExpired([promo({ end_date: '2026-12-31' })], TODAY).expired).toEqual([]);
  });

  it('end_date 係 null → 唔郁（§6.5：唔好估）', () => {
    // 官方冇講幾時完，我哋唔可以自己定一個死線然後熄咗人哋。
    expect(findExpired([promo({ end_date: null })], TODAY).expired).toEqual([]);
  });

  it('已經 active: false → 唔會再標一次', () => {
    expect(findExpired([promo({ end_date: '2026-01-01', active: false })], TODAY).expired).toEqual([]);
  });
});

describe('applyExpiry', () => {
  it('淨係改 active，其他欄位唔郁', () => {
    const before = promo({ end_date: '2026-07-31' });
    const [after] = applyExpiry([before], ['demo_card_2026q3_online']);
    expect(after!.active).toBe(false);
    expect(after!.end_date).toBe('2026-07-31'); // 過期唔等於內容有變
  });

  it('冇喺清單入面嘅唔會受影響', () => {
    const [after] = applyExpiry([promo()], ['第二個_id']);
    expect(after!.active).toBe(true);
  });
});
