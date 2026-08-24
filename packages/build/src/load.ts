import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Card, Promotion, Valuations } from '@zavemate/schema';

/** packages/build/src/load.ts → repo root。 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface DataSet {
  cards: Card[];
  promotions: Promotion[];
  valuations: Valuations;
}

function readJsonDir<T>(dir: string, parse: (raw: unknown) => T): T[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => parse(JSON.parse(readFileSync(join(dir, entry), 'utf8'))));
}

/**
 * 讀晒 data/ 並且逐個 Zod 驗證。
 *
 * §7.2 步驟 1：任何一個檔唔過就 throw——build 失敗好過部署咗一份壞 snapshot。
 * 呢度特登唔做「跳過壞檔繼續」：snapshot 係對外嘅事實層，缺一張卡同出錯一樣嚴重，
 * 而且靜靜少咗一張卡冇人會察覺。
 */
export function loadData(root: string = repoRoot): DataSet {
  const dataDir = join(root, 'data');
  return {
    cards: readJsonDir(join(dataDir, 'cards'), (raw) => Card.parse(raw)),
    promotions: readJsonDir(join(dataDir, 'promotions'), (raw) => Promotion.parse(raw)),
    valuations: Valuations.parse(JSON.parse(readFileSync(join(dataDir, 'valuations.json'), 'utf8'))),
  };
}
