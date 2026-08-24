import { describe, expect, it } from 'vitest';
import type { RewardRule } from '@zavemate/schema';
import { isInEffect, resolveCapPools } from '../expand.ts';

describe('isInEffect', () => {
  const asOf = '2026-08-24';

  it('兩邊都 null → 一直生效', () => {
    expect(isInEffect(null, null, asOf)).toBe(true);
  });

  it('未到 effective_from → 唔生效', () => {
    expect(isInEffect('2026-09-01', null, asOf)).toBe(false);
  });

  it('effective_from 就係今日 → 生效', () => {
    expect(isInEffect('2026-08-24', null, asOf)).toBe(true);
  });

  it('effective_to 就係今日 → 仍然生效（包尾日）', () => {
    expect(isInEffect(null, '2026-08-24', asOf)).toBe(true);
  });

  it('過咗 effective_to → 唔生效', () => {
    expect(isInEffect(null, '2026-08-23', asOf)).toBe(false);
  });
});

function ruleWithCap(rule_id: string, pool_id: string | null, shared: string[] = []): RewardRule {
  return {
    rule_id,
    label: rule_id,
    match: {
      scope: 'all',
      channel: null,
      currency: null,
      mcc_include: null,
      mcc_exclude: null,
      merchant_include: null,
      merchant_exclude: null,
      min_spend_per_txn: null,
    },
    reward: { type: 'cash_rebate', rate: 0.01, points_per_hkd: null, hkd_per_mile: null },
    tier: null,
    cap: pool_id === null ? null : { pool_id, value: 1000, unit: 'reward', period: 'month', shared_with: shared },
    requires_registration: false,
    registration_url: null,
    effective_from: null,
    effective_to: null,
    provenance: {
      confidence: 'official',
      source_url: 'https://example.com/',
      evidence_excerpt: null,
      content_hash: null,
      last_checked_at: null,
      last_verified_at: null,
      check_fail_count: 0,
    },
  } as RewardRule;
}

describe('resolveCapPools', () => {
  it('人手只填咗一邊 → 補返做完整封閉集', () => {
    // A 寫住同 B 共用，但 B 冇寫返 A。agent 睇住 B 就會以為自己獨佔個池。
    const resolved = resolveCapPools([ruleWithCap('a', 'pool1', ['b']), ruleWithCap('b', 'pool1', [])]);
    expect(resolved[0]!.cap!.shared_with).toEqual(['b']);
    expect(resolved[1]!.cap!.shared_with).toEqual(['a']);
  });

  it('唔會將自己放入 shared_with', () => {
    const resolved = resolveCapPools([ruleWithCap('a', 'pool1', ['a', 'b']), ruleWithCap('b', 'pool1', [])]);
    expect(resolved[0]!.cap!.shared_with).not.toContain('a');
  });

  it('三條 rule 同池 → 每條都見到另外兩條', () => {
    const resolved = resolveCapPools(['a', 'b', 'c'].map((id) => ruleWithCap(id, 'pool1')));
    expect(resolved.map((r) => r.cap!.shared_with)).toEqual([['b', 'c'], ['a', 'c'], ['a', 'b']]);
  });

  it('唔同池唔會撈埋', () => {
    const resolved = resolveCapPools([ruleWithCap('a', 'pool1'), ruleWithCap('b', 'pool2')]);
    expect(resolved[0]!.cap!.shared_with).toEqual([]);
    expect(resolved[1]!.cap!.shared_with).toEqual([]);
  });

  it('冇 cap 嘅 rule 原樣傳返', () => {
    const resolved = resolveCapPools([ruleWithCap('a', null)]);
    expect(resolved[0]!.cap).toBeNull();
  });
});
