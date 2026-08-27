import { appendFileSync } from 'node:fs';
import { createDeepSeekProvider } from './deepseek.ts';
import { runAgent1 } from './run.ts';

try {
  process.loadEnvFile();
} catch {
  // CI 用 workflow secrets 注入 process.env，冇 .env 就算。
}

const deepSeekKey = process.env.DEEPSEEK_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

if (!deepSeekKey) {
  console.error('冇 DEEPSEEK_API_KEY，冇得跑 Agent 1。');
  process.exit(1);
}
if (!githubToken) {
  console.error('冇 GITHUB_TOKEN，冇得開 PR。');
  process.exit(1);
}

const result = await runAgent1({
  provider: createDeepSeekProvider(deepSeekKey),
  githubToken,
});

// 交俾 workflow 落一步：checkout 個 branch、行返 validate、post commit status。
// GitHub 唔會為 GITHUB_TOKEN 開嘅 PR 觸發 workflow（防遞迴），所以 validate
// 永遠唔會自己喺 agent PR 上面跑——要我哋自己補返個 status，唔係嘅話 branch
// protection 會令每個週期 PR 都永遠 BLOCKED。
if (process.env.GITHUB_OUTPUT && result.branchName) {
  appendFileSync(process.env.GITHUB_OUTPUT, `branch=${result.branchName}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `pr_url=${result.prUrl ?? ''}\n`);

  /**
   * 可唔可以自動 merge。
   *
   * 條件特登窄過「gate 過晒」：一定要 changed === 0，即係成個 PR 淨係改
   * last_checked_at / last_verified_at / content_hash，冇任何回贈數值郁過。
   *
   * 點解唔用「冇 label」做條件：evaluateGate 捉嘅係唔合理嘅改動（跳幅過大、
   * cap 暴跌）。一個合理但錯嘅改動——例如實際仲係 4%，但抽成 3.8%——會過 gate、
   * 冇 label，然後靜靜哋入咗 main，冇人知個數字變過。
   *
   * 每週嗰啲噪音 PR 100% 都係 changed === 0 嗰種，所以呢個窄條件已經完全
   * 解決噪音問題，同時唔使削弱事實層。
   */
  //
  // 修復咗 evidence 都仲算「零改動」——段引文係機器逐字驗證過，而回贈數值一個字
  // 都冇郁。人喺度睇一眼加唔到任何嘢。
  //
  // 但一有 question 就唔可以自動 merge：question 嘅存在本身就係「我哋搞唔掂，
  // 要人答」。
  const autoMergeable =
    result.changed === 0 && result.gatePassed && result.brokenSources.length === 0 && result.questionsRaised === 0;
  appendFileSync(process.env.GITHUB_OUTPUT, `auto_mergeable=${autoMergeable}\n`);
}

if (result.prUrl) {
  console.log(`開咗 PR：${result.prUrl}`);
  console.log(`${result.changed} 條 rule 有改動，${result.verified} 條核實咗，成本 $${result.totalCostUsd.toFixed(4)}`);
  if (result.repaired > 0) console.log(`🔧 自動修好咗 ${result.repaired} 條 evidence（機器驗證過，數值冇郁）`);
  if (result.questionsRaised > 0) console.log(`❓ 開咗 ${result.questionsRaised} 條 question 等人答`);
  if (!result.gatePassed) console.log('⚠️ Gate 冧咗至少一項，已標 needs-review');
  if (result.brokenSources.length > 0) console.log(`⚠️ Broken source：${result.brokenSources.join(', ')}`);
} else {
  console.log('今次冇任何改動，冇開 PR。');
}
