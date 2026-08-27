import type { Promotion } from '@zavemate/schema';

/**
 * §6.5 步驟 0：過期清理。end_date < today - 7d → active: false。
 *
 * 點解留 7 日緩衝：銀行成日靜靜延期——過咗期第二日先喺官網改返個日期係常態。
 * 一過期就即刻熄，落到下次 Agent 2 跑先發現「其實佢續咗」，中間段時間我哋
 * 會少報一個仲有效嘅優惠。緩衝期換返嘅代價係最多七日內可能多報一個啱啱完嘅
 * 優惠——但嗰個有 end_date 喺度，下游睇得到佢已經過咗期。
 *
 * 唔刪檔（§6.5）。刪咗就冇咗歷史，而 git history 係產品資產；而且銀行復辦
 * 同一個優惠嗰陣，個 id 要重用得返。
 */
export const EXPIRY_GRACE_DAYS = 7;

export interface ExpiryResult {
  /** 要改成 active: false 嘅 promotion_id。 */
  expired: string[];
  /** 人睇嘅一行描述，直接入 PR body。 */
  notes: string[];
}

export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000);
}

export function findExpired(promotions: Promotion[], today: string): ExpiryResult {
  const expired: string[] = [];
  const notes: string[] = [];

  for (const promo of promotions) {
    if (!promo.active) continue;
    // end_date 係 null = 官方冇講幾時完（§6.5：唔好估）。冇日期就冇得判過期，
    // 唔可以自己定一個死線然後熄咗人哋。
    if (promo.end_date === null) continue;

    const overdue = daysBetween(promo.end_date, today);
    if (overdue > EXPIRY_GRACE_DAYS) {
      expired.push(promo.promotion_id);
      notes.push(
        `⏹ ${promo.card_id}/${promo.promotion_id}：end_date ${promo.end_date} 已過 ${Math.floor(overdue)} 日（緩衝 ${EXPIRY_GRACE_DAYS} 日）→ active: false`,
      );
    }
  }

  return { expired, notes };
}

/** 淨係改 active，其他一律唔郁——過期唔等於個優惠嘅內容有變。 */
export function applyExpiry(promotions: Promotion[], expired: string[]): Promotion[] {
  const ids = new Set(expired);
  return promotions.map((promo) => (ids.has(promo.promotion_id) ? { ...promo, active: false } : promo));
}
