import { type Card, type Question, questionId } from '@zavemate/schema';
import type { EvidenceGap } from './apply.ts';
import type { LLMProvider } from './llm.ts';
import { proposeEvidence } from './repair.ts';

/**
 * 修復 pass：evidence 撐唔住個數值嘅 rule，逐條試修，修唔掂先問人。
 *
 * ```
 * gap ──→ 修復 agent 讀返原文提替代引文
 *          ├ 機器逐字驗到 + 數值冇郁 → 自動改，唔煩人
 *          └ 驗唔到                  → 開 question，降 unconfirmed
 * ```
 *
 * **點解自動改可以唔經人**：修復 agent 提出嘅引文一定經 `evidenceSupportedBy`
 * 逐字驗證（喺 `repair.ts` 入面），驗唔到就當佢冇提議過——所以佢作唔到假。
 * 而個回贈數值由頭到尾一個字都冇郁，人喺度睇一眼加唔到任何嘢。
 *
 * **點解要有呢個 pass**：實測六條 evidence 對唔上，五條係「引文寫錯但數值啱」
 * ——嗰啲人手做同機器做完全一樣。冇修復 pass，個 loop 唔會收斂（銀行改版、
 * PDF 抽文字方式變、人手抄漏都會令呢類問題一直出現）。
 *
 * 呢個 pass 由 `run.ts` 抽出嚟，因為佢係一個**有分支嘅決策**（修得掂／
 * 修唔掂／叫唔到 LLM），唔係 orchestration。喺 run.ts 入面就要行成個
 * `runAgent1` 先測到佢。
 */

export interface RepairPassInput {
  gaps: EvidenceGap[];
  /** 逐個 source 累積落去嗰份卡——修復會直接改入面條 rule。 */
  workingCards: Map<string, Card>;
  provider: LLMProvider;
  nowIso: string;
}

export interface RepairPassResult {
  /** 成功修好嘅條數（機器驗證過，數值冇郁）。 */
  repaired: number;
  /** 修唔掂而開嘅 question，key = question_id。 */
  questions: Map<string, Question>;
  /** 改過嘅卡——call 嗰邊要 merge 返入去寫 PR 嗰個 map。 */
  touchedCards: Map<string, Card>;
  /** PR body「改動」嗰段。 */
  notes: string[];
  /** PR body「需要人手覆核」嗰段。 */
  attentionNeeded: string[];
  totalCostUsd: number;
}

export async function runRepairPass(input: RepairPassInput): Promise<RepairPassResult> {
  const questions = new Map<string, Question>();
  const touchedCards = new Map<string, Card>();
  const notes: string[] = [];
  const attentionNeeded: string[] = [];
  let repaired = 0;
  let totalCostUsd = 0;

  for (const gap of input.gaps) {
    const card = input.workingCards.get(gap.cardId);
    const rule = card?.rewards.find((r) => r.rule_id === gap.ruleId);
    if (!card || !rule) continue;

    // 叫唔到 LLM（網絡、額度、回覆唔符合 schema）唔應該炸咗成個 run——
    // 當佢「修唔掂」處理，落去開 question 就得。
    let result;
    try {
      result = await proposeEvidence({
        ruleId: gap.ruleId,
        label: rule.label,
        valueDescription: JSON.stringify(rule.reward),
        currentEvidence: rule.provenance.evidence_excerpt,
        sourceText: gap.sourceText,
        provider: input.provider,
      });
    } catch {
      result = null;
    }
    if (result) totalCostUsd += result.usage.costUsd;

    if (result && result.proposal.verdict === 'supported' && result.excerptVerified) {
      const before = rule.provenance.evidence_excerpt;
      rule.provenance.evidence_excerpt = result.proposal.excerpt;
      rule.provenance.last_verified_at = input.nowIso;
      rule.provenance.confidence = 'official';
      touchedCards.set(gap.cardId, card);
      repaired += 1;
      notes.push(
        `🔧 ${gap.cardId}/${gap.ruleId}：evidence 修好咗（機器逐字驗證過），數值一個字都冇郁\n    舊：${(before ?? '').slice(0, 90)}\n    新：${(result.proposal.excerpt ?? '').slice(0, 90)}`,
      );
      continue;
    }

    // 修唔掂 → 開一條 question。kind 決定跟進方法，所以要分清楚：
    // value_conflict 要人判邊個啱，evidence_absent 要人睇係數錯定揀錯文件。
    const kind =
      result === null ? 'evidence_absent'
      : result.proposal.verdict === 'unsupported' && result.excerptVerified ? 'value_conflict'
      : 'evidence_absent';
    const id = questionId(gap.ruleId, kind);
    questions.set(id, {
      question_id: id,
      card_id: gap.cardId,
      rule_id: gap.ruleId,
      kind,
      status: 'open',
      question:
        kind === 'value_conflict'
          ? `我哋記錄 ${JSON.stringify(rule.reward)}，但原文講緊另一件事。邊個啱？`
          : `搵唔到任何撐得住 ${JSON.stringify(rule.reward)} 嘅原文。個數值係咪錯？定係呢份文件根本唔係啱嘅出處？`,
      evidence: result?.proposal.contradicting_excerpt ?? result?.proposal.reasoning ?? null,
      source_url: gap.sourceUrl,
      raised_at: input.nowIso,
      raised_by: 'agent1_repair',
      answer: null,
      answered_at: null,
    });
    // 有 open question 就唔可以係 official（validate 會強制），所以順手降。
    rule.provenance.confidence = 'unconfirmed';
    touchedCards.set(gap.cardId, card);
    attentionNeeded.push(`${gap.cardId}/${gap.ruleId}：修復 agent 搞唔掂，已開 question \`${id}\` 等你答`);
  }

  return { repaired, questions, touchedCards, notes, attentionNeeded, totalCostUsd };
}
