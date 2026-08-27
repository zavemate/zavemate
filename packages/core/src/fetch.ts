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
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

/**
 * Node 嘅 Happy Eyeballs 每個 address 只俾 250ms 就放棄，對銀行站嚟講太急。
 *
 * `fetch()` 底層行 `autoSelectFamily`：逐個 DNS address 試連，每個俾
 * `autoSelectFamilyAttemptTimeout`（Node default 250ms）。時間到就 abort 咗
 * 嗰個 address 轉下一個；**冇下一個就直接 ETIMEDOUT**。
 *
 * 而 `av.sc.com`（Imperva）由香港連過去 TCP handshake 量到 217ms——就喺
 * 250ms 隔籬。實測同一份 PDF 連拉 6 次：default 之下 3 次 `ETIMEDOUT`，
 * 而且每次都係 258ms 死（唔係 20 秒，即係唔關 `DEFAULT_TIMEOUT_MS` 事）；
 * 校到 2 秒之後 6 次全過。curl 打同一條 URL 一路都係 200。
 *
 * 點解一定要修：一個完全健康嘅 source 會扮 `fetch_failed`，於是
 * `check_fail_count` 累加、夠三次標 `broken-source`，同時 `last_verified_at`
 * 靜靜哋唔郁。呢個正正係「唔好靜靜錯」嗰種 failure mode——對外 provenance
 * 話核實唔到，實情係我哋自己個 client 早咗 20 秒放棄。
 *
 * 2 秒 = 217ms 基線 × 大量餘裕，仍然遠細過 `DEFAULT_TIMEOUT_MS` 嘅 20 秒，
 * 所以真係死咗嘅 address 一樣 fallback 得切。
 *
 * ⚠️ 呢個係 process-wide 設定。擺喺 fetch.ts 係因為佢係全個系統唯一
 * 出網嘅位，import 佢嘅人一律想要呢個行為。
 */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);

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

/**
 * 同一個 host 之間至少隔幾耐先打下一次。
 *
 * 銀行啲站有限流：連續／並行打 av.sc.com 會隨機回 connection timeout。之前
 * 靠重試頂，但重試係即刻連發，撞返同一個限流窗口，等於雪上加霜——而且真正
 * 嘅問題係我哋打得太密，唔係打得唔夠多次。
 *
 * 呢個 throttle 擺喺 fetch 呢一層，所以 integration test、discover 工具、
 * 同埋 Agent 1 真跑全部一齊受惠，唔使逐個 call site 記得加。
 */
const HOST_MIN_INTERVAL_MS = 1_200;
const hostQueue = new Map<string, Promise<void>>();

function throttle(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return Promise.resolve();
  }
  const previous = hostQueue.get(host) ?? Promise.resolve();
  hostQueue.set(
    host,
    previous.then(() => new Promise<void>((resolve) => setTimeout(resolve, HOST_MIN_INTERVAL_MS))),
  );
  return previous;
}

async function withTimeout<T>(
  url: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  await throttle(url);
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
