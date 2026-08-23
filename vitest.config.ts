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
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
