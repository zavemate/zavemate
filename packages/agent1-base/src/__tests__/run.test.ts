import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '../llm.ts';
import { runAgent1 } from '../run.ts';
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
