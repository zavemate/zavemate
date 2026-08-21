import { describe, expect, it } from 'vitest';
import { sha256 } from '../hash.ts';

describe('sha256', () => {
  it('同一段內容永遠攞返同一個 hash', () => {
    expect(sha256('網上簽賬回贈 4%')).toBe(sha256('網上簽賬回贈 4%'));
  });

  it('內容唔同，hash 就唔同', () => {
    expect(sha256('網上簽賬回贈 4%')).not.toBe(sha256('網上簽賬回贈 5%'));
  });

  it('回傳 64 個字嘅 hex 字串', () => {
    const hash = sha256('demo');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
