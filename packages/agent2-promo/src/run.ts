import { openPR, type PRFile } from '@zavemate/core';
import { type Card, canonicalStringify, type JsonValue, type Promotion, type Source, type Sources } from '@zavemate/schema';
import { applyExtractedPromotions } from './apply.ts';
import type { SuspectedDuplicate } from './dedupe.ts';
import { applyExpiry, findExpired } from './expire.ts';
import { cardsForSource, existingForPrompt, loadCards, loadPromotions, loadSources } from './load.ts';
import { quarterLabel } from './id.ts';
import { type PromoLLMProvider, runPromoPipeline } from './pipeline.ts';

export interface Agent2RunResult {
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  added: number;
  updated: number;
  expired: number;
  proposedSources: number;
  totalCostUsd: number;
  brokenSources: string[];
}

export interface Agent2RunOptions {
  provider: PromoLLMProvider;
  githubToken: string;
  owner?: string;
  repo?: string;
  now?: Date;
  /** 淨係測試用——唔提供就由 data/ 讀真嘢、打真 GitHub API。 */
  openPRFn?: typeof openPR;
  runPipelineFn?: typeof runPromoPipeline;
  cards?: Card[];
  promotions?: Map<string, Promotion>;
  sourcesFile?: Sources;
}

/** 由官方 URL 砌一個穩定嘅 source_id——同一條 URL 唔會提議兩次。 */
function sourceIdFor(url: string, cardIds: string[]): string {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '_');
    } catch {
      return 'unknown';
    }
  })();
  return `${host}_${cardIds[0] ?? 'multi'}_official`.toLowerCase().replace(/_+/g, '_');
}

/** §6.5 Agent 2 全流程：過期清理 → 逐個 source 跑 → apply → 提議官方來源 → 開 PR。 */
export async function runAgent2(options: Agent2RunOptions): Promise<Agent2RunResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const owner = options.owner ?? 'zavemate';
  const repo = options.repo ?? 'zavemate';
  const openPRImpl = options.openPRFn ?? openPR;
  const runPipelineImpl = options.runPipelineFn ?? runPromoPipeline;

  const cards = options.cards ?? loadCards();
  const promotions = options.promotions ?? loadPromotions();
  const sourcesFile = options.sourcesFile ?? loadSources();

  const notes: string[] = [];
  const attention: string[] = [];
  const duplicates: SuspectedDuplicate[] = [];
  const touched = new Map<string, Promotion>();
  const brokenSources: string[] = [];
  let totalCostUsd = 0;
  let added = 0;
  let updatedCount = 0;

  // ── 步驟 0：過期清理 ──────────────────────────────────────────────
  const expiry = findExpired([...promotions.values()], today);
  notes.push(...expiry.notes);
  for (const promo of applyExpiry([...promotions.values()], expiry.expired)) {
    if (expiry.expired.includes(promo.promotion_id)) touched.set(promo.promotion_id, promo);
  }

  // ── 步驟 1–3：逐個 active source ──────────────────────────────────
  const nextSources: Source[] = [];
  const proposed = new Map<string, Source>();

  let processedAnySource = false;

  for (const source of sourcesFile.sources) {
    if (!source.active) {
      nextSources.push(source);
      continue;
    }
    processedAnySource = true;

    const outcome = await runPipelineImpl({
      source,
      cards: cardsForSource(cards, source),
      existing: existingForPrompt(promotions, source.card_ids, quarterLabel(today)),
      today,
      provider: options.provider,
    });

    if (outcome.kind === 'fetch_failed' || outcome.kind === 'extraction_too_thin') {
      const failCount = source.check_fail_count + 1;
      nextSources.push({ ...source, check_fail_count: failCount, last_checked_at: nowIso });
      const why = outcome.kind === 'fetch_failed' ? outcome.error.message : outcome.reason;
      notes.push(`⚠️ ${source.source_id}：${why}，check_fail_count → ${failCount}`);
      if (failCount >= 3) brokenSources.push(source.url);
      continue;
    }

    if (outcome.kind === 'unchanged') {
      nextSources.push({ ...source, check_fail_count: 0, last_checked_at: nowIso });
      notes.push(`✓ ${source.source_id}：內容冇變（hash 一樣），冇新優惠，唔使餵 LLM`);
      continue;
    }

    for (const usage of outcome.usage) totalCostUsd += usage.costUsd;
    nextSources.push({
      ...source,
      content_hash: outcome.contentHash,
      // Feed 先有 itemHashes。佢已經剪剩 feed 而家仲有嗰批 guid，所以係整個
      // 取代唔係合併——合併嘅話跌咗出 feed 嘅舊文會永遠留喺度。
      ...(outcome.itemHashes ? { item_hashes: outcome.itemHashes } : {}),
      check_fail_count: 0,
      last_checked_at: nowIso,
    });
    if (outcome.itemNotes) for (const note of outcome.itemNotes) notes.push(`    ${note}`);

    const result = applyExtractedPromotions({
      extracted: outcome.result.promotions,
      existing: promotions,
      existingForPrompt: existingForPrompt(promotions, source.card_ids, quarterLabel(today)),
      sourceUrl: source.url,
      sourceType: source.source_type,
      today,
      nowIso,
    });

    for (const [id, promo] of result.updated) {
      if (promotions.has(id)) updatedCount += 1;
      else added += 1;
      touched.set(id, promo);
    }

    // 每個跑過嘅 source 都要有一行，就算佢乜都搵唔到。
    //
    // 第一次真跑就撞到呢個：HSBC 同第三方兩個 source 都成功抽取、都叫咗 LLM、
    // 都搵到 0 個優惠——然後 PR body 一個字都冇提過佢哋。個 PR 睇落好似只跑過
    // 一個 source。對事實層嚟講，「查過冇嘢」同「冇查過」唔可以分唔出。
    const found = outcome.result.promotions.length;
    const written = result.updated.size;
    notes.push(
      found === 0
        ? `✓ ${source.source_id}：內容變咗，重新掃過，冇搵到限時優惠`
        : `✓ ${source.source_id}：抽到 ${found} 個優惠，寫入 ${written} 個${found > written ? `（${found - written} 個被過濾，見下面 ⚠️）` : ''}`,
    );
    notes.push(...result.notes);
    attention.push(...result.attentionNeeded);
    duplicates.push(...result.suspectedDuplicates);

    // ── 提議官方來源（crowdsourced → official 嘅升級路徑）────────────
    if (source.source_type !== 'third_party') continue;
    const knownUrls = new Set(sourcesFile.sources.map((s) => s.url));
    for (const promo of outcome.result.promotions) {
      const url = promo.official_source_url;
      if (url === null || knownUrls.has(url) || proposed.has(url)) continue;
      const cardIds = promo.card_id ? [promo.card_id] : [];
      proposed.set(url, {
        source_id: sourceIdFor(url, cardIds),
        label: `${promo.title}（由 ${source.label} 發現嘅官方出處）`,
        url,
        render_mode: url.toLowerCase().endsWith('.pdf') ? 'pdf' : 'html',
        source_type: 'official',
        card_ids: cardIds,
        content_hash: null,
        // 銀行官方優惠頁唔會係 feed，所以呢兩個欄位由零開始。
        feed_format: null,
        item_hashes: {},
        last_checked_at: null,
        check_fail_count: 0,
        active: true,
      });
    }
  }

  // 只要行過至少一個 source 就開 PR，就算冇任何優惠改動。
  //
  // 唔開嘅話會蝕三樣嘢：
  // 1. check_fail_count 唔會 persist——一個次次都失敗嘅 source 永遠去唔到 3，
  //    broken-source 永遠唔會標，啲來源會靜靜哋爛咗。
  // 2. content_hash 唔會寫返——一版成日變但冇優惠嘅頁，每次跑都要重新餵 LLM。
  // 3. 冇咗「我哋今日檢查過」嘅紀錄。對一個事實層嚟講，「查過冇嘢」同「冇查過」
  //    唔可以分唔出。
  //
  // 代價係逢二／四／六都會有一個可能淨係改 timestamp 嘅 PR。同 Agent 1 一樣，
  // 靠 label 分辨邊啲要真係睇。
  if (touched.size === 0 && proposed.size === 0 && !processedAnySource) {
    return {
      prUrl: null,
      prNumber: null,
      branchName: null,
      added: 0,
      updated: 0,
      expired: expiry.expired.length,
      proposedSources: 0,
      totalCostUsd,
      brokenSources,
    };
  }

  // ── 步驟 4：開 PR ────────────────────────────────────────────────
  const files: PRFile[] = [...touched.entries()].map(([id, promo]) => ({
    path: `data/promotions/${id}.json`,
    content: canonicalStringify(promo as unknown as JsonValue),
  }));

  if (proposed.size > 0 || sourcesFile.sources.length > 0) {
    files.push({
      path: 'data/sources.json',
      content: canonicalStringify({ note: sourcesFile.note, sources: [...nextSources, ...proposed.values()] } as unknown as JsonValue),
    });
  }

  const body = [`**限時優惠掃描 —— ${today}**`, '', '### 改動', ...notes.map((n) => `- ${n}`)];

  if (proposed.size > 0) {
    body.push(
      '',
      '### 🔎 提議新增官方來源',
      '第三方平台快，但唔準；官方準，但慢。以下係第三方文章 link 住嘅官方出處——merge 咗之後，下次跑就會由官方版覆寫同一個 promotion_id，confidence 升做 official（會冧 confidence_upgraded gate 要人確認）。',
      ...[...proposed.values()].map((s) => `- \`${s.source_id}\`：${s.url}`),
    );
  }
  if (duplicates.length > 0) {
    body.push(
      '',
      '### ⚠️ 疑似重複',
      '冇自動合併——自動合併等於我哋自己做「似唔似」判斷，正正係 §6.5 叫唔好做嘅嘢。',
      ...duplicates.map((d) => `- ${d.extractedSlug} vs ${d.existingId}：${d.reason}`),
    );
  }
  if (attention.length > 0) body.push('', '### ⚠️ 需要人手覆核', ...attention.map((n) => `- ${n}`));
  body.push('', '### 成本', `- 總 LLM cost：$${totalCostUsd.toFixed(4)}`);

  const labels: string[] = [];
  if (attention.length > 0 || duplicates.length > 0 || proposed.size > 0) labels.push('needs-review');
  if (brokenSources.length > 0) labels.push('broken-source');

  const pr = await openPRImpl({
    owner,
    repo,
    token: options.githubToken,
    branchName: `agent2/${today}`,
    files,
    title: `chore(agent2): promo scan — ${added} new, ${updatedCount} updated, ${expiry.expired.length} expired`,
    body: body.join('\n'),
    labels,
  });

  return {
    prUrl: pr.url,
    prNumber: pr.number,
    branchName: pr.branchName,
    added,
    updated: updatedCount,
    expired: expiry.expired.length,
    proposedSources: proposed.size,
    totalCostUsd,
    brokenSources,
  };
}
