import { describe, expect, it } from 'vitest';
import { Card, RewardRule } from '../card.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

describe('Card', () => {
  it('接受一張正常嘅現金回贈卡', () => {
    const parsed = Card.parse(card());
    expect(parsed.card_id).toBe('demo_card');
    expect(parsed.rewards[0]?.reward.rate).toBe(0.04);
  });

  it('填返 default（check_fail_count / active / requires_registration）', () => {
    const withoutDefaults = card({
      rewards: [
        {
          ...rewardRule(),
          requires_registration: undefined,
          provenance: { ...provenance, check_fail_count: undefined },
        },
      ],
      active: undefined,
    });
    const parsed = Card.parse(JSON.parse(JSON.stringify(withoutDefaults)));
    expect(parsed.active).toBe(true);
    expect(parsed.rewards[0]?.requires_registration).toBe(false);
    expect(parsed.rewards[0]?.provenance.check_fail_count).toBe(0);
  });

  it('唔知名嘅欄位要報錯，唔可以靜靜掉咗', () => {
    expect(() => Card.parse(card({ anual_fee: 0 }))).toThrow();
  });

  it('card_id 唔可以有大階或者空格', () => {
    expect(() => Card.parse(card({ card_id: 'Demo Card' }))).toThrow();
  });

  it('同一張卡入面 rule_id 唔可以重複', () => {
    expect(() => Card.parse(card({ rewards: [rewardRule(), rewardRule()] }))).toThrow(/重複/);
  });

  it('同一個 pool_id 嘅 cap 三個欄位要一致', () => {
    const shared = (value: number, ruleId: string) =>
      rewardRule({
        rule_id: ruleId,
        cap: { pool_id: 'demo_pool', value, unit: 'reward', period: 'year', shared_with: [] },
      });
    expect(() =>
      Card.parse(card({ rewards: [shared(8000, 'demo_card_a'), shared(5000, 'demo_card_b')] })),
    ).toThrow(/唔一致/);
    expect(() =>
      Card.parse(card({ rewards: [shared(8000, 'demo_card_a'), shared(8000, 'demo_card_b')] })),
    ).not.toThrow();
  });

  it('eligibility.min_relationship_balance 同 note 要一齊有值或者一齊 null', () => {
    expect(() =>
      Card.parse(card({ eligibility: { min_relationship_balance: 1000000, note: null } })),
    ).toThrow(/eligibility/);
    expect(() =>
      Card.parse(card({ eligibility: { min_relationship_balance: null, note: '渣打優先理財' } })),
    ).toThrow(/eligibility/);
    expect(() =>
      Card.parse(
        card({ eligibility: { min_relationship_balance: 1000000, note: '渣打優先理財' } }),
      ),
    ).not.toThrow();
  });

  it('cap.shared_with 唔可以指住唔存在嘅 rule', () => {
    expect(() =>
      Card.parse(
        card({
          rewards: [
            rewardRule({
              cap: {
                pool_id: 'demo_pool',
                value: 8000,
                unit: 'reward',
                period: 'year',
                shared_with: ['does_not_exist'],
              },
            }),
          ],
        }),
      ),
    ).toThrow(/搵唔到|冇呢條 rule/);
  });
});

describe('RewardRule', () => {
  it('cash_rebate 一定要有 rate', () => {
    expect(() =>
      RewardRule.parse(
        rewardRule({
          reward: { type: 'cash_rebate', rate: null, points_per_hkd: null, hkd_per_mile: null },
        }),
      ),
    ).toThrow();
  });

  it('現金回贈 / 積分 / 里數唔可以互換', () => {
    expect(() =>
      RewardRule.parse(
        rewardRule({
          reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: 1, hkd_per_mile: null },
        }),
      ),
    ).toThrow();
    expect(() =>
      RewardRule.parse(
        rewardRule({
          reward: { type: 'points', rate: null, points_per_hkd: 1, hkd_per_mile: null },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      RewardRule.parse(
        rewardRule({
          reward: { type: 'miles', rate: null, points_per_hkd: null, hkd_per_mile: 6 },
        }),
      ),
    ).not.toThrow();
  });

  it('cash_rebate rate 係比例，唔可以大過 1', () => {
    expect(() =>
      RewardRule.parse(
        rewardRule({
          reward: { type: 'cash_rebate', rate: 4, points_per_hkd: null, hkd_per_mile: null },
        }),
      ),
    ).toThrow();
  });

  it('tier.max_spend 要大過 min_spend', () => {
    expect(() =>
      RewardRule.parse(rewardRule({ tier: { min_spend: 5000, max_spend: 5000, period: 'month' } })),
    ).toThrow();
    expect(() =>
      RewardRule.parse(rewardRule({ tier: { min_spend: 5000, max_spend: 20000, period: 'month' } })),
    ).not.toThrow();
  });

  it('effective_to 唔可以早過 effective_from', () => {
    expect(() =>
      RewardRule.parse(rewardRule({ effective_from: '2026-09-01', effective_to: '2026-08-31' })),
    ).toThrow();
  });

  it('cap.unit 淨係接受 reward / spend', () => {
    expect(() =>
      RewardRule.parse(
        rewardRule({
          cap: { pool_id: 'p', value: 8000, unit: 'dollars', period: 'year', shared_with: [] },
        }),
      ),
    ).toThrow();
  });

  it('requires_registration = true 就要有 registration_url', () => {
    expect(() => RewardRule.parse(rewardRule({ requires_registration: true }))).toThrow();
  });

  it('MCC 要係四位數字', () => {
    expect(() =>
      RewardRule.parse(rewardRule({ match: { ...(rewardRule().match as object), mcc_include: ['581'] } })),
    ).toThrow();
  });
});
