import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadData, repoRoot } from './load.ts';
import { buildSnapshot } from './snapshot.ts';
import { writeSnapshot } from './write.ts';

/** §7.2：{sha} = commit SHA，唔好自己發明版本號。CI 有 GITHUB_SHA，本機就問 git。 */
function resolveVersion(): string {
  const fromEnv = process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const version = resolveVersion();
const asOf = process.env.SNAPSHOT_AS_OF ?? new Date().toISOString().slice(0, 10);
const distDir = join(repoRoot, 'dist');

const data = loadData();
const snapshot = buildSnapshot(data, { version, asOf });
const written = writeSnapshot(snapshot, distDir);

const total = written.reduce((n, f) => n + f.bytes, 0);
console.log(`snapshot ${version}（as_of ${asOf}）`);
console.log(
  `  ${snapshot.coverage.cards} 張卡 / ${snapshot.coverage.rules} 條 rule / ${snapshot.coverage.promotions} 個 promotion`,
);
console.log(
  `  其中 ${snapshot.coverage.unconfirmed_rules} 條唔係 official、${snapshot.coverage.undetermined_rules} 條適用範圍表達唔到`,
);
console.log(`  ${written.length} 個檔，共 ${(total / 1024).toFixed(1)} KB`);
