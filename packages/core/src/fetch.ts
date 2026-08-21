/**
 * BUILD_SPEC §6.1 步驟 1：`fetch(url, render_mode)`。
 *
 * 三種 render_mode：
 * - html：直接攞返 HTTP response body
 * - pdf：下載完用 pdf-parse 抽文字（條款細則通常喺呢度）
 * - js：要用 Cloudflare Browser Rendering API 攞已經行完 JS 嘅 HTML —— 呢個環境
 *   未設定 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，做唔到，call 咗會 throw
 *   FetchError，等 Cloudflare 資源就位先實作。
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

export interface FetchOptions {
  timeoutMs?: number;
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

// 未實作，但保持同其他 render_mode 一致嘅 async 簽名。
async function fetchJs(url: string): Promise<FetchResult> {
  throw new FetchError(
    'render_mode "js" 需要 Cloudflare Browser Rendering API（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID），呢個環境未設定，未實作',
    url,
  );
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
      return fetchJs(url);
  }
}
