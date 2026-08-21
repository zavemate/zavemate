import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Card, type RewardValue } from '@zavemate/schema';
import type { RenderMode } from '@zavemate/core';
import type { KnownRule } from './extraction.ts';

/** packages/agent1-base/src/scan.ts → repo root。 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const dataCardsDir = join(repoRoot, 'data', 'cards');

export function loadActiveCards(dir: string = dataCardsDir): Card[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => Card.parse(JSON.parse(readFileSync(join(dir, entry), 'utf8'))))
    .filter((card) => card.active);
}

/**
 * URL 結尾係 .pdf 就當 pdf render_mode，其他一律當 html。
 * 冇處理 'js'——而家啲 source 全部 plain fetch 就攞到真內容（見 packages/core
 * 嘅 integration test）。將來如果撞到真係要 JS render 先攞到嘅頁面，先諗
 * 點樣喺呢度（或者 schema）表達，唔好而家憑空估。
 */
export function inferRenderMode(url: string): RenderMode {
  return url.toLowerCase().endsWith('.pdf') ? 'pdf' : 'html';
}

interface RuleWork {
  cardId: string;
  cardName: string;
  ruleId: string;
  label: string;
  sourceUrl: string;
  contentHash: string | null;
  checkFailCount: number;
  lastCheckedAt: string | null;
  currentReward: RewardValue;
}

export interface WorkRule extends KnownRule {
  cardId: string;
}

export interface SourceWork {
  sourceUrl: string;
  renderMode: RenderMode;
  cardName: string;
  existingContentHash: string | null;
  rules: WorkRule[];
}

/** check_fail_count DESC，然後 last_checked_at ASC（null 排最前）。 */
function priorityCompare(a: RuleWork, b: RuleWork): number {
  if (a.checkFailCount !== b.checkFailCount) return b.checkFailCount - a.checkFailCount;
  if (a.lastCheckedAt === null && b.lastCheckedAt === null) return 0;
  if (a.lastCheckedAt === null) return -1;
  if (b.lastCheckedAt === null) return 1;
  return a.lastCheckedAt.localeCompare(b.lastCheckedAt);
}

/**
 * §6.4 步驟 1：排序、取 20-30 條 rule、按 source_url 去重。
 * 一個 source_url 對應嘅所有 rule 一齊處理（一次 fetch 服務晒），所以最終
 * 覆蓋嘅 rule 數可能比 targetRuleCount 多少少（唔會斬斷一個 URL 嘅 rule 集）。
 */
export function selectWork(cards: Card[], targetRuleCount = 25): SourceWork[] {
  const ruleWorks: RuleWork[] = [];
  for (const card of cards) {
    if (!card.active) continue;
    for (const rule of card.rewards) {
      ruleWorks.push({
        cardId: card.card_id,
        cardName: card.card_name,
        ruleId: rule.rule_id,
        label: rule.label,
        sourceUrl: rule.provenance.source_url,
        contentHash: rule.provenance.content_hash,
        checkFailCount: rule.provenance.check_fail_count,
        lastCheckedAt: rule.provenance.last_checked_at,
        currentReward: rule.reward,
      });
    }
  }

  ruleWorks.sort(priorityCompare);

  const groups = new Map<string, SourceWork>();
  let totalSelectedRules = 0;

  for (const work of ruleWorks) {
    let group = groups.get(work.sourceUrl);
    if (!group) {
      if (totalSelectedRules >= targetRuleCount) continue; // 夠鐘，唔再開新 source_url
      group = {
        sourceUrl: work.sourceUrl,
        renderMode: inferRenderMode(work.sourceUrl),
        cardName: work.cardName,
        existingContentHash: work.contentHash,
        rules: [],
      };
      groups.set(work.sourceUrl, group);
    }
    group.rules.push({
      cardId: work.cardId,
      rule_id: work.ruleId,
      label: work.label,
      current: work.currentReward,
    });
    totalSelectedRules += 1;
  }

  return [...groups.values()];
}
