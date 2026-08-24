import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, serialize, type Snapshot } from './snapshot.ts';

export interface WrittenFile {
  /** R2 / URL 上面嘅相對路徑。 */
  path: string;
  bytes: number;
}

/**
 * 寫 dist/v/{sha}/。
 *
 * 呢個路徑對外會設 max-age=31536000, immutable，所以 {sha} 底下嘅內容永遠
 * 唔可以改——要改就出新 commit、新 sha。舊 snapshot 永久保留（§7.7）。
 */
export function writeSnapshot(snapshot: Snapshot, distDir: string): WrittenFile[] {
  const versionDir = join(distDir, 'v', snapshot.snapshot_version);
  mkdirSync(join(versionDir, 'cards'), { recursive: true });

  const written: WrittenFile[] = [];
  const emit = (relativePath: string, value: unknown) => {
    const body = serialize(value);
    writeFileSync(join(versionDir, relativePath), body);
    written.push({ path: join('v', snapshot.snapshot_version, relativePath), bytes: Buffer.byteLength(body) });
  };

  emit('full.json', snapshot);
  emit('index.json', buildIndex(snapshot));
  for (const card of snapshot.cards) {
    emit(join('cards', `${card.card_id}.json`), {
      schema_version: snapshot.schema_version,
      snapshot_version: snapshot.snapshot_version,
      generated_at: snapshot.generated_at,
      card,
    });
  }
  return written;
}
