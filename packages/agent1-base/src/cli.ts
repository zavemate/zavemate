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
}

if (result.prUrl) {
  console.log(`開咗 PR：${result.prUrl}`);
  console.log(`${result.changed} 條 rule 有改動，${result.verified} 條核實咗，成本 $${result.totalCostUsd.toFixed(4)}`);
  if (!result.gatePassed) console.log('⚠️ Gate 冧咗至少一項，已標 needs-review');
  if (result.brokenSources.length > 0) console.log(`⚠️ Broken source：${result.brokenSources.join(', ')}`);
} else {
  console.log('今次冇任何改動，冇開 PR。');
}
