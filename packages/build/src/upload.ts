import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * §7.4 快取語義——呢個係整套嘢嘅核心。
 *
 * 我哋要令「攞最新」比「用舊嘅」平：
 * - /v/{sha}/* 永遠唔會變（新資料 = 新 commit = 新路徑），所以可以擺足一年
 *   immutable。agent 攞過一次就唔使再問。
 * - changes/{year}.jsonl 會 append，唔可以 immutable。短 TTL + SWR：
 *   agent 頻密 poll 都唔會打到 origin，但又唔會攞住過時 stream 好耐。
 */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const MUTABLE_CACHE = 'public, max-age=60, stale-while-revalidate=300';

export function cacheControlFor(key: string): string {
  return key.startsWith('v/') ? IMMUTABLE_CACHE : MUTABLE_CACHE;
}

export type CommandRunner = (command: string, args: string[]) => void;

const runWrangler: CommandRunner = (command, args) => {
  execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
};

export interface UploadOptions {
  bucket: string;
  distDir: string;
  /** 要上傳嘅 key（相對 distDir，同時就係 R2 上面嘅 object key）。 */
  keys: string[];
  /** 淨係測試用；唔提供就真係行 wrangler。 */
  run?: CommandRunner;
}

export interface UploadedObject {
  key: string;
  cacheControl: string;
}

/**
 * 用 wrangler 逐個 object 上傳。
 *
 * 揀 wrangler 而唔係自己打 R2 API：R2 走 S3 SigV4 簽名，自己寫要成 60 行
 * crypto code；而 Worker 部署本身就冇得唔用 wrangler。為咗慳一個 devDependency
 * 而手寫簽名係錯嘅取捨。（CLAUDE.md 禁嘅係重型 framework，唔係平台官方 CLI。）
 */
export function uploadSnapshot(options: UploadOptions): UploadedObject[] {
  const run = options.run ?? runWrangler;
  const uploaded: UploadedObject[] = [];
  for (const key of options.keys) {
    const cacheControl = cacheControlFor(key);
    run('npx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${options.bucket}/${key}`,
      '--file',
      join(options.distDir, key),
      '--content-type',
      key.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json',
      '--cache-control',
      cacheControl,
      '--remote',
    ]);
    uploaded.push({ key, cacheControl });
  }
  return uploaded;
}
