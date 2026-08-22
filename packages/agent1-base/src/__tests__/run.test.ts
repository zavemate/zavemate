import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '../llm.ts';
import { hongKongDate, runAgent1 } from '../run.ts';
import { card, provenance, rewardRule } from './fixtures.ts';

const NOW = new Date('2026-08-22T00:00:00.000Z');

const fakeProvider: LLMProvider = {
  name: 'fake',
  async extractJson() {
    return {
      data: {
        rules: [
          {
            rule_id: 'demo_card_online',
            found: true,
            reward: { type: 'cash_rebate', rate: 0.038, points_per_hkd: null, hkd_per_mile: null },
            cap_value: null,
            cap_unit: null,
            effective_from: null,
            confidence: 'official',
            evidence_excerpt: '網上簽賬回贈 3.8%',
          },
        ],
      },
      usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'fake' },
    };
  },
};

describe('hongKongDate', () => {
  it('cron 04:00 HKT（= 20:00 UTC 前一日）要俾到星期一嗰日，唔係前一日', () => {
    // 2026-08-24 係星期一。cron 喺 2026-08-23T20:00Z 跑。
    expect(hongKongDate(new Date('2026-08-23T20:00:00.000Z'))).toBe('2026-08-24');
  });

  it('UTC 日頭跑，HK 已經係同一日下晝', () => {
    expect(hongKongDate(new Date('2026-08-22T00:00:00.000Z'))).toBe('2026-08-22');
  });

  it('HK 半夜前一刻仍然算前一日', () => {
    // 2026-08-22T15:59:59Z = 2026-08-22 23:59:59 HKT
    expect(hongKongDate(new Date('2026-08-22T15:59:59.000Z'))).toBe('2026-08-22');
    // 再過一秒就跨日
    expect(hongKongDate(new Date('2026-08-22T16:00:00.000Z'))).toBe('2026-08-23');
  });
});

describe('runAgent1', () => {
  it('有改動 → 開 PR，帶正確 title/branch/labels/body', async () => {
    const cards = [
      card({
        card_id: 'demo_card',
        rewards: [rewardRule({ provenance: provenance({ source_url: 'https://example.com/' }) })],
      }),
    ];

    let capturedParams: unknown;
    const result = await runAgent1({
      provider: fakeProvider,
      githubToken: 'fake-token',
      cards,
      now: NOW,
      openPRFn: async (params) => {
        capturedParams = params;
        return { number: 42, url: 'https://github.com/zavemate/zavemate/pull/42', branchName: params.branchName };
      },
    });

    expect(result.prUrl).toBe('https://github.com/zavemate/zavemate/pull/42');
    expect(result.changed).toBe(1);
    expect(result.gatePassed).toBe(true); // 0.04→0.038 屬合理範圍，冇中任何 GateReason

    const params = capturedParams as { branchName: string; title: string; labels?: string[]; files: Array<{ path: string; content: string }> };
    expect(params.branchName).toBe('agent1/2026-08-22');
    expect(params.title).toContain('1 changed');
    expect(params.labels ?? []).not.toContain('needs-review'); // gate 過咗，唔應該標
    expect(params.files).toHaveLength(1);
    expect(params.files[0]?.path).toBe('data/cards/demo_card.json');
    expect(JSON.parse(params.files[0]!.content).rewards[0].reward.rate).toBe(0.038);
  });

  it('回贈率跳升超過 1.5 倍 → gate 冧咗，標 needs-review', async () => {
    const jumpProvider: LLMProvider = {
      name: 'jump',
      async extractJson() {
        return {
          data: {
            rules: [
              {
                rule_id: 'demo_card_online',
                found: true,
                reward: { type: 'cash_rebate', rate: 0.2, points_per_hkd: null, hkd_per_mile: null },
                cap_value: null,
                cap_unit: null,
                effective_from: null,
                confidence: 'official',
                evidence_excerpt: '回贈率 20%',
              },
            ],
          },
          usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'fake' },
        };
      },
    };

    let capturedLabels: string[] | undefined;
    const result = await runAgent1({
      provider: jumpProvider,
      githubToken: 'fake-token',
      cards: [
        card({
          rewards: [rewardRule({ provenance: provenance({ source_url: 'https://example.com/' }) })],
        }),
      ],
      now: NOW,
      openPRFn: async (params) => {
        capturedLabels = params.labels;
        return { number: 1, url: 'https://github.com/zavemate/zavemate/pull/1', branchName: params.branchName };
      },
    });

    expect(result.gatePassed).toBe(false);
    expect(capturedLabels).toContain('needs-review');
  });

  it('gate 全過但有 attentionNeeded → 一樣要標 needs-review', async () => {
    // found=false：數值根本冇郁，所以 gate 冇嘢可以冧，但正正最需要人手睇。
    const notFoundProvider: LLMProvider = {
      name: 'not-found',
      async extractJson() {
        return {
          data: {
            rules: [
              {
                rule_id: 'demo_card_online',
                found: false,
                reward: null,
                cap_value: null,
                cap_unit: null,
                effective_from: null,
                confidence: 'unconfirmed',
                evidence_excerpt: null,
              },
            ],
          },
          usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'fake' },
        };
      },
    };

    let capturedLabels: string[] | undefined;
    const result = await runAgent1({
      provider: notFoundProvider,
      githubToken: 'fake-token',
      cards: [
        card({
          rewards: [rewardRule({ provenance: provenance({ source_url: 'https://example.com/' }) })],
        }),
      ],
      now: NOW,
      openPRFn: async (params) => {
        capturedLabels = params.labels;
        return { number: 2, url: 'https://github.com/zavemate/zavemate/pull/2', branchName: params.branchName };
      },
    });

    expect(result.gatePassed).toBe(true);
    expect(result.changed).toBe(0);
    expect(capturedLabels).toContain('needs-review');
  });

  it('cron 時間（20:00 UTC 星期日）跑 → branch name 同 PR body 用香港嗰日（星期一）', async () => {
    let capturedParams: { branchName: string; body: string } | undefined;
    await runAgent1({
      provider: fakeProvider,
      githubToken: 'fake-token',
      cards: [
        card({
          rewards: [rewardRule({ provenance: provenance({ source_url: 'https://example.com/' }) })],
        }),
      ],
      now: new Date('2026-08-23T20:00:00.000Z'), // = 2026-08-24 04:00 HKT，星期一
      openPRFn: async (params) => {
        capturedParams = params;
        return { number: 3, url: 'https://github.com/zavemate/zavemate/pull/3', branchName: params.branchName };
      },
    });
    expect(capturedParams!.branchName).toBe('agent1/2026-08-24');
    expect(capturedParams!.body).toContain('2026-08-24');
  });

  it('一張卡嘅 rule 分散喺兩個 source_url → 兩個 source 嘅更新都要保住', async () => {
    // 迴歸測試：以前 applyWork 每次都由原始卡 clone，第二個 source 會覆蓋第一個
    // source 改過嘅嘢（真實個案：hsbc_everymile 兩條 rule 出自兩份 PDF，PR #27
    // 入面 hsbc_everymile_designated 明明「核實過」但一個欄位都冇更新）。
    //
    // 兩個 URL 都係一定 connection refused 嘅 localhost port：applyWork 走
    // fetch_failed 路徑一樣會 set last_checked_at，足夠驗到「兩個 source 嘅
    // 更新有冇都保住」，而且唔使掂外網（唔會拖慢、唔會 flaky）。
    const twoSourceCard = card({
      card_id: 'two_source_card',
      rewards: [
        rewardRule({ rule_id: 'rule_a', provenance: provenance({ source_url: 'http://127.0.0.1:9/a' }) }),
        rewardRule({ rule_id: 'rule_b', provenance: provenance({ source_url: 'http://127.0.0.1:9/b' }) }),
      ],
    });

    let captured: Array<{ path: string; content: string }> | undefined;
    await runAgent1({
      provider: fakeProvider, // 唔會用到，fetch 一定失敗
      githubToken: 'fake-token',
      cards: [twoSourceCard],
      now: NOW,
      openPRFn: async (params) => {
        captured = params.files;
        return { number: 4, url: 'https://github.com/zavemate/zavemate/pull/4', branchName: params.branchName };
      },
    });

    expect(captured).toHaveLength(1);
    const written = JSON.parse(captured![0]!.content);
    const byId = Object.fromEntries(written.rewards.map((r: { rule_id: string }) => [r.rule_id, r]));
    // 兩條都要更新過，唔可以淨係得第二個 source 嗰條。
    expect(byId.rule_a.provenance.last_checked_at).toBe(NOW.toISOString());
    expect(byId.rule_b.provenance.last_checked_at).toBe(NOW.toISOString());
    expect(byId.rule_a.provenance.check_fail_count).toBe(1);
    expect(byId.rule_b.provenance.check_fail_count).toBe(1);
  });

  it('冇任何 rule（新卡都冇）→ 唔開 PR', async () => {
    const result = await runAgent1({
      provider: fakeProvider,
      githubToken: 'fake-token',
      cards: [],
      now: NOW,
      openPRFn: async () => {
        throw new Error('唔應該叫到 openPR');
      },
    });
    expect(result.prUrl).toBeNull();
  });
});
