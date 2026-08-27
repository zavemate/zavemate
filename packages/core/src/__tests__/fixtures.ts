import type { Card, Promotion, Provenance, RewardRule } from '@zavemate/schema';

export const provenance: Provenance = {
  confidence: 'official',
  source_url: 'https://www.example-bank.com.hk/cards/demo',
  evidence_excerpt: '網上簽賬回贈 4%',
  content_hash: 'a'.repeat(64),
  last_checked_at: '2026-08-19T04:00:00.000Z',
  last_verified_at: '2026-08-19T04:00:00.000Z',
  check_fail_count: 0,
};

export function rewardRule(overrides: Partial<RewardRule> = {}): RewardRule {
  return {
    rule_id: 'demo_card_online',
    label: '網上簽賬',
    match: {
      scope: 'criteria',
      channel: ['online'],
      currency: null,
      mcc_include: null,
      mcc_exclude: null,
      merchant_include: null,
      merchant_exclude: null,
      min_spend_per_txn: null,
    },
    reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
    tier: null,
    cap: null,
    requires_registration: false,
    registration_url: null,
    effective_from: null,
    effective_to: null,
    provenance,
    ...overrides,
  };
}

export function card(overrides: Partial<Card> = {}): Card {
  return {
    card_id: 'demo_card',
    card_name: 'Demo Card',
    card_name_zh: '示範卡',
    issuer: 'Example Bank',
    issuer_aliases: [],
    network: 'visa',
    annual_fee: 0,
    annual_fee_waiver_note: null,
    fx_fee_rate: 0.0195,
    eligibility: { min_relationship_balance: null, note: null },
    active: true,
    sources: [{ url: 'https://www.example-bank.com.hk/cards/demo', purpose: 'scheme', note: null, last_modified: null, etag: null, language: null, is_authoritative: true }],
    rewards: [rewardRule()],
    provenance,
    ...overrides,
  };
}

export function promotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    promotion_id: 'demo_card_2026q3_online',
    card_id: 'demo_card',
    title: '網上簽賬額外回贈',
    description: null,
    match: {
      scope: 'criteria',
      channel: ['online'],
      currency: null,
      mcc_include: null,
      mcc_exclude: null,
      merchant_include: null,
      merchant_exclude: null,
      min_spend_per_txn: null,
    },
    reward: { type: 'flat_rate', rate: 0.08, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap: { pool_id: 'demo_promo_cap', value: 1000, unit: 'spend', period: 'month', shared_with: [] },
    stacking: { stackable_with_base: true, stack_group: null, priority: 0 },
    start_date: '2026-07-01',
    end_date: '2026-12-31',
    requires_registration: false,
    registration_url: null,
    new_customer_only: false,
    active: true,
    provenance,
    ...overrides,
  } as Promotion;
}
