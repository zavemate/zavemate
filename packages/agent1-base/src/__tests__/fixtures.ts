import type { Card, Provenance, RewardRule } from '@zavemate/schema';

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    confidence: 'official',
    source_url: 'https://www.example-bank.com.hk/cards/demo',
    evidence_excerpt: '網上簽賬回贈 4%',
    content_hash: 'a'.repeat(64),
    last_checked_at: '2026-08-01T00:00:00.000Z',
    last_verified_at: '2026-08-01T00:00:00.000Z',
    check_fail_count: 0,
    ...overrides,
  };
}

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
    provenance: provenance(),
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
    card_aliases: [],
    network: 'visa',
    annual_fee: 0,
    annual_fee_waiver_note: null,
    fx_fee_rate: 0.0195,
    eligibility: { min_relationship_balance: null, note: null },
    active: true,
    sources: [{ url: 'https://www.example-bank.com.hk/cards/demo', purpose: 'scheme', note: null, last_modified: null, etag: null, language: null, is_authoritative: true }],
    rewards: [rewardRule()],
    provenance: provenance(),
    ...overrides,
  };
}
