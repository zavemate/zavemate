/**
 * Canonical JSON formatting（§4.6）。
 *
 * 呢個唔係美化 —— 係令 git diff deterministic。PR 度一眼睇得出改咗咩，
 * 直接決定咗人手審核做唔做得落，所以 CI 要擋住唔合規嘅檔。
 *
 * 規範：UTF-8（無 BOM）、LF、2 空格縮排、物件 key 按字母排序、檔尾一個換行。
 * Array 保持原本次序 —— 次序係有語義嘅（例如 rewards 嘅排列）。
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 用 UTF-16 code unit 比較，唔用 localeCompare —— 排序要同 locale 無關先 deterministic。 */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      out[key] = sortKeysDeep(value[key] as JsonValue);
    }
    return out;
  }
  return value;
}

export function canonicalStringify(value: JsonValue): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export interface CanonicalCheck {
  ok: boolean;
  /** 唔合規時嘅 canonical 版本，可以直接寫返落檔。 */
  canonical: string;
  problems: string[];
}

export function checkCanonical(text: string): CanonicalCheck {
  const problems: string[] = [];

  if (text.startsWith('\uFEFF')) {
    problems.push('檔頭有 BOM，要用無 BOM 嘅 UTF-8');
    text = text.slice(1);
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (error) {
    return {
      ok: false,
      canonical: text,
      problems: [`JSON parse 失敗：${(error as Error).message}`],
    };
  }

  const canonical = canonicalStringify(parsed);
  if (text === canonical) {
    return { ok: problems.length === 0, canonical, problems };
  }

  if (text.includes('\r')) problems.push('用咗 CRLF，要用 LF');
  if (!text.endsWith('\n')) problems.push('檔尾冇換行');
  else if (text.endsWith('\n\n')) problems.push('檔尾多過一個換行');
  if (/[ \t]+\n/.test(text)) problems.push('行尾有多餘空白');
  if (/\n\t/.test(text)) problems.push('用咗 tab 縮排，要用 2 空格');
  if (problems.length === 0) {
    problems.push('key 排序或者縮排唔符合 canonical format');
  }

  return { ok: false, canonical, problems };
}
