import { describe, expect, it } from 'vitest';
import { Card, Question } from '@zavemate/schema';
import type { LLMProvider } from '../llm.ts';
import { runAgent1 } from '../run.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

/**
 * 出關驗證：Agent 1 寫落 PR 嘅每一個檔，都要過返自己個 schema。
 *
 * 點解要專門有呢個 test：Agent 2 由頭到尾未產出過一條合格 schema 嘅
 * promotion，而冇人發現——因為冇任何 test 將 apply 嘅輸出餵返入
 * `Promotion.parse()`。要等到真跑產出咗資料、push 上 CI，`validate:data`
 * 先叫。三個唔同違規一次過爆晒出嚟。
 *
 * Agent 1 而家未中招，係因為佢 `structuredClone` 一張本身已經合格嘅卡再改
 * 欄位，大部分非法狀態去唔到。但唔係密實：修復 pass 會**憑空寫**一段新
 * `evidence_excerpt`，同埋將 `confidence` 揼返 `official`（run.ts）。嗰兩個
 * 唔係抄舊值，係生成出嚟嘅。
 *
 * 所以呢度唔係測某一個 bug，係守住個接縫本身：**唔理將來加咩邏輯，出到
 * PR 嘅嘢一定係合格資料。**
 */

const NOW = new Date('2026-08-22T00:00:00.000Z');

/** 假原文。修復 pass 要喺呢度逐字搵到佢提出嘅引文先算數。 */
const SOURCE_TEXT =
  '本卡網上簽賬回贈 4%。指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）。所有合資格簽賬享 20% 現金回贈。';

interface CapturedFile {
  path: string;
  content: string;
}

/** 攞返 runAgent1 真正寫落 PR 嗰批檔。 */
async function filesFrom(options: {
  cards: Parameters<typeof runAgent1>[0]['cards'];
  provider: LLMProvider;
  /**
   * `unchanged` = hash 命中。修復 pass 真正嘅觸發情境就係呢個：頁面冇郁，
   * 但舊 evidence 撐唔住個數值（2026-08-27 真跑捉到嗰六條就係噉）。
   */
  outcome?: 'extracted' | 'unchanged';
  /** 卡頁 HTML——俾來源漂移檢查用。唔提供就當讀唔到（跳過檢查）。 */
  pageHtml?: string;
}): Promise<CapturedFile[]> {
  let captured: CapturedFile[] = [];
  await runAgent1({
    provider: options.provider,
    githubToken: 'fake',
    now: NOW,
    cards: options.cards,
    fetchFn: async (url: string) => {
      if (options.pageHtml === undefined) throw new Error('冇卡頁');
      return { content: options.pageHtml, status: 200, fetchedAt: NOW.toISOString() };
    },
    runPipelineFn: async (input) => {
      if (options.outcome === 'unchanged') {
        return {
          kind: 'unchanged',
          contentHash: 'stub-hash',
          fetchedAt: NOW.toISOString(),
          mainContent: SOURCE_TEXT,
        };
      }
      const llm = await input.provider.extractJson({
        systemPrompt: JSON.stringify(input.knownRules),
        userContent: '',
      });
      return {
        kind: 'extracted',
        contentHash: 'stub-hash',
        fetchedAt: NOW.toISOString(),
        result: llm.data as never,
        usage: [llm.usage],
        mainContent: SOURCE_TEXT,
      };
    },
    openPRFn: async (params) => {
      captured = params.files;
      return { url: 'https://example.test/pr/1', number: 1, branchName: params.branchName };
    },
  });
  return captured;
}

/** 每個檔跟住自己個路徑揀 schema 驗——驗錯 schema 就等於冇驗。 */
function expectEveryFileValid(files: CapturedFile[]): void {
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const parsed: unknown = JSON.parse(file.content);
    if (file.path.startsWith('data/cards/')) {
      expect(() => Card.parse(parsed), `${file.path} 過唔到 Card schema`).not.toThrow();
    } else if (file.path.startsWith('data/questions/')) {
      expect(() => Question.parse(parsed), `${file.path} 過唔到 Question schema`).not.toThrow();
    } else {
      throw new Error(`未知路徑 ${file.path}——加咗新一種輸出就要喺呢度加返驗證`);
    }
  }
}

/** 抽取 provider：交一個數值改動。 */
function extractionProvider(rate: number): LLMProvider {
  return {
    name: 'extract',
    async extractJson() {
      return {
        data: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '網上簽賬回贈 4%',
            },
          ],
        },
        usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'fake' },
      };
    },
  };
}

/**
 * 抽取 + 修復兩用嘅 provider。
 *
 * 兩個角色共用同一個 `options.provider`，靠 prompt 內容分——修復 prompt 開頭
 * 就係「你係一個信用卡條款核實員」。
 */
function repairProvider(excerpt: string | null): LLMProvider {
  return {
    name: 'repair',
    async extractJson({ systemPrompt }) {
      const usage = { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'fake' };
      if (systemPrompt.includes('信用卡條款核實員')) {
        return {
          data:
            excerpt === null
              ? { verdict: 'absent', excerpt: null, contradicting_excerpt: null, reasoning: '文件冇提過' }
              : { verdict: 'supported', excerpt, contradicting_excerpt: null, reasoning: '搵到' },
          usage,
        };
      }
      // 抽取：數值同 fixture 一樣，噉先會行 evidence 核實而唔係「數值變咗」。
      return {
        data: {
          rules: [
            {
              rule_id: 'demo_card_online',
              found: true,
              reward: { type: 'cash_rebate', rate: 0.04, points_per_hkd: null, hkd_per_mile: null },
              cap_value: null,
              cap_unit: null,
              effective_from: null,
              confidence: 'official',
              evidence_excerpt: '網上簽賬回贈 4%',
            },
          ],
        },
        usage,
      };
    },
  };
}

/** 一張 evidence 對唔上原文嘅卡——噉先會行到修復 pass。 */
function cardWithBrokenEvidence() {
  return card({
    rewards: [rewardRule({ provenance: provenance({ evidence_excerpt: '呢句唔喺原文入面出現過' }) })],
  });
}

describe('出關驗證：寫落 PR 嘅嘢一定要過 schema', () => {
  it('數值有改動', async () => {
    const files = await filesFrom({ cards: [card()], provider: extractionProvider(0.038) });
    expectEveryFileValid(files);
  });

  it('修復成功——新 evidence 同 confidence 都係憑空寫出嚟，最易寫出非法值', async () => {
    const files = await filesFrom({
      cards: [cardWithBrokenEvidence()],
      provider: repairProvider('指定商戶簽賬回贈 3.8%（只計算單一簽賬滿 $500 之交易）'),
      outcome: 'unchanged',
    });
    expectEveryFileValid(files);
    expect(files.some((f) => f.path === 'data/cards/demo_card.json')).toBe(true);
  });

  it('修唔掂——會開 question 檔，同時將條 rule 降做 unconfirmed', async () => {
    const files = await filesFrom({
      cards: [cardWithBrokenEvidence()],
      provider: repairProvider(null),
      outcome: 'unchanged',
    });
    expectEveryFileValid(files);

    const question = files.find((f) => f.path.startsWith('data/questions/'));
    expect(question, '修唔掂就應該開 question').toBeDefined();

    const parsed = Question.parse(JSON.parse(question!.content));
    expect(parsed.status).toBe('open');
    expect(parsed.rule_id).toBe('demo_card_online');
  });

  it('修復 agent 作嘢（提出嘅引文喺原文搵唔到）——當佢冇講過，一樣要合格', async () => {
    const files = await filesFrom({
      cards: [cardWithBrokenEvidence()],
      provider: repairProvider('呢句都係作出嚟嘅，原文冇'),
      outcome: 'unchanged',
    });
    expectEveryFileValid(files);
    expect(files.some((f) => f.path.startsWith('data/questions/')), '驗唔到就應該問人').toBe(true);
  });
});

describe('來源漂移 → question', () => {
  const PAGE = 'https://www.example-bank.com.hk/cards/demo-page';
  const CITED = 'https://av.example-bank.com.hk/docs/demo-2020.pdf';
  const LINKED = 'https://av.example-bank.com.hk/docs/demo-2026.pdf';

  function cardWithProductPage() {
    const base = card();
    return {
      ...base,
      sources: [
        { url: CITED, purpose: 'scheme', note: null, last_modified: null, etag: null, language: null, is_authoritative: true },
        { url: PAGE, purpose: 'product_page', note: null, last_modified: null, etag: null, language: null, is_authoritative: true },
      ],
      provenance: { ...base.provenance, source_url: CITED },
      rewards: [rewardRule({ provenance: provenance({ source_url: CITED }) })],
    } as ReturnType<typeof card>;
  }

  it('卡頁唔再 link 我哋引用嗰份 → 開 source_superseded question', async () => {
    // 真實個案：sc_simply_cash_visa 引用緊 06/2020，官方 link 緊 04/2026。
    // 所有其他檢查都綠燈——舊文件真係有嗰句，而且真係冇改過。
    const files = await filesFrom({
      cards: [cardWithProductPage()],
      provider: extractionProvider(0.04),
      pageHtml: '<a href="' + LINKED + '">最新條款</a>',
    });
    expectEveryFileValid(files);

    const q = files.find((f) => f.path.startsWith('data/questions/'));
    expect(q, '應該開 question').toBeDefined();

    const parsed = Question.parse(JSON.parse(q!.content));
    expect(parsed.kind).toBe('source_superseded');
    expect(parsed.rule_id).toBeNull();
    expect(parsed.evidence).toContain(LINKED);
  });

  it('卡頁 link 住十幾份文件 → question 一樣要過到 schema', async () => {
    // 我原本個 fixture 只有 1 份 linked doc，所以 evidence 永遠好短，
    // 掂唔到 Question.evidence 個 max(500)。真跑撞到 EveryMile 卡頁有 13 份
    // 滙豐 PDF（每條 URL ~100 字），成個 agent run 嘅 validate 紅晒。
    //
    // 出關驗證要用真實體積嘅資料先守得住——shape 啱唔代表 size 啱。
    const many = Array.from(
      { length: 13 },
      (_, i) => `https://www.hsbc.com.hk/content/dam/hsbc/hk/tc/docs/credit-cards/everymile/everymile-doc-${i}.pdf`,
    );
    const files = await filesFrom({
      cards: [cardWithProductPage()],
      provider: extractionProvider(0.04),
      pageHtml: many.map((u) => `<a href="${u}">x</a>`).join(''),
    });

    expectEveryFileValid(files);
    const q = files.find((f) => f.path.startsWith('data/questions/'));
    expect(Question.parse(JSON.parse(q!.content)).evidence!.length).toBeLessThanOrEqual(500);
  });

  it('卡頁仲 link 緊我哋引用嗰份 → 唔開 question', async () => {
    const files = await filesFrom({
      cards: [cardWithProductPage()],
      provider: extractionProvider(0.04),
      pageHtml: '<a href="' + CITED + '?intcid=tracking">條款</a>',
    });
    expect(files.some((f) => f.path.startsWith('data/questions/'))).toBe(false);
  });

  it('讀唔到卡頁 → 靜靜跳過，唔好因為佢而搞衰成個 run', async () => {
    const files = await filesFrom({ cards: [cardWithProductPage()], provider: extractionProvider(0.04) });
    expect(files.some((f) => f.path.startsWith('data/questions/'))).toBe(false);
    expect(files.some((f) => f.path === 'data/cards/demo_card.json')).toBe(true);
  });
});
