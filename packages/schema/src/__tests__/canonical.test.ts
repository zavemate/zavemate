import { describe, expect, it } from 'vitest';
import { canonicalStringify, checkCanonical, sortKeysDeep } from '../canonical.ts';

describe('canonical formatting（§4.6）', () => {
  it('遞迴排序 object key', () => {
    expect(sortKeysDeep({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
    expect(Object.keys(sortKeysDeep({ b: 1, a: 2 }) as object)).toEqual(['a', 'b']);
  });

  it('保留 array 次序 —— 次序係有語義嘅', () => {
    expect(sortKeysDeep(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('2 空格縮排 + 檔尾一個換行', () => {
    const text = canonicalStringify({ b: 1, a: [{ y: 2, x: 1 }] });
    expect(text).toBe('{\n  "a": [\n    {\n      "x": 1,\n      "y": 2\n    }\n  ],\n  "b": 1\n}\n');
  });

  it('canonical 嘅檔會過', () => {
    const text = canonicalStringify({ a: 1, b: 2 });
    expect(checkCanonical(text).ok).toBe(true);
  });

  it('key 未排序會唔過', () => {
    const result = checkCanonical('{\n  "b": 2,\n  "a": 1\n}\n');
    expect(result.ok).toBe(false);
    expect(result.canonical).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('CRLF、缺換行、tab 縮排都會唔過', () => {
    expect(checkCanonical('{\r\n  "a": 1\r\n}\r\n').problems).toContain('用咗 CRLF，要用 LF');
    expect(checkCanonical('{\n  "a": 1\n}').problems).toContain('檔尾冇換行');
    expect(checkCanonical('{\n\t"a": 1\n}\n').problems).toContain('用咗 tab 縮排，要用 2 空格');
  });

  it('parse 唔到就報 parse 錯誤，唔會扮 canonical', () => {
    const result = checkCanonical('{ not json }');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/JSON parse 失敗/);
  });
});
