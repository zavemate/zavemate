import type { Card } from '@zavemate/schema';
import type { PipelineOutcome } from './pipeline.ts';
import type { SourceWork } from './scan.ts';

export interface ApplyResult {
  /** card_id → 更新後嘅 Card（冇改過嘅卡唔會出現喺呢個 map）。 */
  updatedCards: Map<string, Card>;
  /** 人睇嘅改動紀錄，逐條 rule 一行，直接砌 PR body。 */
  notes: string[];
  /** 連續 check_fail_count >= 3 嘅 source_url——PR 要標 broken-source（§6.2）。 */
  brokenSources: string[];
  /** 需要人手覆核嘅特殊情況（LLM 冇答、頁面搵唔到、疑似排期生效、疑似新 cap）。 */
  attentionNeeded: string[];
}

/**
 * 將一個 SourceWork 嘅 pipeline 結果，套用落佢覆蓋嘅 rule 度。
 *
 * 刻意唔自動處理嘅情況（寧願留低俾人手，都唔好靜靜錯）：
 * - effective_from 抽到未來日期 → 唔郁個 rule，出 attentionNeeded（CLAUDE.md：
 *   要開新 rule 同舊 rule 並存，呢個係結構性決定，唔應該由 agent 自己諗 rule_id）。
 * - 而家冇 cap 但抽到疑似有 cap → 唔自動整（Cap 要 pool_id，唔係抽取得到嘅嘢）。
 * - 有 cap 但抽到 cap_value/cap_unit 係 null → 唔郁（唔係「冇搵到」就等於「冧咗」）。
 */
export function applyWork(cardsById: Map<string, Card>, work: SourceWork, outcome: PipelineOutcome, now: string): ApplyResult {
  const updatedCards = new Map<string, Card>();
  const notes: string[] = [];
  const brokenSources: string[] = [];
  const attentionNeeded: string[] = [];

  const getOrCloneCard = (cardId: string): Card => {
    const existing = updatedCards.get(cardId);
    if (existing) return existing;
    const original = cardsById.get(cardId);
    if (!original) throw new Error(`scan 揀咗 card_id "${cardId}" 但搵唔到呢張卡`);
    const clone = structuredClone(original);
    updatedCards.set(cardId, clone);
    return clone;
  };

  const patchRule = (cardId: string, ruleId: string, patch: (rule: Card['rewards'][number]) => void) => {
    const card = getOrCloneCard(cardId);
    const rule = card.rewards.find((r) => r.rule_id === ruleId);
    if (!rule) throw new Error(`card "${cardId}" 搵唔到 rule_id "${ruleId}"`);
    patch(rule);
  };

  if (outcome.kind === 'fetch_failed') {
    for (const rule of work.rules) {
      patchRule(rule.cardId, rule.rule_id, (r) => {
        r.provenance.check_fail_count += 1;
        r.provenance.last_checked_at = now;
      });
      const newCount = getOrCloneCard(rule.cardId).rewards.find((r) => r.rule_id === rule.rule_id)!.provenance
        .check_fail_count;
      notes.push(`⚠️ ${rule.cardId}/${rule.rule_id}：fetch 失敗（${outcome.error.message}），check_fail_count → ${newCount}`);
      if (newCount >= 3) brokenSources.push(work.sourceUrl);
    }
    return { updatedCards, notes, brokenSources, attentionNeeded };
  }

  if (outcome.kind === 'unchanged') {
    for (const rule of work.rules) {
      patchRule(rule.cardId, rule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
        r.provenance.last_verified_at = now;
      });
    }
    notes.push(`✓ ${work.sourceUrl}：內容冇變（hash 一樣），${work.rules.length} 條 rule 已確認仍然有效，唔使餵 LLM`);
    return { updatedCards, notes, brokenSources, attentionNeeded };
  }

  // outcome.kind === 'extracted'
  for (const workRule of work.rules) {
    const extracted = outcome.result.rules.find((r) => r.rule_id === workRule.rule_id);

    if (!extracted) {
      patchRule(workRule.cardId, workRule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
      });
      attentionNeeded.push(`${workRule.cardId}/${workRule.rule_id}：LLM 回覆冇提到呢條已知 rule_id，數值未變，要人手覆核`);
      continue;
    }

    if (!extracted.found) {
      patchRule(workRule.cardId, workRule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
      });
      attentionNeeded.push(`${workRule.cardId}/${workRule.rule_id}：頁面入面搵唔到呢條 rule 講嘅嘢（可能改版），數值未變，要人手覆核`);
      continue;
    }

    if (extracted.confidence === 'unconfirmed') {
      patchRule(workRule.cardId, workRule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
        r.provenance.confidence = 'unconfirmed';
        if (extracted.evidence_excerpt) r.provenance.evidence_excerpt = extracted.evidence_excerpt;
        // 故意唔郁 last_verified_at、唔郁數值（§6.2：讀到但睇唔清）。
      });
      notes.push(`? ${workRule.cardId}/${workRule.rule_id}：讀到但條款睇唔清，confidence 降做 unconfirmed，數值維持原值`);
      continue;
    }

    // confidence === 'official' && found === true
    if (extracted.effective_from !== null) {
      patchRule(workRule.cardId, workRule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
      });
      attentionNeeded.push(
        `${workRule.cardId}/${workRule.rule_id}：抽到 effective_from = ${extracted.effective_from}，可能係排期生效嘅新條款——冇自動處理（要開新 rule 同舊 rule 並存，呢個係結構性決定），數值未變`,
      );
      continue;
    }

    // found=true + confidence=official 但 reward/reward.type 係 null——LLM 自相矛盾嘅
    // 回覆（schema 結構上容許，但語義上唔應該發生）。唔信呢種答案，當佢冇答。
    if (extracted.reward === null || extracted.reward.type === null) {
      patchRule(workRule.cardId, workRule.rule_id, (r) => {
        r.provenance.check_fail_count = 0;
        r.provenance.last_checked_at = now;
      });
      attentionNeeded.push(
        `${workRule.cardId}/${workRule.rule_id}：LLM 話 found=true/official 但冇俾 reward.type，答案自相矛盾，數值未變，要人手覆核`,
      );
      continue;
    }
    const extractedReward = { ...extracted.reward, type: extracted.reward.type };

    const oldRewardJson = JSON.stringify(workRule.current);
    const newRewardJson = JSON.stringify(extractedReward);

    patchRule(workRule.cardId, workRule.rule_id, (r) => {
      r.provenance.check_fail_count = 0;
      r.provenance.last_checked_at = now;
      r.provenance.last_verified_at = now;
      r.provenance.confidence = 'official';
      if (extracted.evidence_excerpt) r.provenance.evidence_excerpt = extracted.evidence_excerpt;
      r.reward = extractedReward;

      if (r.cap !== null && extracted.cap_value !== null && extracted.cap_unit !== null) {
        r.cap = { ...r.cap, value: extracted.cap_value, unit: extracted.cap_unit };
      } else if (r.cap === null && extracted.cap_value !== null) {
        attentionNeeded.push(
          `${workRule.cardId}/${workRule.rule_id}：而家冇 cap，但抽到疑似有上限（${extracted.cap_value} ${extracted.cap_unit}）——冇自動整（Cap 要 pool_id，agent 唔應該自己諗），要人手覆核`,
        );
      }
    });

    notes.push(
      oldRewardJson === newRewardJson
        ? `✓ ${workRule.cardId}/${workRule.rule_id}：核實過，數值不變`
        : `🔄 ${workRule.cardId}/${workRule.rule_id}：reward 由 ${oldRewardJson} 變 ${newRewardJson}`,
    );
  }

  // 呢個 source_url 底下所有 rule 都用返同一個新 content_hash。
  for (const workRule of work.rules) {
    patchRule(workRule.cardId, workRule.rule_id, (r) => {
      r.provenance.content_hash = outcome.contentHash;
    });
  }

  return { updatedCards, notes, brokenSources, attentionNeeded };
}
