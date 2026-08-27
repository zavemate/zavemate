import { describe, expect, it } from 'vitest';
import { normalizeSlug, PromotionIdError, promotionId, quarterLabel } from '../id.ts';

describe('quarterLabel', () => {
  it.each([
    ['2026-01-01', '2026q1'],
    ['2026-03-31', '2026q1'],
    ['2026-04-01', '2026q2'],
    ['2026-07-01', '2026q3'],
    ['2026-12-31', '2026q4'],
  ])('%s → %s', (date, expected) => {
    expect(quarterLabel(date)).toBe(expected);
  });
});

describe('normalizeSlug', () => {
  it('細楷 + 底線', () => {
    expect(normalizeSlug('Dining Hotel')).toBe('dining_hotel');
  });

  it('收窄連續分隔符，剪走頭尾', () => {
    expect(normalizeSlug('  --Online__Spend-- ')).toBe('online_spend');
  });

  it('中文全部變底線然後被收走 → 空字串', () => {
    // id 要喺 PR、檔名、change_id 度讀得明，而且 §7.7 承諾 id 永久穩定，
    // 所以只准 ASCII。抽取嗰邊要俾英文 slug。
    expect(normalizeSlug('指定商戶')).toBe('');
  });
});

describe('promotionId', () => {
  const base = { cardId: 'hsbc_red', startDate: '2026-07-01', detectedOn: '2026-08-27' };

  it('砌到 {card_id}_{yyyyqn}_{slug}', () => {
    expect(promotionId({ ...base, slug: 'designated' })).toBe('hsbc_red_2026q3_designated');
  });

  it('同一個輸入永遠砌到同一個 id（去重靠呢個）', () => {
    const a = promotionId({ ...base, slug: 'Designated' });
    const b = promotionId({ ...base, slug: 'designated' });
    expect(a).toBe(b);
  });

  it('冇 start_date → 用發現日算季度', () => {
    expect(promotionId({ ...base, startDate: null, slug: 'online' })).toBe('hsbc_red_2026q3_online');
  });

  it('slug 空咗就 throw，唔會砌一個結尾係底線嘅 id', () => {
    // 砌到 hsbc_red_2026q3_ 嘅話，下一個冇 slug 嘅優惠會撞同一個 id，
    // 兩個唔同優惠變成互相覆寫。
    expect(() => promotionId({ ...base, slug: '指定商戶' })).toThrow(PromotionIdError);
  });
});
