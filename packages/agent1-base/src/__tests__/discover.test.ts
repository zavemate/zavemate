import { describe, expect, it } from 'vitest';
import { extractPdfLinks } from '../discover.ts';

const PAGE = 'https://www.hsbc.com.hk/credit-cards/products/red/';

describe('extractPdfLinks', () => {
  it('相對路徑要解返做絕對 URL', () => {
    const html = '<a href="/content/dam/hsbc/hk/docs/credit-cards/key-fact-statement.pdf">KFS</a>';
    expect(extractPdfLinks(html, PAGE)).toEqual([
      'https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/key-fact-statement.pdf',
    ]);
  });

  it('絕對 URL 照收，重複嘅去掉', () => {
    const html = `<a href="https://x.com/a.pdf">a</a><a href='https://x.com/a.pdf'>a again</a>`;
    expect(extractPdfLinks(html, PAGE)).toEqual(['https://x.com/a.pdf']);
  });

  it('帶 query / fragment 嘅都收得', () => {
    const html = '<a href="/docs/tnc.pdf?v=2">T&C</a>';
    expect(extractPdfLinks(html, PAGE)).toEqual(['https://www.hsbc.com.hk/docs/tnc.pdf']);
  });

  it('唔係 .pdf 嘅唔收', () => {
    const html = '<img src="/img/card.jpg"><a href="/help">help</a>';
    expect(extractPdfLinks(html, PAGE)).toEqual([]);
  });

  it('砌唔到 URL 嘅 link 唔會拉冧成個 discovery', () => {
    const html = '<a href="ht!tp://bad url/x.pdf">bad</a><a href="/good.pdf">good</a>';
    expect(extractPdfLinks(html, PAGE)).toContain('https://www.hsbc.com.hk/good.pdf');
  });
});
