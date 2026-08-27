import { assessExtraction, extractMainContent, FetchError, fetchSource, sha256 } from '@zavemate/core';
import type { Source } from '@zavemate/schema';
import { buildPromoSystemPrompt, type ExistingPromotion, PromoExtractionResult } from './extraction.ts';
import { parseFeedItems, selectFeedWork } from './feed.ts';

/**
 * §6.1 共用流程，同 Agent 1 一樣：
 * fetch → extractMainContent → 抽取薄唔薄 → sha256 → hash 短路 → callLLM → 驗證。
 *
 * 分別喺 hash 短路嘅意義：Agent 1 短路 = 「呢條 rule 冇變」；Agent 2 短路 =
 * 「呢版冇新優惠出現，亦冇舊優惠改過」。後者慳嘅唔止 token——優惠頁通常好長，
 * 唔短路嘅話每次跑都要餵成版嘢。
 */
export interface PromoLLMProvider {
  name: string;
  extractJson(input: { systemPrompt: string; userContent: string }): Promise<{
    data: unknown;
    usage: { tokensIn: number; tokensOut: number; costUsd: number; model: string };
  }>;
}

export type PromoPipelineOutcome =
  | { kind: 'fetch_failed'; error: FetchError }
  | { kind: 'extraction_too_thin'; reason: string }
  | { kind: 'unchanged'; contentHash: string }
  | {
      kind: 'extracted';
      contentHash: string;
      result: PromoExtractionResult;
      usage: Array<{ tokensIn: number; tokensOut: number; costUsd: number; model: string }>;
      /**
       * Feed 專用：剪剩 feed 而家仲有嗰批 guid 嘅 hash map，直接寫返落
       * `sources.json`。唔喺度嘅 guid（抽取太薄、今次跑唔切）特登唔寫，
       * 下次會再試——寫咗就等於話「呢篇睇過」，但其實冇。
       */
      itemHashes?: Record<string, string>;
      /** Feed 專用：逐篇嘅處理結果，原封不動擺落 PR body。 */
      itemNotes?: string[];
    };

export interface PromoPipelineInput {
  source: Source;
  cards: Array<{ card_id: string; card_name: string }>;
  existing: ExistingPromotion[];
  today: string;
  provider: PromoLLMProvider;
}

export async function runPromoPipeline(input: PromoPipelineInput): Promise<PromoPipelineOutcome> {
  let fetched;
  try {
    fetched = await fetchSource(input.source.url, input.source.render_mode);
  } catch (error) {
    if (error instanceof FetchError) return { kind: 'fetch_failed', error };
    throw error;
  }

  if (input.source.feed_format === 'rss') {
    return runFeedPipeline(input, fetched.content);
  }

  const content = extractMainContent(fetched.content);

  // 擺喺 hash 短路之前：穩定嘅抽取失敗（例如圖片型 PDF 每次都俾同樣嗰幾十字）
  // 會 hash 對得上、判 unchanged，然後我哋就當「呢版冇新優惠」——實情係我哋
  // 由頭到尾未讀過佢。
  const assessment = assessExtraction(content);
  if (assessment.tooThin) return { kind: 'extraction_too_thin', reason: assessment.reason! };

  const contentHash = sha256(content);
  if (input.source.content_hash !== null && contentHash === input.source.content_hash) {
    return { kind: 'unchanged', contentHash };
  }

  const systemPrompt = buildPromoSystemPrompt({
    sourceLabel: input.source.label,
    sourceType: input.source.source_type,
    cards: input.cards,
    existing: input.existing,
    today: input.today,
  });

  const llm = await input.provider.extractJson({ systemPrompt, userContent: content });
  const parsed = PromoExtractionResult.safeParse(llm.data);
  if (!parsed.success) {
    // 唔重試升級 provider（Agent 1 嗰套）——Agent 2 抽唔到就係抽唔到，
    // 一版優惠頁冇嘢比一版優惠頁有錯嘢好。
    throw new Error(`LLM 回覆唔符合 schema：${parsed.error.message}`);
  }

  return { kind: 'extracted', contentHash, result: parsed.data, usage: [llm.usage] };
}

/**
 * Feed 版流程：整個 feed hash 做快速閘 → 拆 item → 逐篇 hash 短路 → 逐篇抽取。
 *
 * 兩層 hash 各有用途：feed 層嗰個令「乜都冇變」嘅週期連 XML 都唔使拆；item 層
 * 嗰個先係真正慳嘢嗰個，因為 feed 會為咗 lastBuildDate、留言數呢啲無關嘢而變。
 */
async function runFeedPipeline(input: PromoPipelineInput, rawXml: string): Promise<PromoPipelineOutcome> {
  const wholeText = extractMainContent(rawXml);

  const assessment = assessExtraction(wholeText);
  if (assessment.tooThin) return { kind: 'extraction_too_thin', reason: assessment.reason! };

  const contentHash = sha256(wholeText);
  if (input.source.content_hash !== null && contentHash === input.source.content_hash) {
    return { kind: 'unchanged', contentHash };
  }

  const items = parseFeedItems(rawXml);
  if (items.length === 0) {
    // 聲明咗係 rss 但拆唔出 item = 我哋讀緊嘅根本唔係嗰個 feed（改版、錯誤頁、
    // WAF 攔截頁）。當抽取失敗好過當「今期冇優惠」。
    return {
      kind: 'extraction_too_thin',
      reason: `聲明咗 feed_format: rss，但拆唔出任何 <item>（${wholeText.length} 個字元）`,
    };
  }

  const work = selectFeedWork(items, input.source.item_hashes);
  const itemHashes: Record<string, string> = { ...work.carried };
  const itemNotes = [...work.notes];
  const promotions: PromoExtractionResult['promotions'] = [];
  const usage: Array<{ tokensIn: number; tokensOut: number; costUsd: number; model: string }> = [];

  for (const { item, text, hash } of work.toProcess) {
    const systemPrompt = buildPromoSystemPrompt({
      sourceLabel: `${input.source.label}／${item.title}`,
      sourceType: input.source.source_type,
      cards: input.cards,
      existing: input.existing,
      today: input.today,
    });

    const llm = await input.provider.extractJson({ systemPrompt, userContent: text });
    const parsed = PromoExtractionResult.safeParse(llm.data);
    if (!parsed.success) {
      throw new Error(`LLM 回覆唔符合 schema（${item.guid}）：${parsed.error.message}`);
    }

    usage.push(llm.usage);
    promotions.push(...parsed.data.promotions);
    // 抽取成功先寫 hash。中途 throw 嘅話，已經寫咗嗰幾篇唔會存落 sources.json
    // （成個 run 都冇 PR），下次由頭嚟過。
    itemHashes[item.guid] = hash;
    itemNotes.push(`📄 ${item.title}：抽到 ${parsed.data.promotions.length} 個優惠`);
  }

  return { kind: 'extracted', contentHash, result: { promotions }, usage, itemHashes, itemNotes };
}
