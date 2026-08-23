import { extractMainContent, fetchSource, sha256 } from '@zavemate/core';
import { describe, expect, it } from 'vitest';
import { createDeepSeekProvider } from '../deepseek.ts';
import type { LLMProvider } from '../llm.ts';
import { runPipeline } from '../pipeline.ts';

try {
  process.loadEnvFile();
} catch {
  // 冇 .env 就算。
}

const deepSeekKey = process.env.DEEPSEEK_API_KEY;

const poisonProvider: LLMProvider = {
  name: 'poison',
  extractJson() {
    throw new Error('唔應該叫到 LLM——hash 冇變就要短路');
  },
};

/**
 * 用一份真實條款 PDF，唔用 example.com——example.com 淨係得約 170 個字元純文字，
 * 會被 assessExtraction 正確咁判做「抽取太薄」，短路根本行唔到嗰步。
 */
const REAL_TNC = 'https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/rewards/terms-and-conditions.pdf';
let cachedHash: string | null = null;
async function realHash(): Promise<string> {
  if (cachedHash === null) cachedHash = sha256(extractMainContent((await fetchSource(REAL_TNC, 'pdf')).content));
  return cachedHash;
}

describe('runPipeline（hash 短路，唔使真 LLM）', () => {
  it('content_hash 冇變 → unchanged，完全唔會叫 LLM', async () => {
    // 先真係 fetch 一次攞返實際 hash，等個 test 反映真實情況（唔係憑估）。
    const outcome = await runPipeline({
      url: REAL_TNC,
      renderMode: 'pdf',
      existingContentHash: await realHash(),
      knownRules: [],
      cardName: 'Demo Card',
      provider: poisonProvider,
    });

    expect(outcome.kind).toBe('unchanged');
  });

  it('existingContentHash 係 null（未 check 過）→ 照樣要叫 LLM', async () => {
    let called = false;
    const trackingProvider: LLMProvider = {
      name: 'tracking',
      async extractJson() {
        called = true;
        return { data: { rules: [] }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'fake' } };
      },
    };

    await runPipeline({
      url: REAL_TNC,
      renderMode: 'pdf',
      existingContentHash: null,
      knownRules: [],
      cardName: 'Demo Card',
      provider: trackingProvider,
    });

    expect(called).toBe(true);
  });

  it('圖片型 PDF（抽唔到文字）→ extraction_too_thin，唔會餵 LLM', async () => {
    // HSBC 呢份 reward scheme 條款係 4 頁圖片，extractMainContent 只抽到約 101 字元。
    const outcome = await runPipeline({
      url: 'https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/reward-scheme-terms-and-conditions.pdf',
      renderMode: 'pdf',
      existingContentHash: null,
      knownRules: [],
      cardName: 'HSBC Red Credit Card',
      provider: poisonProvider,
    });

    expect(outcome.kind).toBe('extraction_too_thin');
  });
});

describe.skipIf(!deepSeekKey)('runPipeline（integration，真係打 DeepSeek）', () => {
  it('對真實渣打 Simply Cash 官網頁面抽到啱嘅回贈率', { timeout: 60_000 }, async () => {
    const provider = createDeepSeekProvider(deepSeekKey!);

    const outcome = await runPipeline({
      url: 'https://www.sc.com/hk/credit-cards/simplycash/',
      renderMode: 'html',
      existingContentHash: null, // 迫佢一定要叫 LLM
      knownRules: [
        {
          rule_id: 'sc_simply_cash_visa_local',
          label: '本地港幣簽賬',
          current: { type: 'cash_rebate', rate: 0.015, points_per_hkd: null, hkd_per_mile: null },
        },
        {
          rule_id: 'sc_simply_cash_visa_overseas',
          label: '海外（外幣）簽賬',
          current: { type: 'cash_rebate', rate: 0.02, points_per_hkd: null, hkd_per_mile: null },
        },
      ],
      cardName: 'Standard Chartered Simply Cash Visa Card',
      provider,
    });

    expect(outcome.kind).toBe('extracted');
    if (outcome.kind !== 'extracted') return;

    expect(outcome.result.rules).toHaveLength(2);
    const local = outcome.result.rules.find((r) => r.rule_id === 'sc_simply_cash_visa_local');
    expect(local?.found).toBe(true);
    expect(local?.reward?.rate).toBeCloseTo(0.015);

    expect(outcome.usage.length).toBeGreaterThan(0);
    expect(outcome.usage[0]!.costUsd).toBeGreaterThan(0);
  });
});

if (!deepSeekKey) {
  describe('runPipeline（skip 訊息）', () => {
    it('冇 DEEPSEEK_API_KEY，integration test 已 skip', () => {
      console.warn('冇搵到 DEEPSEEK_API_KEY，pipeline integration test 已 skip。');
      expect(true).toBe(true);
    });
  });
}
