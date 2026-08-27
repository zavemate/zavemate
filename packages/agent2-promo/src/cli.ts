import { appendFileSync } from 'node:fs';
import { createDeepSeekProvider } from '@zavemate/agent1-base';
import { runAgent2 } from './run.ts';

try {
  process.loadEnvFile();
} catch {
  // CI 用 workflow secrets 注入 process.env。
}

const deepSeekKey = process.env.DEEPSEEK_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

if (!deepSeekKey) {
  console.error('冇 DEEPSEEK_API_KEY，冇得跑 Agent 2。');
  process.exit(1);
}
if (!githubToken) {
  console.error('冇 GITHUB_TOKEN，冇得開 PR。');
  process.exit(1);
}

const result = await runAgent2({ provider: createDeepSeekProvider(deepSeekKey), githubToken });

// 交俾 workflow 落一步補 validate status——GitHub 唔會為 GITHUB_TOKEN 開嘅 PR
// 觸發 workflow，唔自己補個 status 就會永遠 BLOCKED（Agent 1 撞過）。
if (process.env.GITHUB_OUTPUT && result.branchName) {
  appendFileSync(process.env.GITHUB_OUTPUT, `branch=${result.branchName}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `pr_url=${result.prUrl ?? ''}\n`);

  // 同 Agent 1 一樣：淨係更新 source timestamp／hash、冇任何優惠郁過嘅 PR
  // 先自動 merge。Agent 2 逢二／四／六跑，噪音比 Agent 1 多三倍。
  const autoMergeable =
    result.added === 0 &&
    result.updated === 0 &&
    result.expired === 0 &&
    result.proposedSources === 0 &&
    result.brokenSources.length === 0;
  appendFileSync(process.env.GITHUB_OUTPUT, `auto_mergeable=${autoMergeable}\n`);
}

if (result.prUrl) {
  console.log(`開咗 PR：${result.prUrl}`);
  console.log(
    `新增 ${result.added}、更新 ${result.updated}、過期 ${result.expired}、提議官方來源 ${result.proposedSources}，成本 $${result.totalCostUsd.toFixed(4)}`,
  );
  if (result.brokenSources.length > 0) console.log(`⚠️ Broken source：${result.brokenSources.join(', ')}`);
} else {
  console.log('今次冇任何改動，冇開 PR。');
}
