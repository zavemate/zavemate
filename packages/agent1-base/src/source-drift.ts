import type { Card } from '@zavemate/schema';

/**
 * 「我哋引用嗰份文件，發卡行自己仲有冇 link？」
 *
 * 2026-08-29 撞到：`sc_simply_cash_visa` 引用緊一份 **2020 年 6 月**嘅 T&C，
 * 而渣打自己個卡頁 link 緊 2026 年 4 月嗰份（檔名多咗 `-noc`）。差成 5 年 9
 * 個月，但每一個現有檢查都綠燈：
 *
 * - `evidenceSupportedBy` 過 —— 舊文件真係有嗰句
 * - hash 短路命中 —— 舊文件真係冇改過（佢已經冇人再更新，梗係冇改）
 * - `source_moved` gate 唔響 —— host 一模一樣
 * - `last_verified_at` 每星期照更新
 *
 * 佢哋全部只問「呢句嘢喺唔喺呢份文件入面」。**冇一個問過「呢份文件仲係咪
 * 嗰份文件」。**呢個模組就係補返嗰一問。
 *
 * 準繩係卡層 `purpose: 'product_page'` 嗰個 source —— 發卡行自己嘅卡頁。
 * 佢 link 緊邊幾份文件，就係佢自己認嘅答案；我哋唔使自己判邊份新啲。
 */

/** 由卡頁 HTML 抽出佢 link 緊嘅文件 URL。 */
export function extractLinkedDocs(html: string, pageUrl: string): Set<string> {
  const found = new Set<string>();
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return found;
  }

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    let absolute: URL;
    try {
      absolute = new URL(raw, origin);
    } catch {
      continue;
    }
    // 淨係收文件，唔收頁。追蹤參數要剝走——同一份 PDF 掛住唔同 intcid
    // 就會當咗兩份，成個比對即刻報一大堆假 drift。
    if (!/\.pdf$/i.test(absolute.pathname)) continue;
    absolute.search = '';
    absolute.hash = '';
    found.add(absolute.toString());
  }
  return found;
}

export interface SourceDrift {
  cardId: string;
  /** 我哋引用緊、但卡頁已經冇 link 嘅文件。 */
  citedUrl: string;
  purpose: string;
  /** 發卡行卡頁嘅 URL——即係我哋攞嚟做準繩嗰版。 */
  productPageUrl: string;
  /** 卡頁而家 link 緊嘅文件，俾人手揀返啱嗰份。 */
  linkedDocs: string[];
}

export interface DriftInput {
  card: Card;
  productPageUrl: string;
  linkedDocs: Set<string>;
}

/**
 * 純函數：對比一張卡引用緊嘅文件同卡頁 link 緊嘅文件。
 *
 * 特登**只檢查 PDF**。卡頁本身、以及 HTML 條款頁都唔算——佢哋通常係一條
 * 穩定嘅 landing URL，內容自己會更新，唔會出現「版本換咗檔名」呢個問題。
 * 而正正係 PDF 會靜靜哋換檔名（`-noc`、`t0`→`t1`）然後舊檔繼續開得。
 *
 * 卡頁一份 PDF 都 link 唔到 = 多數係我哋讀唔到嗰版（SPA、WAF），唔係
 * 「所有文件都過時」。嗰種情況交空陣列，唔好一次過報成張卡 drift。
 */
export function findSourceDrift(input: DriftInput): SourceDrift[] {
  if (input.linkedDocs.size === 0) return [];

  const drifts: SourceDrift[] = [];
  for (const source of input.card.sources) {
    if (!/\.pdf$/i.test(new URL(source.url).pathname)) continue;
    if (input.linkedDocs.has(source.url)) continue;

    drifts.push({
      cardId: input.card.card_id,
      citedUrl: source.url,
      purpose: source.purpose,
      productPageUrl: input.productPageUrl,
      linkedDocs: [...input.linkedDocs].sort(),
    });
  }
  return drifts;
}

/** 張卡嘅產品頁——drift 檢查嘅準繩。冇就跳過呢張卡。 */
export function productPageOf(card: Card): string | null {
  return card.sources.find((source) => source.purpose === 'product_page')?.url ?? null;
}
