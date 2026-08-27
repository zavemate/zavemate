import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ZodError } from 'zod';
import { Card } from '../card.ts';
import { Promotion } from '../promotion.ts';
import { Question, questionId } from '../question.ts';
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
        for (const cardId of source.card_ids) {
          if (!cards.has(cardId)) {
            fail(sourcesFile, [`  source "${source.source_id}" 指住唔存在嘅 card_id "${cardId}"`]);
          }
        }
      }
    }
  }
}

// --------------------------------------------------- questions

const questionFiles = existsSync(join(dataDir, 'questions')) ? listJson(join(dataDir, 'questions')) : [];
const seenQuestions = new Set<string>();
/** rule_id → 有冇 open question。有嘅話嗰條 rule 唔可以標 official。 */
const blocked = new Set<string>();

for (const file of questionFiles) {
  const raw = parseJson(file);
  if (raw === undefined) continue;
  const question = parseWith(file, Question, raw);
  if (!question) continue;

  const expected = basename(file, '.json');
  if (question.question_id !== expected) {
    fail(file, [`  檔名 = id：question_id 係 "${question.question_id}"，但檔名係 "${expected}"`]);
    continue;
  }
  if (seenQuestions.has(question.question_id)) {
    fail(file, [`  question_id "${question.question_id}" 重複`]);
    continue;
  }
  seenQuestions.add(question.question_id);

  if (!cards.has(question.card_id)) {
    fail(file, [`  指住唔存在嘅 card_id "${question.card_id}"`]);
    continue;
  }
  if (question.rule_id !== null) {
    if (ruleOwner.get(question.rule_id) !== question.card_id) {
      fail(file, [`  指住 rule_id "${question.rule_id}"，但嗰條 rule 唔屬於 card "${question.card_id}"`]);
      continue;
    }
    const expectedId = questionId(question.rule_id, question.kind);
    if (question.question_id !== expectedId) {
      // id 決定性產生，先至保證同一條 rule 同一種問題唔會開兩次。
      fail(file, [`  question_id 應該係 "${expectedId}"（{rule_id}_{kind}），而家係 "${question.question_id}"`]);
      continue;
    }
    if (question.status === 'open') blocked.add(question.rule_id);
  }

  if (question.status === 'answered' && question.answer === null) {
    fail(file, ['  status 係 "answered" 但 answer 係 null——答咗就要寫低答咗乜']);
  }
  if (question.status === 'open' && question.answer !== null) {
    fail(file, ['  已經有 answer 但 status 仲係 "open"——答完要改埋 status']);
  }
}

// 有 open question 嘅 rule 唔可以標 official。
//
// 「我哋知道自己有一條未答嘅問題」同「我哋確認呢個數字有官方出處」唔可以並存。
// 冇呢條規則，一條有已知疑問嘅 rule 會繼續以 official 出街，而個疑問淨係
// 活喺一個冇人再睇嘅檔案入面。
for (const [cardId, card] of cards) {
  for (const rule of card.rewards) {
    if (!blocked.has(rule.rule_id)) continue;
    if (rule.provenance.confidence !== 'official') continue;
    fail(join(dataDir, 'cards', `${cardId}.json`), [
      `  rule "${rule.rule_id}" 有 open question（data/questions/），但 confidence 標住 "official"——未答到嘅嘢唔可以當已確認`,
    ]);
  }
}

// --------------------------------------------------- 冇人認領嘅 data 檔

const known = new Set([...cardFiles, ...promotionFiles, ...questionFiles, valuationsFile, sourcesFile]);
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
