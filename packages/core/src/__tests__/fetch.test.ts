import { describe, expect, it } from 'vitest';
import { FetchError, fetchSource } from '../fetch.ts';

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
  it('落載 PDF 並且抽到文字', async () => {
    const result = await fetchSource(SC_SMART_TNC_PDF, 'pdf');
    expect(result.status).toBe(200);
    expect(result.content).toContain('Standard Chartered Smart Credit Card Terms');
  }, 30_000);
});

describe('fetchSource（js）', () => {
  it('未有 Cloudflare Browser Rendering 資源 → 拋清晰嘅 FetchError', async () => {
    await expect(fetchSource('https://example.com/', 'js')).rejects.toThrow(/Cloudflare/);
  });
});
