/**
 * LLM 呼叫嘅 provider-agnostic 介面（BUILD_SPEC §6.3）。
 *
 * 正式方案係 Anthropic Sonnet/Opus（見 CLAUDE.md「Claude Code 訂閱留返俾開發用」
 * 呢條決策）。而家（2026-08-21）暫時用 DeepSeek 頂住，冇改 BUILD_SPEC 本身——
 * 淨係換一個 LLMProvider adapter，唔會動 pipeline 邏輯。
 */
export interface LLMUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

export interface LLMResult {
  /** LLM 回覆嘅原始 JSON（未經 Zod 驗證，call 嗰邊自己驗）。 */
  data: unknown;
  usage: LLMUsage;
}

export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMError';
  }
}

export interface LLMProvider {
  readonly name: string;
  /** 用 JSON mode 攞結構化回覆。 */
  extractJson(params: { systemPrompt: string; userContent: string }): Promise<LLMResult>;
}
