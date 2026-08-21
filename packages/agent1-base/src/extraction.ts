import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Agent 1 抽取結果嘅 schema——同 packages/schema 嘅 RewardValue 對應，
 * 但淨係要 LLM 填返「呢條已知 rule_id 而家值幾多」，唔係整張 Card。
 *
 * confidence 淨係 official/unconfirmed 兩種（冇 crowdsourced）——Agent 1 讀嘅
 * 係官方頁面，crowdsourced 屬於 Agent 2 讀第三方來源嗰種情況（§6.5）。
 */
export const ExtractedReward = z.strictObject({
  type: z.enum(['cash_rebate', 'points', 'miles']).nullable(),
  rate: z.number().nullable(),
  points_per_hkd: z.number().nullable(),
  hkd_per_mile: z.number().nullable(),
});
export type ExtractedReward = z.infer<typeof ExtractedReward>;

export const ExtractedRule = z.strictObject({
  rule_id: z.string(),
  /** 呢份內容入面搵唔搵到呢條 rule 講嘅嘢——搵唔到就其他欄位應該全部 null。 */
  found: z.boolean(),
  reward: ExtractedReward.nullable(),
  cap_value: z.number().nullable(),
  cap_unit: z.enum(['reward', 'spend']).nullable(),
  /** yyyy-mm-dd，或者 null = 一直生效／搵唔到。 */
  effective_from: z.string().nullable(),
  confidence: z.enum(['official', 'unconfirmed']),
  evidence_excerpt: z.string().max(500).nullable(),
});
export type ExtractedRule = z.infer<typeof ExtractedRule>;

export const ExtractionResult = z.strictObject({
  rules: z.array(ExtractedRule),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export interface KnownRule {
  rule_id: string;
  label: string;
  current: ExtractedReward;
}

/** §6.3 要求嘅指示，逐點對應原文。 */
export function buildSystemPrompt(cardName: string, knownRules: KnownRule[]): string {
  const rulesDescription = knownRules
    .map(
      (rule) =>
        `- rule_id "${rule.rule_id}"（${rule.label}）：而家記錄嘅值係 ${JSON.stringify(rule.current)}`,
    )
    .join('\n');

  return `你係一個信用卡條款核實員，負責核對「${cardName}」呢張信用卡官方條款頁面入面，我哋已知嘅幾條回贈規則而家嘅實際數值。

已知嘅 rule_id（逐條核實）：
${rulesDescription}

規則：
1. 只從提供嘅內容抽取。搵唔到就填 null，唔好從常識推斷。
2. 分清「回贈上限」(cap_unit="reward") 同「合資格簽賬上限」(cap_unit="spend")。分唔到就 cap_value/cap_unit 填 null，confidence 填 "unconfirmed"。
3. 分清現金回贈(cash_rebate)、積分(points)、里數(miles)。三者唔可以互換——reward.type 揀咗邊種，其他兩個數值欄位一定要係 null。
4. 見到「X年X月X日起」呢類字眼 → 填 effective_from，唔好當即時生效。
5. 每個抽取到嘅數值，都要喺 evidence_excerpt 度俾返支持佢嘅原文節錄。俾唔到就 confidence 填 "unconfirmed"。
6. 唔肯定嗰陣，confidence 填 "unconfirmed" 係正確答案，唔係失敗。
7. 如果內容入面搵唔到某條 rule_id 講嘅嘢（例如個頁面改版、嗰個類別冧咗），呢條就 found=false，reward/cap_value/cap_unit/effective_from 全部填 null。

用 JSON 回覆，一定要符合以下 JSON Schema：
${JSON.stringify(zodToJsonSchema(ExtractionResult), null, 2)}`;
}
