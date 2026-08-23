import { assessExtraction, extractMainContent, FetchError, fetchSource, headSource, type RenderMode } from '@zavemate/core';

/**
 * 由一張卡嘅官網頁面，爬返佢 link 出去嘅全部 PDF。
 *
 * 點解要有呢一步：Phase 0 嘅 source_url 係人手一條條填落 rule 度嘅，冇任何
 * 機制答到「呢張卡啲條款收齊咗未」。實際後果係 hsbc_everymile 攞咗份商戶名單
 * 當回贈率出處、hsbc_red 淨係指住通用計劃條款——兩張卡真正嘅獎賞計劃 PDF
 * 從來冇入過 repo。
 *
 * 而銀行自己個產品頁就係權威嘅清單：條款 PDF 一定係由嗰度 link 出去。
 * 所以拎齊嘅正確做法唔係估 URL，係爬個頁。
 *
 * 呢個工具**唔會**自動判斷邊份係咩用途——purpose 要人手打，因為分
 * 「scheme vs programme_base vs merchant_list」要讀完份文件先講得準，
 * 而呢個判斷正正就係之前錯到最緊要嗰度。工具只負責搵齊 + 量度。
 */
export interface DiscoveredSource {
  url: string;
  lastModified: string | null;
  etag: string | null;
  contentLength: number | null;
  /** 抽到幾多字元。null = 攞唔到／抽唔到。 */
  chars: number | null;
  pages: number | null;
  /** true = 抽取太薄（多數係圖片型 PDF），呢份文件冇得自動核實。 */
  tooThin: boolean;
  error: string | null;
}

const PDF_LINK = /["'(]([^"'()\s]*\.pdf)(?:[?#][^"'()\s]*)?/gi;

export function extractPdfLinks(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(PDF_LINK)) {
    try {
      urls.add(new URL(match[1]!, pageUrl).toString());
    } catch {
      // 砌唔到 URL 就跳過，唔好因為一條爛 link 拉冧成個 discovery。
    }
  }
  return [...urls].sort();
}


/**
 * HSBC 同一份文件有中英兩版：/content/dam/hsbc/hk/docs/... （英）同
 * /content/dam/hsbc/hk/tc/docs/...（中）。
 *
 * 關鍵係：邊個版本抽到文字係**逐份唔同**，冇規律。實測：
 *   hsbc-credit-card-terms.pdf        英 44,894 字 ✅ ／ 中 774 字 ⚠️
 *   offers/welcome-terms-and-conditions.pdf  英 135 字 ⚠️ ／ 中 3,472 字 ✅
 * 完全相反。所以唔可以「一律用中文版」或者「一律用英文版」，要逐份試。
 */
export function languageVariants(url: string): string[] {
  const TC = '/content/dam/hsbc/hk/tc/docs/';
  const EN = '/content/dam/hsbc/hk/docs/';
  if (url.includes(TC)) return [url.replace(TC, EN)];
  if (url.includes(EN)) return [url.replace(EN, TC)];
  return [];
}

/** 渣打個 CDN (av.sc.com / sc.com/global/av) 間唔中會 connection timeout，一次過跑十幾份必中幾份。 */
async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * i));
    }
  }
}

export async function inspectSource(url: string): Promise<DiscoveredSource> {
  const base: DiscoveredSource = {
    url,
    lastModified: null,
    etag: null,
    contentLength: null,
    chars: null,
    pages: null,
    tooThin: false,
    error: null,
  };

  try {
    const head = await retry(() => headSource(url));
    base.lastModified = head.lastModified;
    base.etag = head.etag;
    base.contentLength = head.contentLength;
  } catch (error) {
    base.error = error instanceof FetchError ? error.message : String(error);
    return base;
  }

  try {
    const text = extractMainContent((await retry(() => fetchSource(url, 'pdf'))).content);
    const assessment = assessExtraction(text);
    base.chars = assessment.chars;
    base.pages = assessment.pages;
    base.tooThin = assessment.tooThin;
  } catch (error) {
    base.error = error instanceof FetchError ? error.message : String(error);
  }
  return base;
}


/**
 * 由一間銀行嘅信用卡 hub 頁，攞晒佢 link 出去嘅卡相關頁面。
 *
 * 呢個係 discovery 嘅第一層：banks 自己嗰版總覽頁就係權威嘅卡清單。
 * 由佢入手先答到「我哋收齊晒呢間銀行幾多張卡」——實測 HSBC 嗰版
 * (https://www.hsbc.com.hk/zh-hk/credit-cards/) 列出 9 張消費卡，
 * 而 repo 入面只有 3 張。冇呢一層，欠幾多張卡係睇唔出嚟嘅。
 *
 * 同 extractPdfLinks 一樣：只負責搵，唔負責判斷邊條係產品頁——URL 命名
 * 每間銀行都唔同，寧願列多啲俾人揀，好過靜靜咁漏。
 */
export function extractCardPageLinks(html: string, hubUrl: string): string[] {
  const origin = new URL(hubUrl).origin;
  const urls = new Set<string>();
  for (const match of html.matchAll(/["']([^"'\s]*credit-card[^"'\s]*)["']/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(match[1]!, hubUrl);
    } catch {
      continue;
    }
    if (resolved.origin !== origin) continue;
    if (/\.(pdf|jpe?g|png|svg|gif|css|js|woff2?)$/i.test(resolved.pathname)) continue;
    resolved.hash = '';
    resolved.search = '';
    // 有啲頁面砌 link 會出現 //hk//credit-cards//，同正常路徑係同一版。
    resolved.pathname = resolved.pathname.replace(/\/{2,}/g, '/');
    urls.add(resolved.toString());
  }
  return [...urls].sort();
}

export async function discoverCardPages(hubUrl: string, renderMode: RenderMode = 'js'): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return extractCardPageLinks((await fetchSource(hubUrl, renderMode)).content, hubUrl);
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export async function discoverSources(pageUrl: string, renderMode: RenderMode = 'js'): Promise<DiscoveredSource[]> {
  // HSBC 啲產品頁行 JS 行得好慢，Browser Rendering 間唔中會 timeout 或者 429。
  // 呢個係一次性嘅人手工具，重試好過叫人自己再撳一次。
  let page;
  for (let attempt = 1; ; attempt++) {
    try {
      page = await fetchSource(pageUrl, renderMode);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
  const links = extractPdfLinks(page.content, pageUrl);
  const results: DiscoveredSource[] = [];
  for (const link of links) {
    const found = await inspectSource(link); // 逐個嚟，唔好一次過轟死銀行個站
    results.push(found);
    // 抽唔到文字先試另一個語言版本——多數時候另一版有文字層。
    if (found.tooThin) {
      for (const variant of languageVariants(link)) {
        const alt = await inspectSource(variant);
        if (alt.error === null) results.push(alt);
      }
    }
  }
  return results;
}
