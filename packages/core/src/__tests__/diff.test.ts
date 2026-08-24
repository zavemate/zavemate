import { describe, expect, it } from 'vitest';
import { describeChange, diffCards } from '../diff.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

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
