import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { Card } from '../card.ts';
import { Promotion } from '../promotion.ts';
import { canonicalStringify, type JsonValue } from '../canonical.ts';
import { parseMode, readText, rel, schemasDir } from './util.ts';

/**
 * Zod 係唯一定義來源；JSON Schema 由呢度產生並 commit 落 schemas/（外部 agent 要讀）。
 *
 * 注意：Zod 嘅 cross-field refinement（例如 reward.type 同 reward.rate 嘅對應關係、
 * end_date = null 就要 unconfirmed）表達唔到落 JSON Schema。
 * JSON Schema 講結構，Zod 先係權威 —— docs/api.md 要寫明呢點。
 */
const targets: Array<{ file: string; name: string; schema: ZodTypeAny }> = [
  { file: 'card.schema.json', name: 'Card', schema: Card },
  { file: 'promotion.schema.json', name: 'Promotion', schema: Promotion },
];

const mode = parseMode(process.argv.slice(2));
mkdirSync(schemasDir, { recursive: true });

let stale = 0;

for (const target of targets) {
  const generated = zodToJsonSchema(target.schema, {
    name: target.name,
    $refStrategy: 'root',
  }) as unknown as JsonValue;
  const text = canonicalStringify(generated);
  const path = join(schemasDir, target.file);

  let current: string | null = null;
  try {
    current = readText(path);
  } catch {
    current = null;
  }

  if (current === text) continue;

  if (mode === 'write') {
    writeFileSync(path, text, 'utf8');
    console.log(`✎ ${rel(path)}`);
  } else {
    console.error(`✗ ${rel(path)} 同 Zod 定義唔同步`);
    stale += 1;
  }
}

if (mode === 'check') {
  if (stale > 0) {
    console.error(`\n${stale} 個 JSON Schema 過時。行 \`npm run schema:build\` 重新產生再 commit。`);
    process.exit(1);
  }
  console.log(`JSON Schema 同 Zod 同步（${targets.length} 個檔）`);
} else {
  console.log('JSON Schema 已產生');
}
