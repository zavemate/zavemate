import { assessExtraction, extractMainContent, FetchError, fetchSource, sha256 } from '@zavemate/core';
import type { Source } from '@zavemate/schema';
import { buildPromoSystemPrompt, type ExistingPromotion, PromoExtractionResult } from './extraction.ts';

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
