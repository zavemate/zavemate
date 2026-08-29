import { buildPRBody, evaluateGate, fetchSource, type GateResult, openPR, type PRFile } from '@zavemate/core';
import { canonicalStringify, type Card, type JsonValue, questionId } from '@zavemate/schema';
import { applyWork, type EvidenceGap } from './apply.ts';
import { runRepairPass } from './repair-pass.ts';
import { extractLinkedDocs, findSourceDrift, productPageOf } from './source-drift.ts';
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
  /**
   * 淨係測試用，唔提供就用真實 runPipeline()（真係去 fetch）。
   *
   * 冇呢個注入點嘅話，run.test.ts 每個 case 都要打真網站——之前一路靠
   * example.com，又慢又 flaky（加多兩個 fetch 就撞 rate limit 累到其他
   * test 冧），而且 example.com 個頁面短到會被 assessExtraction 正確咁
   * 判做「抽取太薄」。pipeline 本身有自己嘅 integration test 覆蓋。
   */
  runPipelineFn?: typeof runPipeline;
  /**
   * 淨係測試用——來源漂移檢查會真係 fetch 發卡行嘅卡頁。
   *
   * 冇呢個注入點，任何一個 fixture 一旦加咗 product_page，成批 unit test
   * 就會靜靜哋開始打真網站。同 runPipelineFn 一樣嘅理由。
   */
  fetchFn?: typeof fetchSource;
}

export interface Agent1RunResult {
  prUrl: string | null;
  prNumber: number | null;
  /** 開咗嘅 branch 名。workflow 要 checkout 佢嚟驗 PR 真正內容。 */
  branchName: string | null;
  changed: number;
  verified: number;
  totalCostUsd: number;
  gatePassed: boolean;
  brokenSources: string[];
  /** 自動修好咗嘅 evidence 條數（機器驗證過，數值冇郁）。 */
  repaired: number;
  /** 修唔掂、開咗 question 嘅條數。 */
  questionsRaised: number;
}

/**
 * PR 標題／branch name 用嘅香港日期。
 *
 * 唔可以直接 `nowIso.slice(0, 10)`：cron 係 04:00 HKT 跑，即係 20:00 UTC 前一日，
 * 所以 UTC 日期永遠落後香港一日——2026-08-24（星期一）跑出嚟嘅 PR 會叫
 * `agent1/2026-08-23`，同「逢星期一跑」對唔上，睇 PR list 嗰陣好易數錯週期。
 *
 * 淨係影響俾人睇嘅 label。JSON 入面嘅 last_checked_at / last_verified_at 一律
 * 保持 UTC ISO instant，唔好跟住改——嗰啲係機器讀嘅時間點，唔係日曆日期。
 */
export function hongKongDate(now: Date): string {
  // en-CA 個 date format 就係 YYYY-MM-DD。
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(now);
}

/** §6.4 Agent 1 成個流程：scan → pipeline（逐個 source）→ apply → evaluateGate → openPR。 */
export async function runAgent1(options: Agent1RunOptions): Promise<Agent1RunResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const owner = options.owner ?? 'zavemate';
  const repo = options.repo ?? 'zavemate';
  const openPRImpl = options.openPRFn ?? openPR;
  const runPipelineImpl = options.runPipelineFn ?? runPipeline;

  const cards = options.cards ?? loadActiveCards();
  /** 原始版本，淨係俾 evaluateGate 做「舊 vs 新」對比用，成個 run 都唔會變。 */
  const originalCards = new Map(cards.map((c) => [c.card_id, c]));
  /**
   * applyWork 讀嘅版本，逐個 source 累積落去。
   *
   * 唔可以次次都由 originalCards clone：一張卡嘅 rule 可以分散喺幾個 source_url
   * （例如 hsbc_everymile 兩條 rule 出自兩份唔同 PDF），咁樣第二個 source 嗰份
   * clone 就會冇咗第一個 source 改過嘅嘢，最後 set 落 mergedCards 直接覆蓋——
   * PR body 會照樣寫「核實過」，但條 rule 嘅 last_verified_at 同新 content_hash
   * 靜靜咁唔見咗。後果係嗰條 rule 永遠顯示過期，而且每次跑都要重新餵 LLM，
   * 永遠短路唔到。
   */
  const workingCards = new Map(originalCards);
  const work = selectWork(cards, options.targetRuleCount ?? 25);

  const emptyResult: Agent1RunResult = {
    prUrl: null,
    prNumber: null,
    branchName: null,
    changed: 0,
    verified: 0,
    totalCostUsd: 0,
    gatePassed: true,
    brokenSources: [],
    repaired: 0,
    questionsRaised: 0,
  };
  if (work.length === 0) return emptyResult;

  const mergedCards = new Map<string, Card>();
  const allNotes: string[] = [];
  const allBroken = new Set<string>();
  const allAttention: string[] = [];
  const allGaps: EvidenceGap[] = [];
  let totalCostUsd = 0;
  let changed = 0;
  let verified = 0;

  for (const sourceWork of work) {
    const knownRules = sourceWork.rules.map(({ cardId: _cardId, ...rest }) => rest);
    const outcome = await runPipelineImpl({
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

    const result = applyWork(workingCards, sourceWork, outcome, nowIso);
    for (const [cardId, card] of result.updatedCards) {
      workingCards.set(cardId, card); // 下個 source 要喺呢個版本上面繼續改
      mergedCards.set(cardId, card);
    }
    allNotes.push(...result.notes);
    for (const source of result.brokenSources) allBroken.add(source);
    allAttention.push(...result.attentionNeeded);
    allGaps.push(...result.evidenceGaps);

    verified += sourceWork.rules.length;
    changed += result.notes.filter((n) => n.startsWith('🔄')).length;
  }

  if (mergedCards.size === 0) {
    return { ...emptyResult, changed, verified, totalCostUsd, brokenSources: [...allBroken] };
  }

  // ── 修復 pass ────────────────────────────────────────────────────
  //
  // evidence 撐唔住個數值嘅 rule，先叫修復 agent 讀返原文提出替代引文。
  //
  // 佢提出嘅引文會被機器逐字驗證（見 repair.ts）——驗到先算數，所以 LLM 作唔到假。
  // 驗到而且個數值一個字都冇郁 → 自動改，唔開 PR question：人喺度睇一眼加唔到
  // 任何嘢。驗唔到 → 開一條 question，等人答。
  //
  // 呢個係成個 loop 收唔收斂嘅關鍵。冇修復 pass，每次 evidence 對唔上都要人手
  // 去搵返句原文；而實測六條入面五條都係「引文寫錯但數值啱」——嗰啲人做同機器
  // 做完全一樣。
  const repair = await runRepairPass({
    gaps: allGaps,
    workingCards,
    provider: options.provider,
    nowIso,
  });
  const { questions, repaired } = repair;
  totalCostUsd += repair.totalCostUsd;
  for (const [cardId, card] of repair.touchedCards) mergedCards.set(cardId, card);
  allNotes.push(...repair.notes);
  allAttention.push(...repair.attentionNeeded);

  // ── 來源漂移檢查 ────────────────────────────────────────────────
  //
  // 問一條所有其他檢查都冇問過嘅嘢：**我哋引用嗰份文件，發卡行自己仲有冇 link？**
  //
  // evidence 逐字驗得過、hash 短路命中、source_moved gate 唔響（host 一樣）、
  // last_verified_at 照更新——但份文件可以係 2020 年嘅版本，而銀行 2026 年
  // 已經換咗第二份。實測 sc_simply_cash_visa 就係噉，差 5 年 9 個月。
  //
  // 一張卡一個額外 fetch，而且只揀有 product_page 嘅卡。讀唔到就靜靜跳過——
  // 呢個係補充檢查，唔應該因為佢而令成個 run 嘅結果變差。
  for (const card of workingCards.values()) {
    const pageUrl = productPageOf(card);
    if (pageUrl === null) continue;

    let html: string;
    try {
      html = (await (options.fetchFn ?? fetchSource)(pageUrl, 'html')).content;
    } catch {
      continue;
    }

    for (const drift of findSourceDrift({ card, productPageUrl: pageUrl, linkedDocs: extractLinkedDocs(html, pageUrl) })) {
      const id = questionId(`${drift.cardId}_${drift.purpose}`, 'source_superseded');
      if (questions.has(id)) continue;
      questions.set(id, {
        question_id: id,
        card_id: drift.cardId,
        rule_id: null,
        kind: 'source_superseded',
        status: 'open',
        question: `我哋引用緊 ${drift.citedUrl}（purpose: ${drift.purpose}），但 ${drift.productPageUrl} 已經冇 link 佢。應該換邊份？`,
        evidence: `卡頁而家 link 緊：\n${drift.linkedDocs.join('\n')}`,
        source_url: drift.productPageUrl,
        raised_at: nowIso,
        raised_by: 'agent1_source_drift',
        answer: null,
        answered_at: null,
      });
      allAttention.push(`${drift.cardId}：引用緊嘅 ${drift.purpose} 文件，發卡行卡頁已經冇 link——已開 question \`${id}\``);
    }
  }

  const gateResults = new Map<string, GateResult>();
  for (const [cardId, newCard] of mergedCards) {
    gateResults.set(cardId, evaluateGate(originalCards.get(cardId) ?? null, newCard));
  }
  const gatePassed = [...gateResults.values()].every((g) => g.passed);

  const files: PRFile[] = [
    ...[...mergedCards.entries()].map(([cardId, card]) => ({
      path: `data/cards/${cardId}.json`,
      content: canonicalStringify(card as unknown as JsonValue),
    })),
    ...[...questions.entries()].map(([id, question]) => ({
      path: `data/questions/${id}.json`,
      content: canonicalStringify(question as unknown as JsonValue),
    })),
  ];

  const dateStr = hongKongDate(now);
  const body = buildPRBody({
    title: '自動核實',
    date: dateStr,
    totalCostUsd,
    sections: [
      { heading: '改動', items: allNotes },
      {
        heading: '❓ 要你答嘅問題',
        intro: '修復 agent 搞唔掂嘅先會開 question。答案要寫返落 `data/questions/`——答過一次就唔會再問。',
        items: [...questions.values()].map((q) => `\`${q.question_id}\`（${q.kind}）：${q.question}`),
      },
      { heading: '⚠️ 需要人手覆核', items: allAttention },
      {
        heading: 'Gate 結果',
        items: [...gateResults.entries()].map(
          ([cardId, gate]) => `${cardId}：${gate.passed ? '✅ 全過' : `⛔ ${gate.reasons.join('、')}`}`,
        ),
      },
    ],
  });

  // attentionNeeded 一樣要標 needs-review：gate 全過唔代表唔使人手睇——
  // 「頁面搵唔到呢條 rule」「疑似排期生效」呢啲數值根本冇郁，gate 冇嘢可以
  // 冧，但正正就係最需要人手覆核嘅情況。淨係睇 gatePassed 嘅話，呢種 PR
  // 表面睇落乾淨，人就會順手 merge。
  const labels: string[] = [];
  if (!gatePassed || allAttention.length > 0 || questions.size > 0) labels.push('needs-review');
  if (allBroken.size > 0) labels.push('broken-source');

  const pr = await openPRImpl({
    owner,
    repo,
    token: options.githubToken,
    branchName: `agent1/${dateStr}`,
    files,
    title: `chore(agent1): weekly check — ${changed} changed, ${verified} verified`,
    body,
    labels,
  });

  return {
    prUrl: pr.url,
    prNumber: pr.number,
    branchName: pr.branchName,
    changed,
    verified,
    totalCostUsd,
    gatePassed,
    brokenSources: [...allBroken],
    repaired,
    questionsRaised: questions.size,
  };
}
