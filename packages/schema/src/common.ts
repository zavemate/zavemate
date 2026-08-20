import { z } from 'zod';

/**
 * ID 永不重用（§9 唔可以做 #9）。
 * 限制成小寫英數 + 底線，因為檔名 = id（§4.6），要 filesystem-safe 同大小寫無關。
 */
export const Id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_]*$/, 'id 只可以用小寫英數同底線，而且唔可以用底線開頭');

export const Confidence = z.enum([
  'official', // 直接來自發卡機構官方頁面/PDF
  'crowdsourced', // 第三方報導，未經官方確認
  'unconfirmed', // 讀到但睇唔清，數值可能唔準
]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * 產品差異化就係 provenance。呢個 object 唔可以由任何對外 response 剝走（§9 唔可以做 #8）。
 *
 * last_checked_at vs last_verified_at 必須分開：
 * 共用一個欄位嘅話，一條永遠讀唔到嘅 rule 每次 check 完 timestamp 都會變新鮮，
 * 問題永遠唔會浮上水面。
 */
export const Provenance = z.strictObject({
  confidence: Confidence,
  source_url: z.string().url(),
  /** 支持今次數值嘅原文節錄。俾唔到 → confidence 應該係 unconfirmed。 */
  evidence_excerpt: z.string().max(500).nullable(),
  /** 來源頁正文 sha256。一樣就唔使餵 LLM（§6.1 步驟 4）。 */
  content_hash: z.string().nullable(),
  /** 每次 agent 掂過就更新，包括失敗。 */
  last_checked_at: z.string().datetime().nullable(),
  /** 只有成功核實先更新。 */
  last_verified_at: z.string().datetime().nullable(),
  check_fail_count: z.number().int().min(0).default(0),
});
export type Provenance = z.infer<typeof Provenance>;

export const Channel = z.enum(['online', 'offline', 'mobile_pay', 'recurring']);
export type Channel = z.infer<typeof Channel>;

export const Currency = z.enum(['HKD', 'FOREIGN']);
export type Currency = z.infer<typeof Currency>;

/** null = 不限制。空 array = 明確地一個都唔包（罕見，但要分得開）。 */
export const MatchCriteria = z.strictObject({
  channel: z.array(Channel).nullable(),
  currency: z.array(Currency).nullable(),
  mcc_include: z.array(z.string().regex(/^\d{4}$/)).nullable(),
  mcc_exclude: z.array(z.string().regex(/^\d{4}$/)).nullable(),
  merchant_include: z.array(z.string()).nullable(),
  merchant_exclude: z.array(z.string()).nullable(),
  min_spend_per_txn: z.number().nonnegative().nullable(),
});
export type MatchCriteria = z.infer<typeof MatchCriteria>;

export const CapUnit = z.enum(['reward', 'spend']);
export type CapUnit = z.infer<typeof CapUnit>;

export const CapPeriod = z.enum(['transaction', 'month', 'quarter', 'year', 'promo_period']);
export type CapPeriod = z.infer<typeof CapPeriod>;

/**
 * ⚠️ cap.unit 係香港卡最常撈亂嘅位。
 * 「全年回贈上限 $8,000」(unit: reward) 同「合資格簽賬上限 $8,000」(unit: spend) 差成 20 倍。
 * 分唔到就要填 unconfirmed，唔好靠估。
 */
export const Cap = z.strictObject({
  /** 同 pool_id 嘅 rule 共用同一個上限池。 */
  pool_id: Id,
  value: z.number().positive(),
  unit: CapUnit,
  period: CapPeriod,
  /** 共用呢個池嘅其他 rule_id。 */
  shared_with: z.array(Id).default([]),
});
export type Cap = z.infer<typeof Cap>;

export const TierPeriod = z.enum(['transaction', 'month', 'quarter', 'year']);
export type TierPeriod = z.infer<typeof TierPeriod>;
