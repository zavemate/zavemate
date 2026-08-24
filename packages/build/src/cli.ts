import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appendChangeEvents, changeEventsForCommit, rebuildAllChangeEvents } from './changes.ts';
import { loadData, repoRoot } from './load.ts';
import { uploadSnapshot } from './upload.ts';
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

/**
 * --rebuild-changes：由 commit 1 重新生成成條 change stream（§8 Phase 3 acceptance）。
 *
 * 呢個係 git 方案相對 DB 嘅實質優勢：change events 係 derived，唔係 source of
 * truth，所以 event schema 幾時想改都得，重跑一次就重建晒。DB 方案要做遷移。
 */
const rebuildChanges = process.argv.includes('--rebuild-changes');

/**
 * --upload：真係推上 R2。預設唔上傳——build 應該喺本機／CI 行得，唔使 credential。
 * 要 R2_BUCKET 同 wrangler 認得嘅 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。
 */
const upload = process.argv.includes('--upload');

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

const changesDir = join(distDir, 'changes');
const events = rebuildChanges
  ? rebuildAllChangeEvents()
  : changeEventsForCommit({
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      subject: execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      committedAt: new Date(
        Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot, encoding: 'utf8' }).trim()) * 1000,
      ).toISOString(),
    });

const appended = appendChangeEvents(events, changesDir);
const totalAppended = [...appended.values()].reduce((n, v) => n + v, 0);
console.log(
  rebuildChanges
    ? `change stream 由 commit 1 重建：${events.length} 個 event，寫入 ${totalAppended} 行`
    : `change events：${events.length} 個，寫入 ${totalAppended} 行`,
);

if (upload) {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    console.error('冇 R2_BUCKET，唔知上傳去邊。');
    process.exit(1);
  }
  const keys = [
    ...written.map((file) => file.path),
    ...[...appended.keys()].map((year) => join('changes', `${year}.jsonl`)),
  ];
  const uploaded = uploadSnapshot({ bucket, distDir, keys });
  console.log(`上傳咗 ${uploaded.length} 個 object 去 ${bucket}`);
  for (const object of uploaded) console.log(`  ${object.key}  ${object.cacheControl}`);
}
