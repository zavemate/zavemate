import type { Env } from '../env.ts';

/** 用一個 Map 扮 R2 + KV，唔使 miniflare 都測到 handler 嘅全部行為。 */
export function fakeEnv(objects: Record<string, unknown>, latestVersion: string | null): Env {
  const store = new Map(Object.entries(objects).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    SNAPSHOTS: {
      get: async (key: string) => {
        const body = store.get(key);
        if (body === undefined) return null;
        return { text: async () => body, body: new Response(body).body };
      },
    },
    STATE: {
      get: async () => latestVersion,
    },
  } as unknown as Env;
}

export function snapshotFixture(version: string, lastVerifiedAt: string | null = '2026-08-24T00:00:00.000Z') {
  return {
    schema_version: '1.0.0',
    snapshot_version: version,
    generated_at: '2026-08-24T00:00:00.000Z',
    coverage: { cards: 1, rules: 1, promotions: 0, unconfirmed_rules: 0, undetermined_rules: 0 },
    cards: [
      {
        card_id: 'demo_card',
        rewards: [{ rule_id: 'demo_rule', provenance: { last_verified_at: lastVerifiedAt, confidence: 'official' } }],
      },
    ],
  };
}
