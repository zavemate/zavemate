import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffCards, diffPromotions, type FieldChange } from '@zavemate/core';
import type { Card, Promotion, RewardRule } from '@zavemate/schema';
import { repoRoot } from './load.ts';

/**
 * §7.2 步驟 4：git diff → change events → 追加落 changes/{year}.jsonl。
 *
 * ⚠️ 歷史資料**唔會**用今日嘅 Zod schema 驗證。
 *
 * schema 一路喺度加欄位（sources[]、match.scope⋯⋯），舊 commit 嘅檔一定過唔到
 * 今日嘅 Card.parse。如果驗證，「由 commit 1 重跑」就永遠 build 唔返——而嗰個
 * 正正係 §8 Phase 3 嘅 acceptance 之一，亦係 git 方案相對 DB 嘅核心優勢。
 *
 * 所以歷史檔淨係 JSON.parse 之後直接 diff 欄位。呢度唔係喺度斷言舊資料有效，
 * 係喺度講「當時個檔寫住乜」——而嗰個本來就係 git 記住嘅嘢。
 */

export interface ChangeEvent {
  change_id: string;
  commit: string;
  detected_at: string;
  card_id: string;
  rule_id: string | null;
  promotion_id: string | null;
  type: FieldChange['type'];
  field: string;
  old: unknown;
  new: unknown;
  pct_change: number | null;
  effective_from: string | null;
  confidence: string | null;
  source_url: string | null;
  evidence_excerpt: string | null;
  pr: number | null;
}

const FIELD_SEP = '\x1f';

function git(args: string[], root: string): string {
  // stdio stderr 'pipe'：第一個 commit 冇父，rev-parse 會嘈；我哋 catch 咗，唔想污染 log。
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 某個 commit 嗰陣 data/cards/ 入面有咩。檔唔存在（例如未有 data/）就當空。 */
export function readCardsAtRef(ref: string, root: string = repoRoot): Map<string, Card> {
  const cards = new Map<string, Card>();
  let listing: string;
  try {
    listing = git(['ls-tree', '--name-only', ref, 'data/cards/'], root);
  } catch {
    return cards;
  }
  for (const path of listing.split('\n').filter((line) => line.endsWith('.json'))) {
    try {
      const raw = JSON.parse(git(['show', `${ref}:${path}`], root)) as Card;
      if (raw?.card_id) cards.set(raw.card_id, raw);
    } catch {
      // 個別檔讀唔到／唔係 JSON 就跳過。歷史係盡力還原，唔係驗證。
    }
  }
  return cards;
}

/** 某個 commit 嗰陣 data/promotions/ 入面有咩。 */
export function readPromotionsAtRef(ref: string, root: string = repoRoot): Map<string, Promotion> {
  const promotions = new Map<string, Promotion>();
  let listing: string;
  try {
    listing = git(['ls-tree', '--name-only', ref, 'data/promotions/'], root);
  } catch {
    return promotions;
  }
  for (const path of listing.split('\n').filter((line) => line.endsWith('.json'))) {
    try {
      const raw = JSON.parse(git(['show', `${ref}:${path}`], root)) as Promotion;
      if (raw?.promotion_id) promotions.set(raw.promotion_id, raw);
    } catch {
      // 同 card 一樣：歷史係盡力還原，唔係驗證。
    }
  }
  return promotions;
}

/** commit message 尾嘅 "(#123)"——squash merge 會自動加。攞唔到就 null。 */
export function parsePrNumber(subject: string): number | null {
  const match = subject.match(/\(#(\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

type Enrichment = Pick<ChangeEvent, 'effective_from' | 'confidence' | 'source_url' | 'evidence_excerpt'>;

/**
 * 補返 provenance 落個 event。
 *
 * §9：唔可以由 API response 剝走 provenance——change stream 一樣係 API response。
 * 「HSBC 減咗 cap」冇出處同證據，同傳聞冇分別。
 */
function enrich(
  change: FieldChange,
  newCards: Map<string, Card>,
  newPromotions: Map<string, Promotion>,
): Enrichment {
  if (change.promotion_id) {
    const promo = newPromotions.get(change.promotion_id);
    return {
      // promotion 用 start_date 做「幾時開始生效」——同 rule 嘅 effective_from 同一個意思。
      effective_from: promo?.start_date ?? null,
      confidence: promo?.provenance.confidence ?? null,
      source_url: promo?.provenance.source_url ?? null,
      evidence_excerpt: promo?.provenance.evidence_excerpt ?? null,
    };
  }
  const card = newCards.get(change.card_id);
  const rule = change.rule_id === null ? undefined : card?.rewards?.find((r: RewardRule) => r.rule_id === change.rule_id);
  const provenance = rule?.provenance ?? card?.provenance;
  return {
    effective_from: rule?.effective_from ?? null,
    confidence: provenance?.confidence ?? null,
    source_url: provenance?.source_url ?? null,
    evidence_excerpt: provenance?.evidence_excerpt ?? null,
  };
}

export interface CommitInfo {
  sha: string;
  subject: string;
  committedAt: string;
}

/** 一個 commit 相對佢父 commit 產生嘅 change events。 */
export function changeEventsForCommit(commit: CommitInfo, root: string = repoRoot): ChangeEvent[] {
  let parent = '';
  try {
    parent = git(['rev-parse', `${commit.sha}^`], root).trim();
  } catch {
    parent = ''; // 第一個 commit，冇父
  }

  const oldCards = parent === '' ? new Map<string, Card>() : readCardsAtRef(parent, root);
  const newCards = readCardsAtRef(commit.sha, root);
  const oldPromotions = parent === '' ? new Map<string, Promotion>() : readPromotionsAtRef(parent, root);
  const newPromotions = readPromotionsAtRef(commit.sha, root);

  const changes: FieldChange[] = [];
  for (const [cardId, newCard] of newCards) {
    changes.push(...diffCards(oldCards.get(cardId) ?? null, newCard));
  }
  // 成張卡由 data/ 消失（唔係 active: false，係真係刪咗檔）。
  for (const cardId of oldCards.keys()) {
    if (newCards.has(cardId)) continue;
    changes.push({
      card_id: cardId,
      rule_id: null,
      type: 'card_deactivated',
      field: 'file',
      old: cardId,
      new: null,
      pct_change: null,
    });
  }

  for (const [promotionId, newPromo] of newPromotions) {
    changes.push(...diffPromotions(oldPromotions.get(promotionId) ?? null, newPromo));
  }
  for (const [promotionId, oldPromo] of oldPromotions) {
    if (newPromotions.has(promotionId)) continue;
    changes.push(...diffPromotions(oldPromo, null));
  }

  const pr = parsePrNumber(commit.subject);
  const short = commit.sha.slice(0, 7);
  return changes.map((change) => ({
    change_id: `${short}:${change.card_id}:${change.promotion_id ?? change.rule_id ?? '-'}:${change.field}`,
    commit: short,
    detected_at: commit.committedAt,
    card_id: change.card_id,
    rule_id: change.rule_id,
    promotion_id: change.promotion_id ?? null,
    type: change.type,
    field: change.field,
    old: change.old,
    new: change.new,
    pct_change: change.pct_change,
    ...enrich(change, newCards, newPromotions),
    pr,
  }));
}

/** 由頭到尾行晒掂過 data/ 嘅 commit，完整重建成條 stream（§8 Phase 3 acceptance）。 */
export function rebuildAllChangeEvents(root: string = repoRoot): ChangeEvent[] {
  const log = git(['log', '--reverse', `--format=%H${FIELD_SEP}%ct${FIELD_SEP}%s`, '--', 'data/'], root).trim();
  if (log === '') return [];
  const events: ChangeEvent[] = [];
  for (const line of log.split('\n')) {
    const [sha, epoch, ...rest] = line.split(FIELD_SEP);
    events.push(
      ...changeEventsForCommit(
        { sha: sha!, subject: rest.join(FIELD_SEP), committedAt: new Date(Number(epoch) * 1000).toISOString() },
        root,
      ),
    );
  }
  return events;
}

/**
 * 追加落 changes/{year}.jsonl。
 *
 * JSONL 唔係一個大 JSON：天然 append-only、可按年切檔、支援 range request，
 * 而且 diff 永遠只喺尾部加行（§7.2）。
 *
 * 用 change_id 去重，所以同一個 commit 重跑幾多次都唔會出重複行。
 */
export function appendChangeEvents(events: ChangeEvent[], changesDir: string): Map<string, number> {
  mkdirSync(changesDir, { recursive: true });
  const byYear = new Map<string, ChangeEvent[]>();
  for (const event of events) {
    const year = event.detected_at.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), event]);
  }
  const counts = new Map<string, number>();
  for (const [year, yearEvents] of byYear) {
    const file = join(changesDir, `${year}.jsonl`);
    const existing = existsSync(file)
      ? new Set(
          readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as ChangeEvent).change_id),
        )
      : new Set<string>();
    const fresh = yearEvents.filter((event) => !existing.has(event.change_id));
    if (fresh.length > 0) appendFileSync(file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
    counts.set(year, fresh.length);
  }
  return counts;
}
