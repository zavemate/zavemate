/**
 * 將一個 RSS feed 拆返做一篇篇文章。
 *
 * 點解要拆：實測 hkcashrebate 個「限時優惠」feed 帶全文（12 篇、22,000 字元）。
 * 成嚿餵落 `deepseek-v4-flash` 係 16,664 tokens in / **8 tokens out**——交返
 * 一個空陣列，即係喺噪音入面冧咗。同一個 model 單獨餵其中一篇（2,872 tokens）
 * 就交到一條完整 promotion（card_id / reward / cap / 起訖日 / verbatim evidence）。
 * 分別唔喺 model 質素，喺 input 長度。
 *
 * 同 extractMainContent 一樣用輕量 regex，冇引入 XML parser library（跟
 * CLAUDE.md「唔好裝重型 framework」）。RSS 2.0 嘅 <item> 結構簡單同穩定，
 * 撐得住；如果將來要食 Atom 或者 namespace 玩得複雜嘅 feed，再換正式 parser。
 */

import { assessExtraction, extractMainContent, sha256 } from '@zavemate/core';

export interface FeedItem {
  /**
   * 去重同短路嘅 key。優先用 <guid>，冇就退返 <link>。
   *
   * 唔用 <title>：標題改得，改咗就會當新文重抽一次。
   */
  guid: string;
  link: string | null;
  title: string;
  /** RFC 822 原文，唔轉——我哋唔靠佢做判斷，淨係擺落 PR body 俾人睇。 */
  published: string | null;
  /** <content:encoded> 嘅原始 HTML，冇就退返 <description>。 */
  contentHtml: string;
}

function unwrapCdata(raw: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return match?.[1] ?? raw;
}

/**
 * 攞一個 tag 嘅內容。
 *
 * 特登唔用 non-greedy 加貪心 fallback：`content:encoded` 入面成篇文章 HTML
 * 都有可能出現「</p>」之類，但唔會出現「</content:encoded>」，所以 non-greedy
 * 配對到第一個閉合 tag 就啱。
 */
function tagText(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = pattern.exec(xml);
  const inner = match?.[1];
  if (inner === undefined) return null;
  const value = unwrapCdata(inner).trim();
  return value.length > 0 ? value : null;
}

/**
 * 由 feed XML 抽出一個個 item。
 *
 * 認唔到任何 item 就交空陣列——由 call 嗰邊決定當「呢個 feed 壞咗」定係
 * 「暫時真係一篇文都冇」。呢度唔擅自 throw，因為兩種情況嘅處理唔同。
 */
export function parseFeedItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;

    const link = tagText(raw, 'link');
    const guid = tagText(raw, 'guid') ?? link;
    const contentHtml = tagText(raw, 'content:encoded') ?? tagText(raw, 'description');

    // 冇 guid 認唔到係邊篇，冇內容抽唔到嘢——兩者缺一都唔可以短路，
    // 所以直接跳過好過寫一個永遠對唔上嘅 hash 落 sources.json。
    if (!guid || !contentHtml) continue;

    items.push({
      guid,
      link,
      title: tagText(raw, 'title') ?? '（冇標題）',
      published: tagText(raw, 'pubDate'),
      contentHtml,
    });
  }

  return items;
}

/**
 * 一次跑最多幾多篇。
 *
 * 唔係為咗慳錢（一篇約 $0.0009），係為咗擋一個 feed 突然回三百篇——嗰陣唔應該
 * 靜靜哋碌三百次 LLM。跑唔切嗰啲**唔會寫 hash**，所以下次會接住跑，幾個週期
 * 之內一樣會睇曬。
 */
export const MAX_FEED_ITEMS_PER_RUN = 40;

/** 一篇準備好餵落 LLM 嘅文章。 */
export interface FeedWorkItem {
  item: FeedItem;
  /** 已經抽成純文字，連標題／日期／連結做 header。 */
  text: string;
  hash: string;
}

export interface FeedWork {
  /** 今次要餵 LLM 嗰啲。 */
  toProcess: FeedWorkItem[];
  /**
   * 已經睇過而且冇改過嘅 guid → hash，直接帶落新 map。
   *
   * 「帶落」而唔係「留喺舊 map」係剪枝嘅關鍵：新 map 只由 feed 而家仲有嗰批
   * item 砌返出嚟，跌咗出 feed 嘅舊文自然唔會再喺度。
   */
  carried: Record<string, string>;
  notes: string[];
}

/**
 * 篇文餵落 LLM 之前點砌。
 *
 * 標題／日期／連結一齊餵：正文成日淨係寫「推廣期由7月6日至7月31日」而唔寫年份，
 * 冇 pubDate 就要模型自己估——而 prompt 明文寫住「唔好估」。
 */
export function feedItemContent(item: FeedItem): string {
  const header = [item.title, item.published, item.link].filter(Boolean).join('\n');
  return `${header}\n\n${extractMainContent(item.contentHtml)}`;
}

/**
 * 決定邊幾篇要重新讀。純函數，唔掂網絡亦唔掂 LLM。
 *
 * `known` 空 = 由零開始 → **成個 feed 逐篇睇曬**。之後每次只讀新出嘅同埋
 * 內容真係改過嗰啲。
 */
export function selectFeedWork(
  items: FeedItem[],
  known: Record<string, string>,
  max: number = MAX_FEED_ITEMS_PER_RUN,
): FeedWork {
  const toProcess: FeedWorkItem[] = [];
  const carried: Record<string, string> = {};
  const notes: string[] = [];

  for (const item of items) {
    const text = feedItemContent(item);
    const hash = sha256(text);

    if (known[item.guid] === hash) {
      carried[item.guid] = hash;
      continue;
    }

    const assessment = assessExtraction(text);
    if (assessment.tooThin) {
      // 特登唔寫 hash：寫咗就等於話「呢篇睇過」，之後永遠唔會再試。呢個正正
      // 係 assessExtraction 本身要解決嗰個「穩定嘅抽取失敗」陷阱。
      notes.push(`⚠️ ${item.title}：${assessment.reason}，未讀到，下次再試`);
      continue;
    }

    if (toProcess.length >= max) {
      notes.push(`⏭️ ${item.title}：今次跑唔切（一次上限 ${max} 篇），下次接住跑`);
      continue;
    }

    toProcess.push({ item, text, hash });
  }

  notes.unshift(
    `${items.length} 篇文，${Object.keys(carried).length} 篇 hash 命中冇改過，${toProcess.length} 篇要重新讀`,
  );

  return { toProcess, carried, notes };
}
