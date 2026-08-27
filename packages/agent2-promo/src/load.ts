import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Card, Promotion, type Source, Sources } from '@zavemate/schema';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const dataDir = join(repoRoot, 'data');

export function loadCards(root: string = repoRoot): Card[] {
  const dir = join(root, 'data', 'cards');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => Card.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export function loadPromotions(root: string = repoRoot): Map<string, Promotion> {
  const dir = join(root, 'data', 'promotions');
  const promotions = new Map<string, Promotion>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const promo = Promotion.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    promotions.set(promo.promotion_id, promo);
  }
  return promotions;
}

export function loadSources(root: string = repoRoot): Sources {
  return Sources.parse(JSON.parse(readFileSync(join(root, 'data', 'sources.json'), 'utf8')));
}

/** 餵俾 prompt 睇嘅現有優惠：同一批卡、同一個季度。 */
export function existingForPrompt(promotions: Map<string, Promotion>, cardIds: string[], quarter: string) {
  const wanted = new Set(cardIds);
  return [...promotions.values()]
    .filter((p) => (wanted.size === 0 || wanted.has(p.card_id)) && p.promotion_id.includes(`_${quarter}_`))
    .map((p) => ({
      promotion_id: p.promotion_id,
      card_id: p.card_id,
      slug: p.promotion_id.split(`_${quarter}_`)[1] ?? '',
      title: p.title,
      start_date: p.start_date,
      end_date: p.end_date,
    }));
}

export function cardsForSource(cards: Card[], source: Source) {
  const wanted = new Set(source.card_ids);
  return cards
    .filter((c) => c.active && (wanted.size === 0 || wanted.has(c.card_id)))
    .map((c) => ({ card_id: c.card_id, card_name: c.card_name }));
}
