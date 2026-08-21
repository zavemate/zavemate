import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../gate.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

const NOW = new Date('2026-08-21T00:00:00.000Z');

describe('evaluateGate', () => {
  it('正常嘅細微改動（0.04 → 0.038，嚟源內容真係更新過）直接過關', () => {
    const oldCard = card();
    const newCard = card({
      rewards: [
        rewardRule({
          reward: { type: 'cash_rebate', rate: 0.038, points_per_hkd: null, hkd_per_mile: null },
          // content_hash 要變，先反映「嚟源頁面真係更新過」呢個前提；
          // 如果 content_hash 冇變數值又變咗，應該中 official_conflict（見下面嗰個 describe）。
          provenance: { ...provenance, content_hash: 'b'.repeat(64) },
        }),
      ],
    });
    const result = evaluateGate(oldCard, newCard, NOW);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  describe('rate_jump', () => {
    it('回贈率跳升超過 1.5 倍 → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.1, points_per_hkd: null, hkd_per_mile: null } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.passed).toBe(false);
      expect(result.reasons).toContain('rate_jump');
    });

    it('回贈率喺 0.67x–1.5x 之內 → 唔中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.045, points_per_hkd: null, hkd_per_mile: null } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('rate_jump');
    });

    it('miles 嘅 hkd_per_mile 用倒數（越細越著數）判斷', () => {
      const oldCard = card({
        rewards: [rewardRule({ reward: { type: 'miles', rate: null, points_per_hkd: null, hkd_per_mile: 6 } })],
      });
      // hkd_per_mile 由 6 跌到 2：即係回贈率變咗 3 倍，超出範圍
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'miles', rate: null, points_per_hkd: null, hkd_per_mile: 2 } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('rate_jump');
    });
  });

  describe('rate_implausible', () => {
    it('cash_rebate rate 大過 0.15 → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.2, points_per_hkd: null, hkd_per_mile: null } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('rate_implausible');
    });

    it('cash_rebate rate 喺合理範圍 → 唔中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.05, points_per_hkd: null, hkd_per_mile: null } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('rate_implausible');
    });
  });

  describe('cap_drop', () => {
    const withCap = (value: number) =>
      rewardRule({
        cap: { pool_id: 'demo_pool', value, unit: 'reward', period: 'year', shared_with: [] },
      });

    it('cap.value 跌到少過舊值 0.7 倍 → 中', () => {
      const oldCard = card({ rewards: [withCap(10000)] });
      const newCard = card({ rewards: [withCap(5000)] });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('cap_drop');
    });

    it('cap.value 跌幅少過 0.3 → 唔中', () => {
      const oldCard = card({ rewards: [withCap(10000)] });
      const newCard = card({ rewards: [withCap(9000)] });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('cap_drop');
    });
  });

  describe('cap_unit_changed', () => {
    it('cap.unit 由 reward 變成 spend → 中', () => {
      const oldCard = card({
        rewards: [
          rewardRule({
            cap: { pool_id: 'demo_pool', value: 8000, unit: 'reward', period: 'year', shared_with: [] },
          }),
        ],
      });
      const newCard = card({
        rewards: [
          rewardRule({
            cap: { pool_id: 'demo_pool', value: 8000, unit: 'spend', period: 'year', shared_with: [] },
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('cap_unit_changed');
    });

    it('cap.unit 冇變 → 唔中', () => {
      const oldCard = card({
        rewards: [
          rewardRule({
            cap: { pool_id: 'demo_pool', value: 8000, unit: 'reward', period: 'year', shared_with: [] },
          }),
        ],
      });
      const newCard = card({
        rewards: [
          rewardRule({
            cap: { pool_id: 'demo_pool', value: 8000, unit: 'reward', period: 'year', shared_with: [] },
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('cap_unit_changed');
    });
  });

  describe('structure_change', () => {
    it('新增咗一條 rule_id → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule(), rewardRule({ rule_id: 'demo_card_dining' })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('structure_change');
    });

    it('刪走咗一條 rule_id → 中', () => {
      const oldCard = card({
        rewards: [rewardRule(), rewardRule({ rule_id: 'demo_card_dining' })],
      });
      const newCard = card({ rewards: [rewardRule()] });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('structure_change');
    });

    it('帶 tier 嘅 rule 數目變咗 → 中', () => {
      const oldCard = card({ rewards: [rewardRule({ tier: null })] });
      const newCard = card({
        rewards: [rewardRule({ tier: { min_spend: 0, max_spend: 5000, period: 'month' } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('structure_change');
    });

    it('reward.type 由 cash_rebate 變咗 miles → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'miles', rate: null, points_per_hkd: null, hkd_per_mile: 6 } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('structure_change');
    });

    it('rule_id 集合冇變、tier 數目冇變、type 冇變 → 唔中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ reward: { type: 'cash_rebate', rate: 0.045, points_per_hkd: null, hkd_per_mile: null } })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('structure_change');
    });
  });

  describe('first_rule', () => {
    it('冇舊卡（新卡）→ 中', () => {
      const result = evaluateGate(null, card(), NOW);
      expect(result.reasons).toContain('first_rule');
      expect(result.passed).toBe(false);
    });

    it('有舊卡 → 唔中', () => {
      const result = evaluateGate(card(), card(), NOW);
      expect(result.reasons).not.toContain('first_rule');
    });
  });

  describe('official_conflict', () => {
    it('content_hash 冇變但 official 數值變咗 → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [
          rewardRule({
            reward: { type: 'cash_rebate', rate: 0.05, points_per_hkd: null, hkd_per_mile: null },
            provenance: { ...provenance, confidence: 'official' }, // content_hash 同舊卡一樣
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('official_conflict');
    });

    it('content_hash 都變咗（來源真係更新過）→ 唔中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [
          rewardRule({
            reward: { type: 'cash_rebate', rate: 0.05, points_per_hkd: null, hkd_per_mile: null },
            provenance: { ...provenance, content_hash: 'b'.repeat(64) },
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('official_conflict');
    });
  });

  describe('source_moved', () => {
    it('source_url host 變咗 → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [
          rewardRule({
            provenance: { ...provenance, source_url: 'https://www.other-bank.com.hk/cards/demo' },
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('source_moved');
    });

    it('source_url host 冇變 → 唔中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [
          rewardRule({
            provenance: { ...provenance, source_url: 'https://www.example-bank.com.hk/cards/demo/updated' },
          }),
        ],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('source_moved');
    });
  });

  describe('future_effective', () => {
    it('effective_from 喺 7 日之後 → 中', () => {
      const oldCard = card();
      const newCard = card({
        rewards: [rewardRule({ effective_from: '2026-09-15' })],
      });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('future_effective');
    });

    it('effective_from 係 null（一直生效）→ 唔中', () => {
      const oldCard = card();
      const newCard = card({ rewards: [rewardRule({ effective_from: null })] });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('future_effective');
    });
  });

  describe('card_deactivated', () => {
    it('active 由 true 變 false → 中', () => {
      const oldCard = card({ active: true });
      const newCard = card({ active: false });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).toContain('card_deactivated');
    });

    it('active 維持 true → 唔中', () => {
      const oldCard = card({ active: true });
      const newCard = card({ active: true });
      const result = evaluateGate(oldCard, newCard, NOW);
      expect(result.reasons).not.toContain('card_deactivated');
    });
  });
});
