import { describe, expect, it } from 'vitest';
import { FetchError } from '@zavemate/core';
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

describe('feed 揭唔完', () => {
  const FEED = 'https://feed.test/promo/feed';

  function page(guid: string, title: string): string {
    const body = `<p>推廣期由2026年8月6日至2026年9月30日，一經登記，憑滙豐信用卡簽賬滿HK$1,000可享額外回贈。每位合資格客戶於整個推廣期之額外獎賞上限為HK$500。額外獎賞將於2026年11月30日或之前存入信用卡賬戶。條款及細則適用，詳情請參閱銀行官方網站公布嘅完整條款。推廣期內合資格簽賬須以港幣結算。</p>`;
    return `<rss><channel><item><guid>${guid}</guid><link>https://x.test/${guid}</link><title>${title}</title><pubDate>Wed, 05 Aug 2026 16:00:36 +0000</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
  }

  const source = (): Source => ({
    source_id: 'feed',
    label: 'Feed',
    url: FEED,
    render_mode: 'html',
    source_type: 'third_party',
    card_ids: [],
    content_hash: null,
    feed_format: 'rss',
    item_hashes: {},
    feed_max_pages: 2,
    last_checked_at: null,
    check_fail_count: 0,
    active: true,
  });

  const empty = {
    name: 'empty',
    async extractJson() {
      return { data: { promotions: [] }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, model: 'fake' } };
    },
  };

  it('第 2 頁讀唔到 → 一條 item hash 都唔寫，下次由頭嚟過', async () => {
    // 唔噉做嘅話：下次跑第 1 頁全部命中 → allKnown → 停，第 2 頁永遠唔會再揭，
    // 而佢從來未成功讀過。sources.json 望落一切正常。
    const outcome = await runPromoPipeline({
      ...base,
      source: source(),
      provider: empty,
      fetchFn: async (url: string) => {
        if (url.includes('paged=2')) throw new FetchError('fetch 超時（20000ms）', url);
        return { content: page('p1', '第一篇'), status: 200, fetchedAt: '2026-08-27T00:00:00.000Z' };
      },
    });

    expect(outcome.kind).toBe('extracted');
    const extracted = outcome as Extract<typeof outcome, { kind: 'extracted' }>;
    expect(extracted.itemHashes).toBeUndefined();
    expect(extracted.itemNotes!.join('\n')).toContain('下次由第一頁重新讀');
  });

  it('兩頁都揭到 → 照寫 hash', async () => {
    const outcome = await runPromoPipeline({
      ...base,
      source: source(),
      provider: empty,
      fetchFn: async (url: string) => ({
        content: url.includes('paged=2') ? page('p2', '第二篇') : page('p1', '第一篇'),
        status: 200,
        fetchedAt: '2026-08-27T00:00:00.000Z',
      }),
    });

    const extracted = outcome as Extract<typeof outcome, { kind: 'extracted' }>;
    expect(Object.keys(extracted.itemHashes!).sort()).toEqual(['p1', 'p2']);
  });
});
