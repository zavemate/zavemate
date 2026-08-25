/**
 * §7.4 `/v1/status`：健康度、最後成功更新、stale 比例。
 *
 * 「stale」係一個判斷，唔係事實，所以個門檻要寫死喺 code 度講清楚，唔可以
 * 由 caller 傳入然後扮客觀。Agent 1 逢星期一跑，所以兩個週期（14 日）都仲未
 * 核實過，就係真係有嘢唔妥——唔係銀行冇改，係我哋讀唔到。
 *
 * last_verified_at 係 null 一律當 stale：從來未核實過，比核實咗但耐咗更差。
 */
export const STALE_AFTER_DAYS = 14;

export interface RuleFreshness {
  card_id: string;
  rule_id: string;
  last_verified_at: string | null;
  confidence: string;
}

export interface StatusReport {
  version: string | null;
  generated_at: string | null;
  /** 全部 rule 數。 */
  rules: number;
  /** 超過 STALE_AFTER_DAYS 未核實（或者從來未核實）嘅 rule 數。 */
  stale_rules: number;
  stale_ratio: number;
  /** confidence 唔係 official 嘅 rule 數。 */
  unconfirmed_rules: number;
  stale_after_days: number;
  /** 最新一條 last_verified_at——即係「最後一次成功核實」。 */
  last_verified_at: string | null;
  healthy: boolean;
}

export function isStale(lastVerifiedAt: string | null, now: Date): boolean {
  if (lastVerifiedAt === null) return true;
  const verified = Date.parse(lastVerifiedAt);
  if (Number.isNaN(verified)) return true;
  return now.getTime() - verified > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

export function buildStatus(
  input: { version: string | null; generated_at: string | null; rules: RuleFreshness[] },
  now: Date,
): StatusReport {
  const stale = input.rules.filter((rule) => isStale(rule.last_verified_at, now));
  const verifiedTimes = input.rules
    .map((rule) => rule.last_verified_at)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    version: input.version,
    generated_at: input.generated_at,
    rules: input.rules.length,
    stale_rules: stale.length,
    stale_ratio: input.rules.length === 0 ? 1 : stale.length / input.rules.length,
    unconfirmed_rules: input.rules.filter((rule) => rule.confidence !== 'official').length,
    stale_after_days: STALE_AFTER_DAYS,
    last_verified_at: verifiedTimes.at(-1) ?? null,
    // 冇 snapshot、或者一半以上 rule 過期 = 唔健康。呢個唔係報「服務有冇 up」，
    // 係報「啲數字仲信唔信得過」——後者先係我哋賣緊嘅嘢。
    healthy: input.version !== null && input.rules.length > 0 && stale.length / input.rules.length < 0.5,
  };
}
