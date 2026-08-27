import { describe, expect, it } from 'vitest';
import type { Source } from '@zavemate/schema';
import { type PromoLLMProvider, runPromoPipeline } from '../pipeline.ts';

const poison: PromoLLMProvider = {
  name: 'poison',
  extractJson() {
    throw new Error('唔應該叫到 LLM');
  },
};

function source(overrides: Partial<Source> = {}): Source {
  return {
    source_id: 'hsbc_offers',
    label: 'HSBC 信用卡優惠',
    url: 'https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/rewards/terms-and-conditions.pdf',
    render_mode: 'pdf',
    source_type: 'official',
    card_ids: ['hsbc_red'],
    content_hash: null,
    feed_format: null,
    item_hashes: {},
    feed_max_pages: 2,
    last_checked_at: null,
    check_fail_count: 0,
    active: true,
    ...overrides,
  };
}

const base = {
  cards: [{ card_id: 'hsbc_red', card_name: 'HSBC Red Credit Card', issuer: 'HSBC' }],
  existing: [],
  today: '2026-08-27',
};

describe('runPromoPipeline', () => {
  it('fetch 失敗 → fetch_failed，唔會叫 LLM', async () => {
    const outcome = await runPromoPipeline({
      ...base,
      source: source({ url: 'http://127.0.0.1:9/nope', render_mode: 'html' }),
      provider: poison,
    });
    expect(outcome.kind).toBe('fetch_failed');
  });

  it('圖片型 PDF → extraction_too_thin，唔會叫 LLM', async () => {
    // 呢個檢查一定要喺 hash 短路之前：穩定嘅抽取失敗會 hash 對得上、判 unchanged，
    // 然後我哋就當「呢版冇新優惠」——實情係由頭到尾未讀過佢。
    const outcome = await runPromoPipeline({
      ...base,
      source: source({
        url: 'https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/reward-scheme-terms-and-conditions.pdf',
      }),
      provider: poison,
    });
    expect(outcome.kind).toBe('extraction_too_thin');
  });

  it('content_hash 冇變 → unchanged，完全唔會叫 LLM', async () => {
    const first = await runPromoPipeline({
      ...base,
      source: source(),
      provider: {
        name: 'once',
        async extractJson() {
          return { data: { promotions: [] }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'fake' } };
        },
      },
    });
    expect(first.kind).toBe('extracted');
    const hash = (first as { contentHash: string }).contentHash;

    const second = await runPromoPipeline({ ...base, source: source({ content_hash: hash }), provider: poison });
    expect(second.kind).toBe('unchanged');
  });

  it('LLM 回覆唔符合 schema → throw，唔會靜靜傳一個爛結果落去', async () => {
    await expect(
      runPromoPipeline({
        ...base,
        source: source(),
        provider: {
          name: 'bad',
          async extractJson() {
            return { data: { promotions: [{ 亂寫: true }] }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'fake' } };
          },
        },
      }),
    ).rejects.toThrow(/schema/);
  });
});
