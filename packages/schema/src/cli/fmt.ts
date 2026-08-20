import { writeFileSync } from 'node:fs';
import { checkCanonical } from '../canonical.ts';
import { dataDir, listJson, parseMode, readText, rel, schemasDir } from './util.ts';

/**
 * 只管 data/ 同 schemas/ —— 呢兩度嘅 diff 要 deterministic 到人手審核睇得落。
 * package.json 之類跟 npm 自己嘅慣例，唔喺呢個規範範圍。
 */
const mode = parseMode(process.argv.slice(2));
const files = [...listJson(dataDir), ...listJson(schemasDir)];

let bad = 0;
let fixed = 0;

for (const file of files) {
  const result = checkCanonical(readText(file));
  if (result.ok) continue;

  const unparseable = result.problems.some((problem) => problem.startsWith('JSON parse 失敗'));

  if (mode === 'write' && !unparseable) {
    writeFileSync(file, result.canonical, 'utf8');
    console.log(`✎ ${rel(file)}`);
    fixed += 1;
    continue;
  }

  console.error(`✗ ${rel(file)}`);
  for (const problem of result.problems) console.error(`  ${problem}`);
  bad += 1;
}

if (bad > 0) {
  console.error(
    mode === 'write'
      ? `\n${bad} 個檔 parse 唔到，要人手修。`
      : `\n${bad} 個檔唔符合 canonical format（§4.6）。行 \`npm run fmt\` 修正。`,
  );
  process.exit(1);
}

console.log(
  mode === 'write'
    ? fixed === 0
      ? `所有檔已經係 canonical format（${files.length} 個檔）`
      : `已格式化 ${fixed} 個檔`
    : `canonical format 檢查通過（${files.length} 個檔）`,
);
