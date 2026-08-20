import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ZodError } from 'zod';
import { Card } from '../card.ts';
import { Promotion } from '../promotion.ts';
import { Sources } from '../sources.ts';
import { Valuations } from '../valuations.ts';
import { dataDir, formatZodError, listJson, readText, rel } from './util.ts';

const errors: string[] = [];

function fail(file: string, lines: string[]): void {
  errors.push([`✗ ${rel(file)}`, ...lines].join('\n'));
}

function parseJson(file: string): unknown | undefined {
  try {
    return JSON.parse(readText(file)) as unknown;
  } catch (error) {
    fail(file, [`  JSON parse 失敗：${(error as Error).message}`]);
    return undefined;
  }
}

function parseWith<T>(file: string, schema: { parse: (input: unknown) => T }, raw: unknown): T | undefined {
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      fail(file, formatZodError(error));
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- cards

const cardFiles = listJson(join(dataDir, 'cards'));
const cards = new Map<string, ReturnType<typeof Card.parse>>();
const ruleOwner = new Map<string, string>();

for (const file of cardFiles) {
  const raw = parseJson(file);
  if (raw === undefined) continue;
  const card = parseWith(file, Card, raw);
  if (!card) continue;

  const expected = basename(file, '.json');
  if (card.card_id !== expected) {
    fail(file, [`  檔名 = id（§4.6）：card_id 係 "${card.card_id}"，但檔名係 "${expected}"`]);
    continue;
  }
  if (cards.has(card.card_id)) {
    fail(file, [`  card_id "${card.card_id}" 重複`]);
    continue;
  }
  cards.set(card.card_id, card);

  for (const rule of card.rewards) {
    const owner = ruleOwner.get(rule.rule_id);
    if (owner !== undefined) {
      fail(file, [`  rule_id "${rule.rule_id}" 全域重複，已經俾 "${owner}" 用咗（§9 唔可以做 #9）`]);
      continue;
    }
    ruleOwner.set(rule.rule_id, card.card_id);
  }
}

// ----------------------------------------------------------- promotions

const promotionFiles = listJson(join(dataDir, 'promotions'));
const promotionIds = new Set<string>();

for (const file of promotionFiles) {
  const raw = parseJson(file);
  if (raw === undefined) continue;
  const promotion = parseWith(file, Promotion, raw);
  if (!promotion) continue;

  const expected = basename(file, '.json');
  if (promotion.promotion_id !== expected) {
    fail(file, [
      `  檔名 = id（§4.6）：promotion_id 係 "${promotion.promotion_id}"，但檔名係 "${expected}"`,
    ]);
    continue;
  }
  if (promotionIds.has(promotion.promotion_id)) {
    fail(file, [`  promotion_id "${promotion.promotion_id}" 重複`]);
    continue;
  }
  promotionIds.add(promotion.promotion_id);

  if (!cards.has(promotion.card_id)) {
    fail(file, [`  card_id "${promotion.card_id}" 喺 data/cards/ 搵唔到`]);
  }
  if (!promotion.promotion_id.startsWith(`${promotion.card_id}_`)) {
    fail(file, [
      `  promotion_id 要跟 {card_id}_{yyyyqn}_{slug}（§6.5 去重），而家係 "${promotion.promotion_id}"`,
    ]);
  }
}

// ------------------------------------------------- valuations / sources

const valuationsFile = join(dataDir, 'valuations.json');
if (!existsSync(valuationsFile)) {
  errors.push(`✗ ${rel(valuationsFile)}\n  搵唔到呢個檔`);
} else {
  const raw = parseJson(valuationsFile);
  if (raw !== undefined) parseWith(valuationsFile, Valuations, raw);
}

const sourcesFile = join(dataDir, 'sources.json');
if (!existsSync(sourcesFile)) {
  errors.push(`✗ ${rel(sourcesFile)}\n  搵唔到呢個檔`);
} else {
  const raw = parseJson(sourcesFile);
  if (raw !== undefined) {
    const sources = parseWith(sourcesFile, Sources, raw);
    if (sources) {
      const seen = new Set<string>();
      for (const source of sources.sources) {
        if (seen.has(source.source_id)) {
          fail(sourcesFile, [`  source_id "${source.source_id}" 重複`]);
        }
        seen.add(source.source_id);
        if (source.card_id !== null && !cards.has(source.card_id)) {
          fail(sourcesFile, [`  source "${source.source_id}" 指住唔存在嘅 card_id "${source.card_id}"`]);
        }
      }
    }
  }
}

// --------------------------------------------------- 冇人認領嘅 data 檔

const known = new Set([...cardFiles, ...promotionFiles, valuationsFile, sourcesFile]);
for (const file of listJson(dataDir)) {
  if (!known.has(file)) {
    errors.push(`✗ ${rel(file)}\n  data/ 入面有個冇 schema 認領嘅檔`);
  }
}

// ------------------------------------------------------------- 出結果

if (errors.length > 0) {
  console.error(errors.join('\n\n'));
  console.error(`\n${errors.length} 個問題。`);
  process.exit(1);
}

const ruleCount = [...cards.values()].reduce((sum, card) => sum + card.rewards.length, 0);
console.log(
  `validate 通過：${cards.size} 張卡 / ${ruleCount} 條 rule / ${promotionIds.size} 個 promotion`,
);
