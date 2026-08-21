import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, ExtractedRule, ExtractionResult } from '../extraction.ts';

describe('ExtractedRule', () => {
  it('接受一條正常嘅 rule', () => {
    expect(() =>
      ExtractedRule.parse({
        rule_id: 'sc_simply_cash_visa_local',
        found: true,
        reward: { type: 'cash_rebate', rate: 0.015, points_per_hkd: null, hkd_per_mile: null },
        cap_value: null,
        cap_unit: null,
        effective_from: null,
        confidence: 'official',
        evidence_excerpt: '1.5% CashBack on spending in local currency',
      }),
    ).not.toThrow();
  });

  it('found=false 嗰陣，其他欄位可以全部 null', () => {
    expect(() =>
      ExtractedRule.parse({
        rule_id: 'demo_rule',
        found: false,
        reward: null,
        cap_value: null,
        cap_unit: null,
        effective_from: null,
        confidence: 'unconfirmed',
        evidence_excerpt: null,
      }),
    ).not.toThrow();
  });

  it('confidence 淨係接受 official/unconfirmed，唔可以係 crowdsourced', () => {
    expect(() =>
      ExtractedRule.parse({
        rule_id: 'demo_rule',
        found: true,
        reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
        cap_value: null,
        cap_unit: null,
        effective_from: null,
        confidence: 'crowdsourced',
        evidence_excerpt: null,
      }),
    ).toThrow();
  });

  it('唔知名嘅欄位要報錯', () => {
    expect(() =>
      ExtractedRule.parse({
        rule_id: 'demo_rule',
        found: true,
        reward: null,
        cap_value: null,
        cap_unit: null,
        effective_from: null,
        confidence: 'official',
        evidence_excerpt: null,
        extra_field: 'should not be here',
      }),
    ).toThrow();
  });
});

describe('ExtractionResult', () => {
  it('接受多條 rule', () => {
    const parsed = ExtractionResult.parse({
      rules: [
        {
          rule_id: 'a',
          found: true,
          reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
          cap_value: null,
          cap_unit: null,
          effective_from: null,
          confidence: 'official',
          evidence_excerpt: null,
        },
      ],
    });
    expect(parsed.rules).toHaveLength(1);
  });
});

describe('buildSystemPrompt', () => {
  it('包含卡名、已知 rule_id 同埋 §6.3 要求嘅指示', () => {
    const prompt = buildSystemPrompt('Demo Card', [
      { rule_id: 'demo_rule', label: '網上簽賬', current: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null } },
    ]);
    expect(prompt).toContain('Demo Card');
    expect(prompt).toContain('demo_rule');
    expect(prompt).toContain('唔好從常識推斷');
    expect(prompt).toContain('unconfirmed');
  });
});
