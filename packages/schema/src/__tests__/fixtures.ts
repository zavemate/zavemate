import type { Provenance } from '../common.ts';

export const provenance: Provenance = {
  confidence: 'official',
  source_url: 'https://www.example-bank.com.hk/cards/demo',
  evidence_excerpt: '網上簽賬回贈 4%',
  content_hash: 'a'.repeat(64),
  last_checked_at: '2026-08-19T04:00:00.000Z',
  last_verified_at: '2026-08-19T04:00:00.000Z',
  check_fail_count: 0,
};

export const emptyMatch = {
  channel: null,
  currency: null,
  mcc_include: null,
  mcc_exclude: null,
  merchant_include: null,
  merchant_exclude: null,
  min_spend_per_txn: null,
};

export function rewardRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rule_id: 'demo_card_online',
    label: '網上簽賬',
    match: { ...emptyMatch, channel: ['online'] },
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

export function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    card_id: 'demo_card',
    card_name: 'Demo Card',
    card_name_zh: '示範卡',
    issuer: 'Example Bank',
    network: 'visa',
    annual_fee: 0,
    annual_fee_waiver_note: null,
    fx_fee_rate: 0.0195,
    active: true,
    rewards: [rewardRule()],
    provenance,
    ...overrides,
  };
}

export function promotion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promotion_id: 'demo_card_2026q3_dining',
    card_id: 'demo_card',
    title: '夏日餐飲優惠',
    description: null,
    match: { ...emptyMatch, mcc_include: ['5812'] },
    reward: { type: 'flat_rate', rate: 0.08, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap: null,
    stacking: { stackable_with_base: false, stack_group: null, priority: 0 },
    start_date: '2026-07-01',
    end_date: '2026-09-30',
    requires_registration: false,
    registration_url: null,
    new_customer_only: false,
    active: true,
    provenance,
    ...overrides,
  };
}
