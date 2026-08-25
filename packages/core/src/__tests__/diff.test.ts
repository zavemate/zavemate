import { describe, expect, it } from 'vitest';
import { describeChange, diffCards, diffPromotions } from '../diff.ts';
import { card, promotion, provenance, rewardRule } from './fixtures.ts';

describe('diffCards', () => {
  it('新卡 → 一個 card_added', () => {
    const changes = diffCards(null, card());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.type).toBe('card_added');
  });

  it('冇任何改動 → 空陣列', () => {
    expect(diffCards(card(), card())).toEqual([]);
  });

  it('active true → false 出 card_deactivated', () => {
    const changes = diffCards(card({ active: true }), card({ active: false }));
    expect(changes).toContainEqual(expect.objectContaining({ type: 'card_deactivated' }));
  });

  it('active false → true 出 card_reactivated', () => {
    const changes = diffCards(card({ active: false }), card({ active: true }));
    expect(changes).toContainEqual(expect.objectContaining({ type: 'card_reactivated' }));
  });

  it('annual_fee 變咗 → field_changed，連 pct_change', () => {
    const changes = diffCards(card({ annual_fee: 2000 }), card({ annual_fee: 1000 }));
    const change = changes.find((c) => c.field === 'annual_fee');
    expect(change?.type).toBe('field_changed');
    expect(change?.pct_change).toBeCloseTo(-0.5);
  });

  it('新增 rule_id → rule_added', () => {
    const changes = diffCards(
      card(),
      card({ rewards: [rewardRule(), rewardRule({ rule_id: 'demo_card_dining' })] }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'rule_added', rule_id: 'demo_card_dining' }),
    );
  });

  it('刪走 rule_id → rule_removed', () => {
    const changes = diffCards(
      card({ rewards: [rewardRule(), rewardRule({ rule_id: 'demo_card_dining' })] }),
      card(),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'rule_removed', rule_id: 'demo_card_dining' }),
    );
  });

  it('rate 變咗 → rate_changed，pct_change 計得啱', () => {
    const oldCard = card();
    const newCard = card({
      rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.02, points_per_hkd: null, hkd_per_mile: null } })],
    });
    const changes = diffCards(oldCard, newCard);
    const change = changes.find((c) => c.type === 'rate_changed');
    expect(change?.pct_change).toBeCloseTo(-0.5); // 0.04 → 0.02
  });

  it('cap 由冇變有 → cap_added', () => {
    const changes = diffCards(
      card(),
      card({
        rewards: [
          rewardRule({ cap: { pool_id: 'p', value: 8000, unit: 'reward', period: 'year', shared_with: [] } }),
        ],
      }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ type: 'cap_added' }));
  });

  it('cap.value 變咗，同單位 → cap_changed 帶 pct_change', () => {
    const withCap = (value: number) =>
      rewardRule({ cap: { pool_id: 'p', value, unit: 'reward', period: 'year', shared_with: [] } });
    const changes = diffCards(card({ rewards: [withCap(10000)] }), card({ rewards: [withCap(8000)] }));
    const change = changes.find((c) => c.type === 'cap_changed');
    expect(change?.pct_change).toBeCloseTo(-0.2);
  });

  it('effective_from 變咗 → effective_date_changed', () => {
    const changes = diffCards(
      card({ rewards: [rewardRule({ effective_from: null })] }),
      card({ rewards: [rewardRule({ effective_from: '2026-09-01' })] }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ type: 'effective_date_changed' }));
  });

  it('label 變咗（其他欄位嘅 catch-all）→ field_changed', () => {
    const changes = diffCards(
      card({ rewards: [rewardRule({ label: '網上簽賬' })] }),
      card({ rewards: [rewardRule({ label: '網上及流動應用程式簽賬' })] }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ type: 'field_changed', field: 'label' }));
  });

  it('describeChange 出返人睇得明嘅一句', () => {
    const changes = diffCards(
      card(),
      card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.038, points_per_hkd: null, hkd_per_mile: null } })],
      }),
    );
    const line = describeChange(changes[0]!);
    expect(line).toContain('demo_card');
    expect(line).toContain('demo_card_online');
  });
});

describe('confidence_changed', () => {
  it('official → unconfirmed → 出 event（我哋由肯定變成唔肯定，用戶要知）', () => {
    const oldCard = card({ rewards: [rewardRule({ provenance: { ...provenance, confidence: 'official' } })] });
    const newCard = card({ rewards: [rewardRule({ provenance: { ...provenance, confidence: 'unconfirmed' } })] });
    const changes = diffCards(oldCard, newCard);
    const change = changes.find((c) => c.type === 'confidence_changed')!;
    expect(change.field).toBe('provenance.confidence');
    expect(change.old).toBe('official');
    expect(change.new).toBe('unconfirmed');
  });

  it('unconfirmed → official 一樣出 event', () => {
    const oldCard = card({ rewards: [rewardRule({ provenance: { ...provenance, confidence: 'unconfirmed' } })] });
    const newCard = card({ rewards: [rewardRule({ provenance: { ...provenance, confidence: 'official' } })] });
    expect(diffCards(oldCard, newCard).some((c) => c.type === 'confidence_changed')).toBe(true);
  });

  it('confidence 冇變 → 唔會出（唔好用 metadata 雜訊浸死條 stream）', () => {
    expect(diffCards(card(), card()).some((c) => c.type === 'confidence_changed')).toBe(false);
  });
});

describe('diffPromotions', () => {
  it('全新優惠 → promotion_added', () => {
    const changes = diffPromotions(null, promotion());
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe('promotion_added');
    expect(changes[0]!.promotion_id).toBe('demo_card_2026q3_online');
    expect(changes[0]!.rule_id).toBeNull(); // promotion_id 同 rule_id 唔可以撈埋
  });

  it('銀行靜靜延期 → promotion_extended', () => {
    // §6.5 講明「銀行成日靜靜延期」，所以延期同腰斬要分得出。
    const changes = diffPromotions(promotion(), promotion({ end_date: '2027-06-30' }));
    expect(changes.map((c) => c.type)).toContain('promotion_extended');
  });

  it('官方提早取消 → promotion_shortened（唔可以同延期撈埋）', () => {
    const changes = diffPromotions(promotion(), promotion({ end_date: '2026-09-30' }));
    const change = changes.find((c) => c.type === 'promotion_shortened')!;
    expect(change.old).toBe('2026-12-31');
    expect(change.new).toBe('2026-09-30');
  });

  it('active true → false → promotion_deactivated', () => {
    const changes = diffPromotions(promotion(), promotion({ active: false }));
    expect(changes.map((c) => c.type)).toContain('promotion_deactivated');
  });

  it('個檔冇咗 → promotion_removed，而且描述講明呢個係異常', () => {
    // §6.5：過期都唔好刪檔，改 active: false。所以檔真係冇咗要有人睇。
    const changes = diffPromotions(promotion(), null);
    expect(changes[0]!.type).toBe('promotion_removed');
    expect(describeChange(changes[0]!)).toContain('唔好刪檔');
  });

  it('回贈率改咗 → rate_changed', () => {
    const changes = diffPromotions(
      promotion(),
      promotion({ reward: { type: 'flat_rate', rate: 0.05, multiplier: null, bonus_amount: null, hkd_per_mile: null } }),
    );
    expect(changes.map((c) => c.type)).toContain('rate_changed');
  });

  it('上限跌咗 → cap_changed，連 pct_change', () => {
    const changes = diffPromotions(
      promotion(),
      promotion({ cap: { pool_id: 'demo_promo_cap', value: 500, unit: 'spend', period: 'month', shared_with: [] } }),
    );
    const change = changes.find((c) => c.type === 'cap_changed')!;
    expect(change.pct_change).toBeCloseTo(-0.5);
  });

  it('confidence 跌咗 → confidence_changed', () => {
    const changes = diffPromotions(
      promotion(),
      promotion({ provenance: { ...provenance, confidence: 'unconfirmed' } }),
    );
    expect(changes.map((c) => c.type)).toContain('confidence_changed');
  });

  it('冇改動 → 空陣列', () => {
    expect(diffPromotions(promotion(), promotion())).toEqual([]);
  });

  it('兩邊都 null → 空陣列', () => {
    expect(diffPromotions(null, null)).toEqual([]);
  });
});
