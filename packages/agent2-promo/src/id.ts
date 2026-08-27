/**
 * §6.5 去重：promotion_id 由 {card_id}_{yyyyqn}_{slug} 決定性產生。
 * 同名就係同一個，直接覆寫——唔好叫 LLM 判斷「似唔似」。
 *
 * 呢個做法成敗完全繫於一件事：同一個優惠，每次跑都要砌到同一個 id。
 * card_id 固定、季度由 start_date 算出所以固定，唯一會飄嘅係 slug。
 */

/** 由日期攞季度標籤，例如 2026-07-01 → 2026q3。 */
export function quarterLabel(date: string): string {
  const [year, month] = date.split('-');
  const quarter = Math.floor((Number(month) - 1) / 3) + 1;
  return `${year}q${quarter}`;
}

/**
 * 正規化 slug：細楷、非 [a-z0-9] 一律變底線、收窄連續底線、剪走頭尾底線。
 *
 * 中文字會全部變底線然後被收窄——即係中文 slug 會變成空字串。呢個係刻意嘅：
 * id 要俾人喺 PR、檔名、change_id 度讀得明，而且 §7.7 承諾 id 永久穩定，
 * 所以只准 ASCII。抽取嗰邊要俾英文 slug。
 */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export class PromotionIdError extends Error {}

export interface PromotionIdInput {
  cardId: string;
  /** 優惠開始日期。null = 官方冇講，用發現日做季度。 */
  startDate: string | null;
  /** 發現日（yyyy-mm-dd），startDate 係 null 嗰陣先用。 */
  detectedOn: string;
  slug: string;
}

export function promotionId(input: PromotionIdInput): string {
  const slug = normalizeSlug(input.slug);
  if (slug === '') {
    // 寧願 throw 都唔好砌一個 {card}_{quarter}_ 出嚟——嗰個會同下一個冇 slug
    // 嘅優惠撞 id，兩個唔同優惠變成互相覆寫。
    throw new PromotionIdError(`slug 正規化之後係空："${input.slug}"（要 ASCII 英文 slug）`);
  }
  return `${input.cardId}_${quarterLabel(input.startDate ?? input.detectedOn)}_${slug}`;
}
