import { describe, expect, it } from 'vitest';
import { IMMUTABLE, SHORT_LIVED } from '../cache.ts';
import { handle } from '../index.ts';
import { fakeEnv, snapshotFixture } from './fakes.ts';

const NOW = new Date('2026-08-25T00:00:00.000Z');
const V = 'abc1234';

function env(lastVerifiedAt: string | null = '2026-08-24T00:00:00.000Z', version: string | null = V) {
  const snapshot = snapshotFixture(V, lastVerifiedAt);
  return fakeEnv(
    {
      [`v/${V}/full.json`]: snapshot,
      [`v/${V}/index.json`]: { coverage: snapshot.coverage, generated_at: snapshot.generated_at },
      [`v/${V}/cards/demo_card.json`]: { card: snapshot.cards[0] },
    },
    version,
  );
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://api.zavemate.com${path}`, { headers });

describe('GET /v1/latest', () => {
  it('設咗 DATA_ORIGIN → 大檔指去 R2 public bucket，唔經 Worker', async () => {
    // §7.1：我哋做嘅係 snapshot distribution，唔係 query serving。agent 拉
    // full.json（59 KB，immutable 一年）行 CDN 直出，egress 免費、唔食 Worker
    // request 額度。
    const res = await handle(get('/v1/latest'), { ...env(), DATA_ORIGIN: 'https://data.zavemate.com' }, NOW);
    const body = (await res.json()) as { urls: Record<string, string | null> };
    expect(body.urls.full).toBe(`https://data.zavemate.com/v/${V}/full.json`);
    expect(body.urls.changes).toBe('https://data.zavemate.com/changes/{year}.jsonl');
    // 單卡要跟最新版本，唔係固定路徑，所以留返喺 Worker。
    expect(body.urls.card).toContain('/v1/card/');
  });

  it('冇 DATA_ORIGIN → fallback 經 Worker，功能唔會壞', async () => {
    const res = await handle(get('/v1/latest'), env(), NOW);
    const body = (await res.json()) as { urls: Record<string, string | null> };
    expect(body.urls.full).toContain('/v1/snapshot/');
    expect(body.urls.changes).toBeNull();
  });

  it('回版本、coverage 同各條 URL', async () => {
    const res = await handle(get('/v1/latest'), env(), NOW);
    const body = (await res.json()) as { version: string; urls: Record<string, string>; coverage: Record<string, number> };
    expect(res.status).toBe(200);
    expect(body.version).toBe(V);
    expect(body.urls.full).toContain(`/v1/snapshot/${V}/full.json`);
    expect(body.coverage.cards).toBe(1);
  });

  it('ETag 就係版本號，cache 用短 TTL + SWR', async () => {
    const res = await handle(get('/v1/latest'), env(), NOW);
    expect(res.headers.get('etag')).toBe(`"${V}"`);
    expect(res.headers.get('cache-control')).toBe(SHORT_LIVED);
  });

  it('If-None-Match 命中 → 304，冇 body', async () => {
    // §7.4：304 唔計 quota、唔收費——要令「攞最新」比「用舊嘅」平。
    const res = await handle(get('/v1/latest', { 'if-none-match': `"${V}"` }), env(), NOW);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('W/ 前綴嘅弱 ETag 一樣認得', async () => {
    const res = await handle(get('/v1/latest', { 'if-none-match': `W/"${V}"` }), env(), NOW);
    expect(res.status).toBe(304);
  });

  it('If-None-Match 唔啱 → 照回 200', async () => {
    const res = await handle(get('/v1/latest', { 'if-none-match': '"old"' }), env(), NOW);
    expect(res.status).toBe(200);
  });

  it('未有任何 snapshot → 404，唔會扮有', async () => {
    const res = await handle(get('/v1/latest'), env(null, null), NOW);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/snapshot/{version}/*', () => {
  it('版本化路徑回 immutable —— 內容永遠唔會變', async () => {
    const res = await handle(get(`/v1/snapshot/${V}/full.json`), env(), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
  });

  it('未知版本 → 404', async () => {
    const res = await handle(get('/v1/snapshot/deadbee/full.json'), env(), NOW);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/card/{card_id}', () => {
  it('回最新版本嗰張卡', async () => {
    const res = await handle(get('/v1/card/demo_card'), env(), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SHORT_LIVED);
  });

  it('未知卡 → 404', async () => {
    expect((await handle(get('/v1/card/no_such_card'), env(), NOW)).status).toBe(404);
  });
});

describe('GET /v1/status', () => {
  it('啱啱核實過 → healthy，stale_ratio 0', async () => {
    const res = await handle(get('/v1/status'), env('2026-08-24T00:00:00.000Z'), NOW);
    const body = (await res.json()) as { healthy: boolean; stale_ratio: number; stale_after_days: number };
    expect(body.healthy).toBe(true);
    expect(body.stale_ratio).toBe(0);
    expect(body.stale_after_days).toBe(14);
  });

  it('過咗兩個週期未核實 → stale，唔 healthy', async () => {
    // Agent 1 逢星期一跑，兩個週期都未核實就係我哋讀唔到，唔係銀行冇改。
    const res = await handle(get('/v1/status'), env('2026-07-01T00:00:00.000Z'), NOW);
    const body = (await res.json()) as { healthy: boolean; stale_ratio: number };
    expect(body.stale_ratio).toBe(1);
    expect(body.healthy).toBe(false);
  });

  it('last_verified_at 係 null 一律當 stale（從來未核實過更差）', async () => {
    const res = await handle(get('/v1/status'), env(null), NOW);
    expect(((await res.json()) as { stale_ratio: number }).stale_ratio).toBe(1);
  });

  it('冇 snapshot → 唔 healthy，唔會靜靜哋報 200 OK', async () => {
    const res = await handle(get('/v1/status'), env(null, null), NOW);
    expect(((await res.json()) as { healthy: boolean }).healthy).toBe(false);
  });
});

describe('其他', () => {
  it('POST → 405', async () => {
    const res = await handle(new Request('https://api.zavemate.com/v1/latest', { method: 'POST' }), env(), NOW);
    expect(res.status).toBe(405);
  });

  it('未知路徑 → 404', async () => {
    expect((await handle(get('/v1/nope'), env(), NOW)).status).toBe(404);
  });

  it('結尾斜線唔影響 routing', async () => {
    expect((await handle(get('/v1/latest/'), env(), NOW)).status).toBe(200);
  });
});
