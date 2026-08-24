import type { Card, Promotion, RewardRule } from '@zavemate/schema';

/**
 * §7.3：agent 唔應該需要識任何 business logic。tier 展開、cap 共用、日期過濾
 * 全部喺 build 階段做完。
 *
 * 刻意冇「展開」嘅嘢：
 * - tier（min_spend / max_spend / period）本身已經係 declarative，展開唔到——
 *   邊個 tier 適用要睇用戶當月消費，只有 query 時先知。
 * - match.scope = 'undetermined' 嘅 rule 照樣輸出，唔會篩走。佢係一個誠實嘅
 *   信號（官方有講範圍但我哋表達唔到），篩走等於扮咗冇呢條 rule 存在。
 */

/** yyyy-mm-dd 比較，null = 冇邊界。 */
export function isInEffect(from: string | null, to: string | null, asOf: string): boolean {
  if (from !== null && from > asOf) return false;
  if (to !== null && to < asOf) return false;
  return true;
}

/**
 * cap 共用池展開成完整封閉集。
 *
 * 資料入面 shared_with 係人手填，好易填一半（A 寫住同 B 共用，但 B 冇寫返 A）。
 * 對外輸出唔可以係半邊——agent 睇住 B 就會以為佢自己獨佔個池，計爆 cap。
 * 所以用 pool_id 做真相，重新算出每條 rule 嘅完整同池 rule_id。
 */
export function resolveCapPools(rules: RewardRule[]): RewardRule[] {
  const byPool = new Map<string, string[]>();
  for (const rule of rules) {
    if (!rule.cap) continue;
    const members = byPool.get(rule.cap.pool_id) ?? [];
    members.push(rule.rule_id);
    byPool.set(rule.cap.pool_id, members);
  }
  return rules.map((rule) => {
    if (!rule.cap) return rule;
    const members = byPool.get(rule.cap.pool_id) ?? [];
    return {
      ...rule,
      cap: { ...rule.cap, shared_with: members.filter((id) => id !== rule.rule_id).sort() },
    };
  });
}

export interface SnapshotCard extends Omit<Card, 'rewards'> {
  rewards: RewardRule[];
  promotions: Promotion[];
}

export function expandCard(card: Card, promotions: Promotion[], asOf: string): SnapshotCard {
  const rewards = resolveCapPools(
    card.rewards.filter((rule) => isInEffect(rule.effective_from, rule.effective_to, asOf)),
  );
  const cardPromotions = promotions.filter(
    (promo) => promo.card_id === card.card_id && promo.active && isInEffect(promo.start_date, promo.end_date, asOf),
  );
  return { ...card, rewards, promotions: cardPromotions };
}
