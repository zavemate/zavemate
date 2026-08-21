import { evaluateGate, type GateResult, openPR, type PRFile } from '@zavemate/core';
import { canonicalStringify, type Card, type JsonValue } from '@zavemate/schema';
import { applyWork } from './apply.ts';
import type { LLMProvider } from './llm.ts';
import { runPipeline } from './pipeline.ts';
import { loadActiveCards, selectWork } from './scan.ts';

export interface OpenPRFn {
  (params: Parameters<typeof openPR>[0]): ReturnType<typeof openPR>;
}

export interface Agent1RunOptions {
  provider: LLMProvider;
  githubToken: string;
  owner?: string;
  repo?: string;
  targetRuleCount?: number;
  now?: Date;
  /** 淨係測試用，唔提供就用真實 loadActiveCards()。 */
  cards?: Card[];
  /** 淨係測試用，唔提供就用真實 openPR()（打真 GitHub API）。 */
  openPRFn?: OpenPRFn;
}

export interface Agent1RunResult {
  prUrl: string | null;
  prNumber: number | null;
  changed: number;
  verified: number;
  totalCostUsd: number;
  gatePassed: boolean;
  brokenSources: string[];
}

/** §6.4 Agent 1 成個流程：scan → pipeline（逐個 source）→ apply → evaluateGate → openPR。 */
export async function runAgent1(options: Agent1RunOptions): Promise<Agent1RunResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const owner = options.owner ?? 'zavemate';
  const repo = options.repo ?? 'zavemate';
  const openPRImpl = options.openPRFn ?? openPR;

  const cards = options.cards ?? loadActiveCards();
  const cardsById = new Map(cards.map((c) => [c.card_id, c]));
  const work = selectWork(cards, options.targetRuleCount ?? 25);

  const emptyResult: Agent1RunResult = {
    prUrl: null,
    prNumber: null,
    changed: 0,
    verified: 0,
    totalCostUsd: 0,
    gatePassed: true,
    brokenSources: [],
  };
  if (work.length === 0) return emptyResult;

  const mergedCards = new Map<string, Card>();
  const allNotes: string[] = [];
  const allBroken = new Set<string>();
  const allAttention: string[] = [];
  let totalCostUsd = 0;
  let changed = 0;
  let verified = 0;

  for (const sourceWork of work) {
    const knownRules = sourceWork.rules.map(({ cardId: _cardId, ...rest }) => rest);
    const outcome = await runPipeline({
      url: sourceWork.sourceUrl,
      renderMode: sourceWork.renderMode,
      existingContentHash: sourceWork.existingContentHash,
      knownRules,
      cardName: sourceWork.cardName,
      provider: options.provider,
    });

    if (outcome.kind === 'extracted') {
      for (const usage of outcome.usage) totalCostUsd += usage.costUsd;
    }

    const result = applyWork(cardsById, sourceWork, outcome, nowIso);
    for (const [cardId, card] of result.updatedCards) mergedCards.set(cardId, card);
    allNotes.push(...result.notes);
    for (const source of result.brokenSources) allBroken.add(source);
    allAttention.push(...result.attentionNeeded);

    verified += sourceWork.rules.length;
    changed += result.notes.filter((n) => n.startsWith('🔄')).length;
  }

  if (mergedCards.size === 0) {
    return { ...emptyResult, changed, verified, totalCostUsd, brokenSources: [...allBroken] };
  }

  const gateResults = new Map<string, GateResult>();
  for (const [cardId, newCard] of mergedCards) {
    gateResults.set(cardId, evaluateGate(cardsById.get(cardId) ?? null, newCard));
  }
  const gatePassed = [...gateResults.values()].every((g) => g.passed);

  const files: PRFile[] = [...mergedCards.entries()].map(([cardId, card]) => ({
    path: `data/cards/${cardId}.json`,
    content: canonicalStringify(card as unknown as JsonValue),
  }));

  const dateStr = nowIso.slice(0, 10);
  const bodyParts = [`**自動核實 —— ${dateStr}**`, '', '### 改動', ...allNotes.map((n) => `- ${n}`)];
  if (allAttention.length > 0) {
    bodyParts.push('', '### ⚠️ 需要人手覆核', ...allAttention.map((n) => `- ${n}`));
  }
  bodyParts.push(
    '',
    '### Gate 結果',
    ...[...gateResults.entries()].map(
      ([cardId, gate]) => `- ${cardId}：${gate.passed ? '✅ 全過' : `⛔ ${gate.reasons.join('、')}`}`,
    ),
  );
  bodyParts.push('', '### 成本', `- 總 LLM cost：$${totalCostUsd.toFixed(4)}`);

  const labels: string[] = [];
  if (!gatePassed) labels.push('needs-review');
  if (allBroken.size > 0) labels.push('broken-source');

  const pr = await openPRImpl({
    owner,
    repo,
    token: options.githubToken,
    branchName: `agent1/${dateStr}`,
    files,
    title: `chore(agent1): weekly check — ${changed} changed, ${verified} verified`,
    body: bodyParts.join('\n'),
    labels,
  });

  return {
    prUrl: pr.url,
    prNumber: pr.number,
    changed,
    verified,
    totalCostUsd,
    gatePassed,
    brokenSources: [...allBroken],
  };
}
