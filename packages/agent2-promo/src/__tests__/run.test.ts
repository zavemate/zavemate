import { describe, expect, it } from 'vitest';
import type { Card, Promotion, Sources } from '@zavemate/schema';
import type { ExtractedPromotion } from '../extraction.ts';
import type { PromoPipelineOutcome } from '../pipeline.ts';
import { runAgent2 } from '../run.ts';

const NOW = new Date('2026-08-27T04:00:00.000Z');

const card = { card_id: 'hsbc_red', card_name: 'HSBC Red', active: true } as Card;

function source(overrides: Partial<Sources['sources'][number]> = {}): Sources['sources'][number] {
  return {
    source_id: 'hkcashrebate',
    label: 'HKCashRebate',
    url: 'https://hkcashrebate.com/',
    render_mode: 'html',
    source_type: 'third_party',
    card_ids: ['hsbc_red'],
    content_hash: null,
    feed_format: null,
    item_hashes: {},
    feed_max_pages: 4,
    last_checked_at: null,
    check_fail_count: 0,
    active: true,
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedPromotion> = {}): ExtractedPromotion {
  return {
    card_id: 'hsbc_red',
    slug: 'summer_dining',
    title: '夏日餐飲額外回贈',
    reward: { type: 'cash_rebate', rate: 0.06, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap_value: null,
    cap_unit: null,
    match_channel: null,
    match_currency: null,
    match_merchant_include: null,
    scope_not_expressible: false,
    start_date: '2026-08-01',
    end_date: '2026-10-31',
    requires_registration: false,
    ended_early: false,
    reward_includes_base: true,
    looks_like_base_terms: false,
    official_source_url: null,
    confidence: 'crowdsourced',
    evidence_excerpt: '夏日餐飲額外 6% 回贈',
    ...overrides,
  };
}

interface Captured {
  branchName: string;
  title: string;
  body: string;
  labels?: string[];
  files: Array<{ path: string; content: string }>;
}

async function run(opts: {
  outcome: PromoPipelineOutcome;
  sources?: Sources['sources'];
  promotions?: Map<string, Promotion>;
}) {
  let captured: Captured | undefined;
  const result = await runAgent2({
    provider: { name: 'stub', async extractJson() { throw new Error('唔應該叫到'); } },
    githubToken: 'fake',
    now: NOW,
    cards: [card],
    promotions: opts.promotions ?? new Map(),
    sourcesFile: { note: '', sources: opts.sources ?? [source()] },
    runPipelineFn: (async () => opts.outcome) as never,
    openPRFn: async (params) => {
      captured = params as never;
      return { number: 7, url: 'https://github.com/zavemate/zavemate/pull/7', branchName: params.branchName };
    },
  });
  return { result, captured };
}

const extractedOutcome = (promos: ExtractedPromotion[]): PromoPipelineOutcome => ({
  kind: 'extracted',
  contentHash: 'a'.repeat(64),
  result: { promotions: promos },
  usage: [{ tokensIn: 10, tokensOut: 5, costUsd: 0.002, model: 'stub' }],
});

describe('全新優惠', () => {
  it('開 PR，branch agent2/{YYYY-MM-DD}，寫入 promotion 檔', async () => {
    const { result, captured } = await run({ outcome: extractedOutcome([extracted()]) });
    expect(result.added).toBe(1);
    expect(captured!.branchName).toBe('agent2/2026-08-27');
    expect(captured!.files.some((f) => f.path === 'data/promotions/hsbc_red_2026q3_summer_dining.json')).toBe(true);
  });

  it('第三方來源 → 個優惠 confidence 係 crowdsourced', async () => {
    const { captured } = await run({ outcome: extractedOutcome([extracted()]) });
    const file = captured!.files.find((f) => f.path.includes('summer_dining'))!;
    expect(JSON.parse(file.content).provenance.confidence).toBe('crowdsourced');
  });

  it('sources.json 一齊更新（content_hash 寫返入去）', async () => {
    const { captured } = await run({ outcome: extractedOutcome([extracted()]) });
    const file = captured!.files.find((f) => f.path === 'data/sources.json')!;
    expect(JSON.parse(file.content).sources[0].content_hash).toBe('a'.repeat(64));
  });
});

describe('每個跑過嘅 source 都要有一行', () => {
  it('抽取成功但搵到 0 個優惠 → 都要出 note', async () => {
    // 第一次真跑撞到：兩個 source 都成功抽取、都叫咗 LLM、都搵到 0 個優惠，
    // 然後 PR body 一個字都冇提過佢哋。「查過冇嘢」同「冇查過」唔可以分唔出。
    const { captured } = await run({ outcome: extractedOutcome([]) });
    expect(captured!.body).toContain('hkcashrebate');
    expect(captured!.body).toContain('冇搵到限時優惠');
  });

  it('有優惠被過濾走 → note 講埋抽到幾多、寫入幾多', async () => {
    const { captured } = await run({
      outcome: extractedOutcome([extracted(), extracted({ slug: 'x', looks_like_base_terms: true })]),
    });
    expect(captured!.body).toContain('抽到 2 個優惠，寫入 1 個');
  });
});

describe('提議官方來源（crowdsourced → official 升級路徑）', () => {
  it('第三方文章 link 住官方頁 → 加入 sources.json 並且喺 PR body 講明', async () => {
    // 冇呢條 link，第三方發現嘅優惠會永遠停喺 crowdsourced——「快」嘅價值
    // 攞到，「準」嘅價值攞唔到。
    const { result, captured } = await run({
      outcome: extractedOutcome([extracted({ official_source_url: 'https://www.hsbc.com.hk/promo-tnc.pdf' })]),
    });
    expect(result.proposedSources).toBe(1);

    const sources = JSON.parse(captured!.files.find((f) => f.path === 'data/sources.json')!.content).sources;
    const added = sources.find((s: { url: string }) => s.url === 'https://www.hsbc.com.hk/promo-tnc.pdf');
    expect(added.source_type).toBe('official');
    expect(added.render_mode).toBe('pdf'); // .pdf 結尾自動判
    expect(captured!.body).toContain('提議新增官方來源');
  });

  it('官方來源本身唔會再提議官方來源（淨係第三方先會）', async () => {
    const { result } = await run({
      outcome: extractedOutcome([extracted({ official_source_url: 'https://www.hsbc.com.hk/x.pdf' })]),
      sources: [source({ source_type: 'official' })],
    });
    expect(result.proposedSources).toBe(0);
  });

  it('已經喺 sources.json 入面嘅 URL 唔會重複提議', async () => {
    const known = 'https://www.hsbc.com.hk/known.pdf';
    const { result } = await run({
      outcome: extractedOutcome([extracted({ official_source_url: known })]),
      sources: [source(), source({ source_id: 'known', url: known, source_type: 'official', active: false })],
    });
    expect(result.proposedSources).toBe(0);
  });
});

describe('label', () => {
  it('有提議官方來源 → 標 needs-review（人要決定收唔收）', async () => {
    const { captured } = await run({
      outcome: extractedOutcome([extracted({ official_source_url: 'https://www.hsbc.com.hk/x.pdf' })]),
    });
    expect(captured!.labels).toContain('needs-review');
  });

  it('連續 3 次 fetch 失敗 → broken-source', async () => {
    const { result, captured } = await run({
      outcome: { kind: 'extraction_too_thin', reason: '抽唔到文字' },
      sources: [source({ check_fail_count: 2 })],
    });
    expect(result.brokenSources).toEqual(['https://hkcashrebate.com/']);
    expect(captured!.labels).toContain('broken-source');
  });
});

describe('hash 短路', () => {
  it('內容冇變 → 唔會有任何 promotion 改動', async () => {
    const { result } = await run({ outcome: { kind: 'unchanged', contentHash: 'x' } });
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });
});

describe('過期清理', () => {
  it('過咗緩衝期 → active: false，而且個檔會出現喺 PR', async () => {
    const stale = {
      promotion_id: 'hsbc_red_2026q1_old',
      card_id: 'hsbc_red',
      end_date: '2026-01-31',
      active: true,
    } as Promotion;
    const { result, captured } = await run({
      outcome: { kind: 'unchanged', contentHash: 'x' },
      promotions: new Map([[stale.promotion_id, stale]]),
    });
    expect(result.expired).toBe(1);
    const file = captured!.files.find((f) => f.path.includes('hsbc_red_2026q1_old'))!;
    expect(JSON.parse(file.content).active).toBe(false);
  });
});
