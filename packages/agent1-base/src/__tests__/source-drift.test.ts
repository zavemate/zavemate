import { describe, expect, it } from 'vitest';
import { extractLinkedDocs, findSourceDrift, productPageOf } from '../source-drift.ts';
import { card } from './fixtures.ts';

const PAGE = 'https://www.sc.com/hk/zh/credit-cards/simplycash/';
const OLD = 'https://av.sc.com/hk/zh/content/docs/hk-promo-simply-cash-tnc.pdf';
const NEW = 'https://av.sc.com/hk/zh/content/docs/hk-promo-simply-cash-tnc-noc.pdf';

function withSources(urls: Array<{ url: string; purpose: string }>) {
  return card({
    sources: urls.map((s) => ({
      url: s.url,
      purpose: s.purpose,
      note: null,
      last_modified: null,
      etag: null,
      language: null,
      is_authoritative: true,
    })) as never,
  });
}

describe('extractLinkedDocs', () => {
  it('抽到絕對同相對嘅 PDF link', () => {
    const html = `<a href="${NEW}">條款</a><a href="/hk/content/docs/kfs.pdf">KFS</a>`;
    expect(extractLinkedDocs(html, PAGE)).toEqual(new Set([NEW, 'https://www.sc.com/hk/content/docs/kfs.pdf']));
  });

  it('剝走追蹤參數——同一份 PDF 掛住唔同 intcid 唔可以當兩份', () => {
    // 唔剝就會成版報假 drift：我哋存嘅係乾淨 URL，頁面 link 嘅帶住 query。
    const html = `<a href="${NEW}?intcid=web_listing-sc_com_top_nav#tnc">條款</a>`;
    expect(extractLinkedDocs(html, PAGE)).toEqual(new Set([NEW]));
  });

  it('唔收頁面，只收文件', () => {
    const html = `<a href="/hk/zh/credit-cards/cathay/">卡頁</a><a href="${NEW}">PDF</a>`;
    expect(extractLinkedDocs(html, PAGE)).toEqual(new Set([NEW]));
  });

  it('砌唔成 URL 嘅 href 跳過，唔 throw', () => {
    const html = '<a href="javascript:void(0)">x</a><a href="">y</a><a href="mailto:a@b.c">z</a>';
    expect(extractLinkedDocs(html, PAGE).size).toBe(0);
  });
});

describe('findSourceDrift', () => {
  it('引用嘅 PDF 卡頁已經冇 link → 報 drift，同時交埋卡頁而家 link 緊咩', () => {
    // 真實個案：Simply Cash 引用緊 06/2020 嗰份，官方 link 緊 04/2026。
    const drifts = findSourceDrift({
      card: withSources([{ url: OLD, purpose: 'scheme' }, { url: PAGE, purpose: 'product_page' }]),
      productPageUrl: PAGE,
      linkedDocs: new Set([NEW]),
    });

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ citedUrl: OLD, purpose: 'scheme', linkedDocs: [NEW] });
  });

  it('引用嘅 PDF 仲喺卡頁度 → 冇嘢報', () => {
    const drifts = findSourceDrift({
      card: withSources([{ url: NEW, purpose: 'scheme' }, { url: PAGE, purpose: 'product_page' }]),
      productPageUrl: PAGE,
      linkedDocs: new Set([NEW]),
    });
    expect(drifts).toEqual([]);
  });

  it('卡頁本身（唔係 PDF）唔會被當成 drift', () => {
    // product_page 唔係一份會換檔名嘅文件，唔應該拉佢落嚟比。
    const drifts = findSourceDrift({
      card: withSources([{ url: PAGE, purpose: 'product_page' }]),
      productPageUrl: PAGE,
      linkedDocs: new Set([NEW]),
    });
    expect(drifts).toEqual([]);
  });

  it('卡頁一份 PDF 都抽唔到 → 唔好報成張卡 drift', () => {
    // 多數係我哋讀唔到嗰版（SPA、WAF），唔係「所有文件都過時」。
    // 唔守住呢點，一次讀失敗就會為成張卡開一堆假 question。
    const drifts = findSourceDrift({
      card: withSources([{ url: OLD, purpose: 'scheme' }]),
      productPageUrl: PAGE,
      linkedDocs: new Set(),
    });
    expect(drifts).toEqual([]);
  });

  it('多過一份文件過時 → 逐份報', () => {
    const kfs = 'https://av.sc.com/hk/content/docs/old-kfs.pdf';
    const drifts = findSourceDrift({
      card: withSources([
        { url: OLD, purpose: 'scheme' },
        { url: kfs, purpose: 'kfs' },
        { url: PAGE, purpose: 'product_page' },
      ]),
      productPageUrl: PAGE,
      linkedDocs: new Set([NEW]),
    });
    expect(drifts.map((d) => d.purpose).sort()).toEqual(['kfs', 'scheme']);
  });
});

describe('productPageOf', () => {
  it('攞到 product_page 嗰個 source', () => {
    expect(productPageOf(withSources([{ url: OLD, purpose: 'scheme' }, { url: PAGE, purpose: 'product_page' }]))).toBe(PAGE);
  });

  it('冇 product_page → null（跳過呢張卡，唔係當佢全部 drift）', () => {
    expect(productPageOf(withSources([{ url: OLD, purpose: 'scheme' }]))).toBeNull();
  });
});

describe('唔應該檢查嘅 source', () => {
  const EN_DOC = 'https://av.example.test/docs/scheme-en.pdf';

  it('programme_base 唔比 —— 佢係發卡行通用條款，唔會出現喺卡頁', () => {
    // 實測三張滙豐卡冇一張嘅卡頁 link rewards/terms-and-conditions.pdf。
    // 當佢 drift 就係每張卡開一條永遠答唔到嘅假 question。
    const drifts = findSourceDrift({
      card: withSources([{ url: OLD, purpose: 'programme_base' }, { url: PAGE, purpose: 'product_page' }]),
      productPageUrl: PAGE,
      linkedDocs: new Set([NEW]),
    });
    expect(drifts).toEqual([]);
  });

  it('語言對唔上唔比 —— 中文卡頁唔可以用嚟判英文版過唔過時', () => {
    // 滙豐每張卡有中英兩版 scheme（英文法律為準但係圖片型 PDF），
    // 所以呢個唔係邊緣情況。
    const card = withSources([{ url: EN_DOC, purpose: 'scheme' }, { url: PAGE, purpose: 'product_page' }]);
    card.sources[0]!.language = 'en';

    expect(findSourceDrift({ card, productPageUrl: PAGE, linkedDocs: new Set([NEW]), pageLanguage: 'zh' })).toEqual([]);
    // 同語言就照比
    expect(findSourceDrift({ card, productPageUrl: PAGE, linkedDocs: new Set([NEW]), pageLanguage: 'en' })).toHaveLength(1);
  });

  it('任何一邊冇標語言就照比 —— 寧願誤報都好過靜靜哋唔檢查', () => {
    const card = withSources([{ url: OLD, purpose: 'scheme' }, { url: PAGE, purpose: 'product_page' }]);
    expect(findSourceDrift({ card, productPageUrl: PAGE, linkedDocs: new Set([NEW]), pageLanguage: 'zh' })).toHaveLength(1);
  });
});
