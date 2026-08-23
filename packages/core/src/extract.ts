/**
 * 由 HTML 度剝走 nav/footer/廣告/時間戳，剩返「條款實際講嘅嘢」。
 *
 * 目的淨係一個：同一份條款內容，唔理個網頁嗰次幾點抓、廣告輪到邊個，
 * extractMainContent 出嚟嘅字串（同埋 sha256）都要一樣（BUILD_SPEC §6.1 步驟 3–4）。
 * 一樣就代表條款冇變過，agent 可以完全跳過 LLM。
 *
 * 呢度用輕量 regex 剝 tag，冇引入 DOM parser library（跟 CLAUDE.md「唔好裝重型
 * framework」嘅精神）。如果將來banks 嘅頁面結構複雜到 regex 頂唔順，再換成
 * 正式嘅 HTML parser。
 */

// 完全移除嘅 tag（連內容一齊丟）：script/style 唔係內容；nav/header/footer/aside
// 通常係導覽、廣告位、時間戳所在。
const STRIP_TAG_NAMES = ['script', 'style', 'noscript', 'template', 'nav', 'header', 'footer', 'aside'];

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

// 常見時間戳/版權/導覽字眼，成行淨係呢啲就丟——條款嘅實質內容唔會得返呢句嘢。
const NOISE_LINE_PATTERNS: RegExp[] = [
  /^(最後更新|last updated|updated on|更新日期)[：:]/i,
  /^©\s*\d{4}/,
  /^copyright\s*©?\s*\d{4}/i,
  /^all rights reserved\.?$/i,
  /^版權所有/,
  /^\d{4}-\d{2}-\d{2}$/, // 淨係一個日期成行
];

function stripTagsWithContent(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?</${tagName}>`, 'gi');
  return html.replace(pattern, ' ');
}

function decodeEntities(text: string): string {
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.split(entity).join(char);
  }
  // 數字 entity，例如 &#160;
  decoded = decoded.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
  return decoded;
}

export function extractMainContent(html: string): string {
  let content = html.replace(/<!--[\s\S]*?-->/g, ' ');

  for (const tagName of STRIP_TAG_NAMES) {
    content = stripTagsWithContent(content, tagName);
  }

  // 淨返晒 tag 就剝走，得返純文字
  content = content.replace(/<[^>]+>/g, '\n');
  content = decodeEntities(content);

  const lines = content
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)));

  return lines.join('\n');
}

/**
 * 抽取結果薄到唔合理 = 抽取失敗，唔係「份文件冇嘢」。
 *
 * 真實個案：HSBC 嘅 reward-scheme-terms-and-conditions.pdf 有 4 頁，但
 * extractMainContent 只抽到 101 個字元（圖片型 PDF，冇文字層）。pipeline
 * 當時完全冇 flag，會將嗰 101 個字元當「份文件嘅內容」餵俾 LLM。
 *
 * 更惡劣嘅係：呢種失敗係穩定嘅。同一份圖片 PDF 每次抽都係同樣嗰 101 個字元，
 * 所以 hash 對得上、pipeline 判 unchanged、applyWork 就會將 last_verified_at
 * 更新做「而家」——一條從來冇人讀得到嘅 rule，每個星期都顯示啱啱核實過。
 * 呢個正正係 CLAUDE.md 開頭嗰句「唔好靜靜錯」講緊嘅嘢。
 */
export const MIN_EXTRACTED_CHARS = 200;
export const MIN_CHARS_PER_PAGE = 100;

export interface ExtractionAssessment {
  tooThin: boolean;
  chars: number;
  /** pdf-parse 會喺每頁尾加「-- 3 of 7 --」，攞到就用得。HTML 冇呢個概念。 */
  pages: number | null;
  reason: string | null;
}

export function assessExtraction(text: string): ExtractionAssessment {
  const chars = text.length;
  const pageMarkers = [...text.matchAll(/--\s*\d+\s+of\s+(\d+)\s*--/g)].map((m) => Number(m[1]));
  const pages = pageMarkers.length > 0 ? Math.max(...pageMarkers) : null;

  if (chars < MIN_EXTRACTED_CHARS) {
    return { tooThin: true, chars, pages, reason: `全份只抽到 ${chars} 個字元（低過 ${MIN_EXTRACTED_CHARS}）` };
  }
  if (pages !== null && pages > 0 && chars / pages < MIN_CHARS_PER_PAGE) {
    return {
      tooThin: true,
      chars,
      pages,
      reason: `${pages} 頁但只抽到 ${chars} 個字元（平均每頁 ${Math.round(chars / pages)}，低過 ${MIN_CHARS_PER_PAGE}）——大機會係圖片型 PDF，冇文字層`,
    };
  }
  return { tooThin: false, chars, pages, reason: null };
}
