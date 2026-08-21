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

describe('runPipeline（hash 短路，唔使真 LLM）', () => {
  it('content_hash 冇變 → unchanged，完全唔會叫 LLM', async () => {
    // 先真係 fetch 一次攞返實際 hash，等個 test 反映真實情況（唔係憑估）。
    const fetched = await fetchSource('https://example.com/', 'html');
    const currentHash = sha256(extractMainContent(fetched.content));

    const outcome = await runPipeline({
      url: 'https://example.com/',
      renderMode: 'html',
      existingContentHash: currentHash,
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
      url: 'https://example.com/',
      renderMode: 'html',
      existingContentHash: null,
      knownRules: [],
      cardName: 'Demo Card',
      provider: trackingProvider,
    });

    expect(called).toBe(true);
  });
});

describe.skipIf(!deepSeekKey)('runPipeline（integration，真係打 DeepSeek）', () => {
  it('對真實渣打 Simply Cash 官網頁面抽到啱嘅回贈率', async () => {
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
  }, 60_000);
});

if (!deepSeekKey) {
  describe('runPipeline（skip 訊息）', () => {
    it('冇 DEEPSEEK_API_KEY，integration test 已 skip', () => {
      console.warn('冇搵到 DEEPSEEK_API_KEY，pipeline integration test 已 skip。');
      expect(true).toBe(true);
    });
  });
}
