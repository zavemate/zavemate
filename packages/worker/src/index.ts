/// <reference types="@cloudflare/workers-types" />
import { IMMUTABLE, jsonResponse, notModified, quoteEtag, SHORT_LIVED } from './cache.ts';
import { type Env, LATEST_VERSION_KEY } from './env.ts';
import { buildStatus, type RuleFreshness } from './status.ts';

interface SnapshotShape {
  schema_version: string;
  snapshot_version: string;
  generated_at: string;
  coverage: Record<string, number>;
  cards: Array<{
    card_id: string;
    rewards: Array<{ rule_id: string; provenance: { last_verified_at: string | null; confidence: string } }>;
  }>;
}

const notFound = (what: string) => jsonResponse({ error: 'not_found', detail: what }, { status: 404, cacheControl: 'no-store' });

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.SNAPSHOTS.get(key);
  if (object === null) return null;
  return JSON.parse(await object.text()) as T;
}

async function latestVersion(env: Env): Promise<string | null> {
  return env.STATE.get(LATEST_VERSION_KEY);
}

export async function handle(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405, cacheControl: 'no-store' });
  }

  // GET /v1/latest —— agent 每次開工第一個打嘅嘢。ETag = 版本號本身。
  if (path === '/v1/latest') {
    const version = await latestVersion(env);
    if (version === null) return notFound('未有任何 snapshot');

    const etag = quoteEtag(version);
    const cached = notModified(request, etag);
    if (cached) return cached;

    const index = await readJson<{ coverage: Record<string, number>; generated_at: string }>(
      env,
      `v/${version}/index.json`,
    );
    if (index === null) return notFound(`v/${version}/index.json`);

    return jsonResponse(
      {
        version,
        generated_at: index.generated_at,
        coverage: index.coverage,
        urls: {
          // 大檔優先行 R2 public bucket；冇設就 fallback 經 Worker。
          full: env.DATA_ORIGIN ? `${env.DATA_ORIGIN}/v/${version}/full.json` : `${url.origin}/v1/snapshot/${version}/full.json`,
          index: env.DATA_ORIGIN ? `${env.DATA_ORIGIN}/v/${version}/index.json` : `${url.origin}/v1/snapshot/${version}/index.json`,
          // 單卡同 status 留返喺 Worker：card 要跟最新版本，唔係固定路徑。
          card: `${url.origin}/v1/card/{card_id}`,
          changes: env.DATA_ORIGIN ? `${env.DATA_ORIGIN}/changes/{year}.jsonl` : null,
        },
      },
      { cacheControl: SHORT_LIVED, etag },
    );
  }

  // GET /v1/snapshot/{version}/{file} —— 版本化路徑，內容永遠唔會變。
  const snapshotMatch = path.match(/^\/v1\/snapshot\/([^/]+)\/(full|index)\.json$/);
  if (snapshotMatch) {
    const [, version, file] = snapshotMatch;
    const object = await env.SNAPSHOTS.get(`v/${version}/${file}.json`);
    if (object === null) return notFound(`v/${version}/${file}.json`);

    const etag = quoteEtag(`${version}:${file}`);
    const cached = notModified(request, etag);
    if (cached) return cached;

    return new Response(object.body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': IMMUTABLE, etag },
    });
  }

  // GET /v1/card/{card_id} —— 永遠回最新版本嗰張卡。
  const cardMatch = path.match(/^\/v1\/card\/([a-z0-9_]+)$/);
  if (cardMatch) {
    const version = await latestVersion(env);
    if (version === null) return notFound('未有任何 snapshot');

    const etag = quoteEtag(`${version}:${cardMatch[1]}`);
    const cached = notModified(request, etag);
    if (cached) return cached;

    const object = await env.SNAPSHOTS.get(`v/${version}/cards/${cardMatch[1]}.json`);
    if (object === null) return notFound(`card ${cardMatch[1]}`);
    return new Response(object.body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': SHORT_LIVED, etag },
    });
  }

  // GET /v1/status —— 唔係報「服務有冇 up」，係報「啲數字仲信唔信得過」。
  if (path === '/v1/status') {
    const version = await latestVersion(env);
    const snapshot = version === null ? null : await readJson<SnapshotShape>(env, `v/${version}/full.json`);
    const rules: RuleFreshness[] =
      snapshot?.cards.flatMap((card) =>
        card.rewards.map((rule) => ({
          card_id: card.card_id,
          rule_id: rule.rule_id,
          last_verified_at: rule.provenance.last_verified_at,
          confidence: rule.provenance.confidence,
        })),
      ) ?? [];

    return jsonResponse(buildStatus({ version, generated_at: snapshot?.generated_at ?? null, rules }, now), {
      cacheControl: SHORT_LIVED,
    });
  }

  return notFound(path);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;
