import type { ExtractedPromotion } from './extraction.ts';
import type { ExistingPromotion } from './extraction.ts';
import { normalizeSlug } from './id.ts';

/**
 * LLM 冇重用返 slug 嘅兜底檢查。
 *
 * §6.5 嘅去重機制係「id 一樣 = 同一個」，而 id 入面唯一會飄嘅係 LLM 俾嘅 slug。
 * 我哋喺 prompt 度俾咗現有 slug 清單叫佢重用，但呢個係指示，唔係保證。
 *
 * 所以再加一層**決定性**檢查：同一張卡、同一段日期、同一個 reward，
 * 而 slug 唔同——咁大機會係 LLM 開咗個新名。呢度**唔會自動合併**，只係標出嚟
 * 喺 PR body 俾人睇。自動合併等於我哋自己做緊「似唔似」判斷，而嗰樣正正係
 * §6.5 叫我哋唔好做嘅嘢。
 */
export interface SuspectedDuplicate {
  extractedSlug: string;
  existingId: string;
  reason: string;
}

function sameDates(a: ExtractedPromotion, b: ExistingPromotion): boolean {
  return a.start_date === b.start_date && a.end_date === b.end_date;
}

export function findSuspectedDuplicates(
  extracted: ExtractedPromotion[],
  existing: ExistingPromotion[],
): SuspectedDuplicate[] {
  const suspects: SuspectedDuplicate[] = [];
  const existingSlugs = new Set(existing.map((e) => e.slug));

  for (const promo of extracted) {
    const slug = normalizeSlug(promo.slug);
    if (slug === '' || existingSlugs.has(slug)) continue; // 已經重用咗，冇問題

    for (const candidate of existing) {
      if (candidate.card_id !== promo.card_id) continue;
      if (!sameDates(promo, candidate)) continue;
      suspects.push({
        extractedSlug: slug,
        existingId: candidate.promotion_id,
        reason: `同一張卡、起訖日期完全一樣（${promo.start_date ?? '?'} 至 ${promo.end_date ?? '?'}），但 slug 由 "${candidate.slug}" 變成 "${slug}"——可能係同一個優惠開咗第二個名`,
      });
      break;
    }
  }
  return suspects;
}
