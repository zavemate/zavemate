import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Test file 唔好並行。
     *
     * 我哋幾個 integration test 打緊同一批真實銀行網站（av.sc.com / www.sc.com），
     * 並行嗰陣幾個 file 同時打就會觸發限流，隨機出 `fetch failed`——單獨跑每個
     * file 都過，一齊跑就間歇性紅。加 retry 都救唔到，因為重試係即刻連發，撞返
     * 同一個限流窗口。
     *
     * 成個 suite 得二十幾秒，序列化嘅代價遠細過「CI 隨機紅、然後大家開始習慣
     * 無視紅燈」。
     */
    fileParallelism: false,
    /**
     * Test timeout 要大過生產 fetch 嘅 timeout。
     *
     * `fetchSource` 自己嘅 `DEFAULT_TIMEOUT_MS` 係 20 秒，再加 per-host 1.2 秒間隔。
     * Vitest default 得 5 秒——即係任何一個打真實銀行網站嘅 integration test，只要
     * 對面慢過 5 秒，test 就會喺 code 仲等緊嘅時候先死。咁樣紅法同「有 bug」完全
     * 分唔開，而 `validate` 係 branch protection 嘅 required check：佢隨機紅 = 每個
     * agent PR 都 merge 唔到，然後大家開始習慣無視紅燈。
     *
     * 30 秒 = 20 秒 fetch + 1.2 秒間隔 + 餘裕。呢個數跟住 `DEFAULT_TIMEOUT_MS` 走，
     * 改嗰邊記得改返呢度。
     */
    testTimeout: 30_000,
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
