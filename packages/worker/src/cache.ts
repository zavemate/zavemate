/**
 * §7.4 快取語義。
 *
 * 同 packages/build/src/upload.ts 嗰組值一致——R2 object 本身帶住 header 俾
 * data.zavemate.com 直出，Worker 呢邊自己砌嘅 response 都要一樣，唔可以兩邊
 * 講唔同嘢。
 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT_LIVED = 'public, max-age=60, stale-while-revalidate=300';

export function jsonResponse(body: unknown, init: { status?: number; cacheControl: string; etag?: string }): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': init.cacheControl,
  };
  if (init.etag) headers.etag = init.etag;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * If-None-Match 命中就回 304。
 *
 * §7.4：304 唔計 quota、唔收費。理由係如果 poll 都要俾錢，agent 就會用長 TTL
 * 快取，變相攞緊過時資料，反而傷我哋嘅產品質素——要令「攞最新」比「用舊嘅」平。
 */
export function notModified(request: Request, etag: string): Response | null {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch === null) return null;
  // 客戶端可能傳 W/"x" 或者多個值，逐個 trim 完比較。
  const candidates = ifNoneMatch.split(',').map((value) => value.trim().replace(/^W\//, ''));
  if (!candidates.includes(etag)) return null;
  return new Response(null, { status: 304, headers: { etag, 'cache-control': SHORT_LIVED } });
}

export function quoteEtag(version: string): string {
  return `"${version}"`;
}
