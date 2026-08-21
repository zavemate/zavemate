import { extractMainContent, FetchError, type RenderMode, fetchSource, sha256 } from '@zavemate/core';
import { buildSystemPrompt, ExtractionResult, type KnownRule } from './extraction.ts';
import { LLMError, type LLMProvider, type LLMUsage } from './llm.ts';

/**
 * BUILD_SPEC §6.1 共用流程：fetch → extractMainContent → sha256 → hash 短路
 * → callLLM → 驗證。evaluateGate 唔喺呢度做——嗰個要成張 Card（新舊對比），
 * pipeline 淨係負責攞返「呢個 source_url 而家嘅數值」，call 嗰邊（run.ts）
 * 自己砌返成張 Card 先過 evaluateGate。
 */
export interface PipelineInput {
  url: string;
  renderMode: RenderMode;
  /** 現存 provenance.content_hash（同一個 source_url 底下嘅任何一條 rule都應該一樣）。null = 未 check 過。 */
  existingContentHash: string | null;
  knownRules: KnownRule[];
  cardName: string;
  provider: LLMProvider;
  /** schema 驗證失敗時升級重試一次嘅 provider（§6.3：Sonnet 唔掂就升 Opus）。 */
  fallbackProvider?: LLMProvider;
}

export type PipelineOutcome =
  | { kind: 'fetch_failed'; error: FetchError }
  | { kind: 'unchanged'; contentHash: string; fetchedAt: string }
  | { kind: 'extracted'; contentHash: string; fetchedAt: string; result: ExtractionResult; usage: LLMUsage[] };

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  let fetchResult;
  try {
    fetchResult = await fetchSource(input.url, input.renderMode);
  } catch (error) {
    if (error instanceof FetchError) return { kind: 'fetch_failed', error };
    throw error;
  }

  const mainContent = extractMainContent(fetchResult.content);
  const contentHash = sha256(mainContent);

  // hash 短路（§6.1 步驟 4）：內容冇變，完全跳過 LLM。
  if (input.existingContentHash !== null && contentHash === input.existingContentHash) {
    return { kind: 'unchanged', contentHash, fetchedAt: fetchResult.fetchedAt };
  }

  const systemPrompt = buildSystemPrompt(input.cardName, input.knownRules);
  const usage: LLMUsage[] = [];

  const tryExtract = async (provider: LLMProvider) => {
    const llmResult = await provider.extractJson({ systemPrompt, userContent: mainContent });
    usage.push(llmResult.usage);
    return ExtractionResult.safeParse(llmResult.data);
  };

  let parsed = await tryExtract(input.provider);
  if (!parsed.success && input.fallbackProvider) {
    parsed = await tryExtract(input.fallbackProvider);
  }
  if (!parsed.success) {
    throw new LLMError(`LLM 回覆連升級 provider 都唔符合 schema：${parsed.error.message}`);
  }

  return { kind: 'extracted', contentHash, fetchedAt: fetchResult.fetchedAt, result: parsed.data, usage };
}
