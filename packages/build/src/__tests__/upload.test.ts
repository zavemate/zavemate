import { describe, expect, it } from 'vitest';
import { cacheControlFor, IMMUTABLE_CACHE, MUTABLE_CACHE, uploadSnapshot } from '../upload.ts';

describe('cacheControlFor', () => {
  it('/v/{sha}/ 底下永遠唔會變 → 擺足一年 immutable', () => {
    // 新資料 = 新 commit = 新路徑，所以舊路徑永遠安全。agent 攞過一次就唔使再問。
    expect(cacheControlFor('v/abc1234/full.json')).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor('v/abc1234/cards/hsbc_red.json')).toBe(IMMUTABLE_CACHE);
  });

  it('changes/{year}.jsonl 會 append → 唔可以 immutable', () => {
    expect(cacheControlFor('changes/2026.jsonl')).toBe(MUTABLE_CACHE);
  });

  it('mutable 嗰啲要有 stale-while-revalidate（頻密 poll 唔應該打到 origin）', () => {
    expect(MUTABLE_CACHE).toContain('stale-while-revalidate');
  });
});

describe('uploadSnapshot', () => {
  it('逐個 object 帶住啱嘅 content-type 同 cache-control', () => {
    const calls: string[][] = [];
    const uploaded = uploadSnapshot({
      bucket: 'zavemate-snapshots',
      distDir: '/tmp/dist',
      keys: ['v/abc1234/full.json', 'changes/2026.jsonl'],
      run: (_cmd, args) => calls.push(args),
    });

    expect(uploaded).toEqual([
      { key: 'v/abc1234/full.json', cacheControl: IMMUTABLE_CACHE },
      { key: 'changes/2026.jsonl', cacheControl: MUTABLE_CACHE },
    ]);
    expect(calls[0]).toContain('zavemate-snapshots/v/abc1234/full.json');
    expect(calls[0]).toContain('application/json');
    expect(calls[0]).toContain(IMMUTABLE_CACHE);
    expect(calls[1]).toContain('application/x-ndjson'); // JSONL 唔係 application/json
    expect(calls[1]).toContain(MUTABLE_CACHE);
  });

  it('一律 --remote（唔好靜靜哋寫咗落本機 local storage）', () => {
    const calls: string[][] = [];
    uploadSnapshot({ bucket: 'b', distDir: '/tmp', keys: ['v/x/full.json'], run: (_c, a) => calls.push(a) });
    expect(calls[0]).toContain('--remote');
  });
});
