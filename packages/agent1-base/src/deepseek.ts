import { LLMError, type LLMProvider, type LLMResult } from './llm.ts';

/**
 * ⚠️ 暫時性 provider（見 llm.ts 頂部註解）。
 *
 * 定價會變，用之前去 https://api-docs.deepseek.com/quick_start/pricing 對一對，
 * 唔好盲信呢度嘅數字（同 BUILD_SPEC §6.3 「唔好 hardcode 記憶中嘅 model ID」
 * 係同一個精神，套用喺定價度）。呢度用 off-peak 價，peak time（UTC 16:30–00:30）
 * 實際貴啲，會令 cost_usd 偏低估。
 */
const PRICING_USD_PER_MILLION_TOKENS = {
  cacheHit: 0.07,
  cacheMiss: 0.22,
  output: 0.66,
};

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export function createDeepSeekProvider(apiKey: string, model = 'deepseek-chat'): LLMProvider {
  return {
    name: `deepseek:${model}`,
    async extractJson({ systemPrompt, userContent }): Promise<LLMResult> {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        throw new LLMError(`DeepSeek API 失敗：HTTP ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as DeepSeekResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LLMError('DeepSeek 冇喺 response 度返 JSON 內容');
      }

      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch (error) {
        throw new LLMError(`DeepSeek 返嘅內容唔係合法 JSON：${content.slice(0, 200)}`, { cause: error });
      }

      const cacheHitTokens = body.usage?.prompt_cache_hit_tokens ?? 0;
      const cacheMissTokens = body.usage?.prompt_cache_miss_tokens ?? body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.completion_tokens ?? 0;
      const costUsd =
        (cacheHitTokens / 1_000_000) * PRICING_USD_PER_MILLION_TOKENS.cacheHit +
        (cacheMissTokens / 1_000_000) * PRICING_USD_PER_MILLION_TOKENS.cacheMiss +
        (outputTokens / 1_000_000) * PRICING_USD_PER_MILLION_TOKENS.output;

      return {
        data,
        usage: {
          tokensIn: body.usage?.prompt_tokens ?? 0,
          tokensOut: outputTokens,
          costUsd,
          model: body.model ?? model,
        },
      };
    },
  };
}
