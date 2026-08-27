import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { describe, expect, it } from 'vitest';
import { FetchError, fetchSource } from '../fetch.ts';

// 本地開發用 .env 入面嘅 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（如果有）。
// CI 用 GitHub Actions secrets 直接注入 process.env，唔靠呢個檔。
try {
  process.loadEnvFile();
} catch {
  // 冇 .env 就算，唔阻住其他 render_mode 嘅 test。
}

/**
 * 呢個檔案係 integration test（Phase 1 acceptance 明文要求「三種 render_mode
 * 各有一個 integration test」）——真係打網絡，唔係 mock。用 example.com（穩定、
 * 唔會變）試 html 嘅成功/失敗路徑，用一份已知嘅渣打官方 PDF 試 pdf 抽取。
 *
 * ⚠️ 呢啲 test 需要網絡連線，`npm test` 而家會跟住打出去。想同一般 unit test
 * 分開行（例如 CI 唔想每次 push 都掂第三方網站）就要再抽做 test:integration
 * script + vitest project 設定，而家未做，一齊行喺 npm test 入面。
 */
const SC_SMART_TNC_PDF = 'https://av.sc.com/hk/zh/content/docs/hk-promo-smart-tnc.pdf';
const hasCloudflareCredentials = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

describe('連線設定', () => {
  it('import fetch.ts 就會抬高 Happy Eyeballs 嘅 per-address timeout', () => {
    // Node default 係 250ms，而 av.sc.com 由香港連過去 handshake 量到 217ms。
    // 實測 default 之下同一份 PDF 拉 6 次死 3 次，每次都喺 258ms 報 ETIMEDOUT
    // ——一個健康嘅 source 會扮 fetch_failed，然後 check_fail_count 累加、
    // 夠三次標 broken-source。呢個 test 守住嗰行設定唔好被人手快刪走。
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(2_000);
  });
});

describe('fetchSource（html）', () => {
  it('攞到真實網頁', async () => {
    const result = await fetchSource('https://example.com/', 'html');
    expect(result.status).toBe(200);
    expect(result.content).toContain('Example Domain');
  });

  it('HTTP 404 → 拋 FetchError，唔會靜靜傳返空內容', async () => {
    await expect(fetchSource('https://example.com/this-path-does-not-exist-404', 'html')).rejects.toBeInstanceOf(
      FetchError,
    );
  });

  it('timeout → 拋 FetchError', async () => {
    await expect(fetchSource('https://example.com/', 'html', { timeoutMs: 1 })).rejects.toThrow(/超時/);
  });
});

describe('fetchSource（pdf）', () => {
  it('落載 PDF 並且抽到文字', { timeout: 30_000 }, async () => {
    const result = await fetchSource(SC_SMART_TNC_PDF, 'pdf');
    expect(result.status).toBe(200);
    expect(result.content).toContain('Standard Chartered Smart Credit Card Terms');
  });
});

describe('fetchSource（js）', () => {
  it('冇 Cloudflare 憑證 → 拋清晰嘅 FetchError（唔理環境有冇設定，明確傳 undefined 憑證）', async () => {
    await expect(
      fetchSource('https://example.com/', 'js', { cloudflare: { apiToken: '', accountId: '' } }),
    ).rejects.toThrow(/Cloudflare/);
  });

  it.skipIf(!hasCloudflareCredentials)('用 Cloudflare Browser Rendering API 攞到已經行完 JS 嘅 HTML', async () => {
    const result = await fetchSource('https://example.com/', 'js');
    expect(result.status).toBe(200);
    expect(result.content).toContain('Example Domain');
  }, 30_000);

  if (!hasCloudflareCredentials) {
    it('冇 CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID，真實 Browser Rendering test 已 skip', () => {
      console.warn('冇搵到 Cloudflare 憑證，fetchSource(url, "js") 嘅真實 integration test 已 skip。');
      expect(true).toBe(true);
    });
  }
});
