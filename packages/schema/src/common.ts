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
/**
 * 呢條 rule 到底適用到邊。
 *
 * 加呢個欄位係因為「全部準則都係 null」本來同時代表兩件唔同嘅事：
 *   - 渣打 Cathay base：真係適用於全部合資格簽賬 ✅ 準確
 *   - HSBC EveryMile 第 (c) 類（八達通增值／網上繳費／超市／保費／證券／
 *     租金／廣告）：我哋根本表達唔到個範圍 ❌ 但 schema 上面斷言咗「適用於全部」
 *
 * 撈埋咗嘅後果唔止係計算層——就算永遠冇 /best-card，個事實層今日已經喺度
 * 講緊一句假話。而事實層就係成個產品。
 *
 * 「同時 match 到幾條 rule 嗰陣點揀」係另一個問題（優先次序），留返 Phase 5
 * 有真嘅 /best-card 先設計，唔好而家憑空估。
 */
export const MatchScope = z.enum([
  /** 適用於全部合資格簽賬。注意：一條「其他簽賬」rule 都算 all——指定商戶簽賬爆咗 cap 之後一樣會跌落嚟。 */
  'all',
  /** 由下面啲準則界定。 */
  'criteria',
  /** 官方有講範圍，但我哋表達唔到（例如淨係得類別名，冇 MCC 清單）。deterministic 引擎唔准自己套用呢條。 */
  'undetermined',
]);
export type MatchScope = z.infer<typeof MatchScope>;

export const MatchCriteria = z.strictObject({
  /** 冇 default——每條 rule 都要明確 declare。「全 null」呢個現況本身就係從來冇人認真 declare 過嘅結果。 */
  scope: MatchScope,
  channel: z.array(Channel).nullable(),
  currency: z.array(Currency).nullable(),
  mcc_include: z.array(z.string().regex(/^\d{4}$/)).nullable(),
  mcc_exclude: z.array(z.string().regex(/^\d{4}$/)).nullable(),
  merchant_include: z.array(z.string()).nullable(),
  merchant_exclude: z.array(z.string()).nullable(),
  min_spend_per_txn: z.number().nonnegative().nullable(),
});
export type MatchCriteria = z.infer<typeof MatchCriteria>;

/** scope 同實際準則要對得上，否則個 scope 就係一句冇人核實過嘅斷言。 */
export function matchScopeIssue(match: MatchCriteria): string | null {
  const hasCriteria =
    match.channel !== null ||
    match.currency !== null ||
    match.mcc_include !== null ||
    match.mcc_exclude !== null ||
    match.merchant_include !== null ||
    match.merchant_exclude !== null ||
    match.min_spend_per_txn !== null;

  if (match.scope === 'criteria' && !hasCriteria) {
    return 'match.scope = "criteria" 但一個準則欄位都冇填——即係實際上冇界定到範圍';
  }
  if (match.scope !== 'criteria' && hasCriteria) {
    return `match.scope = "${match.scope}" 但填咗準則欄位——有準則就應該係 "criteria"`;
  }
  return null;
}

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

/**
 * 有啲卡（例如渣打「優先理財」/「優先私人理財」、滙豐「卓越理財」）唔係憑簽賬分層，
 * 而係要求申請人本身喺銀行維持一定嘅資產／結餘先申請得到 —— 呢個係產品門檻，
 * 唔係回贈計算嘅一部分。分開做獨立 card_id（唔好夾埋一張卡用最高等級嘅數字），
 * 用呢個欄位表達門檻，等 agent 可以按用戶自己嘅資產篩選邊張卡真係攞到手。
 */
export const Eligibility = z.strictObject({
  /** null = 一般人都申請得到，冇特別銀行關係要求。 */
  min_relationship_balance: z.number().positive().nullable(),
  /** 人睇嘅門檻名稱，例如「渣打優先理財」、「滙豐卓越理財」。min_relationship_balance 係 null 就應該都係 null。 */
  note: z.string().nullable(),
});
export type Eligibility = z.infer<typeof Eligibility>;
