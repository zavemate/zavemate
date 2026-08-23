/**
 * BUILD_SPEC §6.1 步驟 1：`fetch(url, render_mode)`。
 *
 * 三種 render_mode：
 * - html：直接攞返 HTTP response body
 * - pdf：下載完用 pdf-parse 抽文字（條款細則通常喺呢度）
 * - js：用 Cloudflare Browser Rendering API 攞已經行完 JS 嘅 HTML（SPA 頁面
 *   淨係 fetch HTML 嗰陣通常得個空殼）。要 CLOUDFLARE_API_TOKEN /
 *   CLOUDFLARE_ACCOUNT_ID，冇提供就 throw FetchError，唔會靜靜噉當攞到。
 *
 * §6.2「讀唔到」處理：非 2xx / timeout / network error 一律 throw FetchError，
 * 唔會改任何數值——call 嗰邊（agent orchestration，未寫）負責 catch 咗之後
 * check_fail_count += 1、更新 last_checked_at，唔降 confidence。
 */
export type RenderMode = 'html' | 'js' | 'pdf';

export interface FetchResult {
  content: string;
  status: number;
  fetchedAt: string; // ISO datetime
}

export interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** js render_mode 用。冇提供就讀環境變數 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。 */
  cloudflare?: CloudflareCredentials;
}

export class FetchError extends Error {
  readonly url: string;

  constructor(message: string, url: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
    this.url = url;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function withTimeout<T>(
  url: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new FetchError(
      isAbort ? `fetch 超時（${timeoutMs}ms）` : `fetch 失敗：${(error as Error).message}`,
      url,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string, timeoutMs: number): Promise<FetchResult> {
  return withTimeout(url, timeoutMs, async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}`, url);
    }
    return { content: await response.text(), status: response.status, fetchedAt: new Date().toISOString() };
  });
}

async function fetchPdf(url: string, timeoutMs: number): Promise<FetchResult> {
  return withTimeout(url, timeoutMs, async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}`, url);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { content: result.text, status: response.status, fetchedAt: new Date().toISOString() };
    } finally {
      await parser.destroy();
    }
  });
}

function resolveCloudflareCredentials(provided?: CloudflareCredentials): CloudflareCredentials | null {
  const apiToken = provided?.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  const accountId = provided?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) return null;
  return { apiToken, accountId };
}

interface BrowserRenderingResponse {
  success: boolean;
  result?: string;
  errors?: Array<{ message: string }>;
}

async function fetchJs(url: string, timeoutMs: number, provided?: CloudflareCredentials): Promise<FetchResult> {
  const credentials = resolveCloudflareCredentials(provided);
  if (credentials === null) {
    throw new FetchError(
      'render_mode "js" 需要 Cloudflare Browser Rendering API 憑證（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID），未設定',
      url,
    );
  }

  return withTimeout(url, timeoutMs, async (signal) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/browser-rendering/content`,
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      },
    );
    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}`, url);
    }

    const data = (await response.json()) as BrowserRenderingResponse;
    if (!data.success || data.result === undefined) {
      const message = data.errors?.map((e) => e.message).join('; ') ?? '未知錯誤';
      throw new FetchError(`Cloudflare Browser Rendering API 回傳失敗：${message}`, url);
    }

    return { content: data.result, status: response.status, fetchedAt: new Date().toISOString() };
  });
}

export async function fetchSource(
  url: string,
  renderMode: RenderMode,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (renderMode) {
    case 'html':
      return fetchHtml(url, timeoutMs);
    case 'pdf':
      return fetchPdf(url, timeoutMs);
    case 'js':
      return fetchJs(url, timeoutMs, options.cloudflare);
  }
}

export interface SourceValidators {
  /** HTTP Last-Modified，原樣保留（RFC 1123）。冇就 null。 */
  lastModified: string | null;
  /** HTTP ETag。渣打 (av.sc.com) 有，HSBC 冇。 */
  etag: string | null;
  contentLength: number | null;
  status: number;
}

/**
 * 淨係攞 header，唔落載成份文件。
 *
 * 用途：一份條款 PDF 動輒 200KB–1.1MB，而每星期真正要問嘅問題係「份文件變咗未」。
 * Last-Modified / ETag 係伺服器權威噉答呢條問題，成本近乎零。
 *
 * 但佢唔可以取代 content_hash：CMS 重新發佈、CDN 重新上傳，日期會跳但 bytes
 * 一模一樣。所以分工係——validator 答「使唔使落載」，hash 答「使唔使餵 LLM」。
 */
export async function headSource(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SourceValidators> {
  return withTimeout(url, timeoutMs, async (signal) => {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal });
    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}`, url);
    }
    const length = response.headers.get('content-length');
    return {
      lastModified: response.headers.get('last-modified'),
      etag: response.headers.get('etag'),
      contentLength: length === null ? null : Number(length),
      status: response.status,
    };
  });
}
