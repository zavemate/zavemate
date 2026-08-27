import { describe, expect, it } from 'vitest';
import { feedItemContent, MAX_FEED_ITEMS_PER_RUN, parseFeedItems, selectFeedWork } from '../feed.ts';

/**
 * 一篇夠厚嘅假文章。
 *
 * 特登寫到明顯超過 `MIN_EXTRACTED_CHARS`（200）：第一版啱啱好 199 個字元，
 * 於是所有 test 都撞咗 thin guard 而唔係測緊佢想測嗰樣嘢。
 */
function body(marker: string): string {
  return `<p>推廣期由2026年8月6日至2026年9月30日，一經登記，憑指定信用卡簽賬滿HK$1,000 可享額外回贈。${marker}</p><p>每位合資格客戶於整個推廣期之額外獎賞上限為HK$500。額外獎賞將於2026年11月30日或之前存入信用卡賬戶。條款及細則適用，詳情請參閱銀行官方網站公布嘅完整條款。</p><p>推廣期內，合資格簽賬須以港幣結算；外幣簽賬按入賬當日匯率換算。分期付款、現金透支、繳交稅款、保費及賭場相關交易均不屬合資格簽賬。銀行保留隨時修訂本推廣之條款及細則之權利。</p>`;
}

function feed(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>限時優惠</title>
<lastBuildDate>Thu, 27 Aug 2026 05:57:56 +0000</lastBuildDate>
${items.join('\n')}
</channel></rss>`;
}

function item(opts: { guid?: string | null; link?: string; title?: string; content?: string; description?: string }): string {
  const parts = [
    opts.guid === null ? '' : `<guid isPermaLink="false">${opts.guid ?? 'https://x.test/?p=1'}</guid>`,
    opts.link === undefined ? '<link>https://x.test/post-1</link>' : `<link>${opts.link}</link>`,
    `<title>${opts.title ?? '恒生信用卡IKEA優惠'}</title>`,
    '<pubDate>Wed, 05 Aug 2026 16:00:36 +0000</pubDate>',
    opts.description === undefined ? '' : `<description><![CDATA[${opts.description}]]></description>`,
    opts.content === undefined ? `<content:encoded><![CDATA[${body('A')}]]></content:encoded>` : opts.content === '' ? '' : `<content:encoded><![CDATA[${opts.content}]]></content:encoded>`,
  ];
  return `<item>${parts.filter(Boolean).join('')}</item>`;
}

describe('parseFeedItems', () => {
  it('拆到 item，CDATA 剝走', () => {
    const items = parseFeedItems(feed([item({}), item({ guid: 'https://x.test/?p=2' })]));
    expect(items).toHaveLength(2);
    expect(items[0]!.guid).toBe('https://x.test/?p=1');
    expect(items[0]!.title).toBe('恒生信用卡IKEA優惠');
    expect(items[0]!.contentHtml.startsWith('<![CDATA[')).toBe(false);
    expect(items[0]!.contentHtml).toContain('推廣期由2026年8月6日');
  });

  it('冇 guid 就退返用 link', () => {
    const items = parseFeedItems(feed([item({ guid: null, link: 'https://x.test/only-link' })]));
    expect(items[0]!.guid).toBe('https://x.test/only-link');
  });

  it('content:encoded 行先，冇先至用 description', () => {
    const withBoth = parseFeedItems(feed([item({ description: '得摘要', content: body('全文') })]));
    expect(withBoth[0]!.contentHtml).toContain('全文');

    const summaryOnly = parseFeedItems(feed([item({ content: '', description: body('摘要') })]));
    expect(summaryOnly[0]!.contentHtml).toContain('摘要');
  });

  it('冇 guid 又冇 link 嗰篇跳過——認唔到係邊篇就短路唔到', () => {
    const items = parseFeedItems(feed([item({ guid: null, link: '' }), item({ guid: 'https://x.test/?p=9' })]));
    expect(items.map((i) => i.guid)).toEqual(['https://x.test/?p=9']);
  });

  it('唔係 feed（拆唔出 item）就交空陣列，唔 throw', () => {
    expect(parseFeedItems('<html><body>404 Not Found</body></html>')).toEqual([]);
  });
});

describe('feedItemContent', () => {
  it('標題／日期／連結做 header 一齊餵——正文成日淨係寫「7月6日」冇年份', () => {
    const [parsed] = parseFeedItems(feed([item({})]));
    const text = feedItemContent(parsed!);
    expect(text).toContain('恒生信用卡IKEA優惠');
    expect(text).toContain('Wed, 05 Aug 2026');
    expect(text).toContain('https://x.test/post-1');
    expect(text).toContain('推廣期由2026年8月6日');
    expect(text).not.toContain('<p>');
  });
});

describe('selectFeedWork', () => {
  const items = parseFeedItems(
    feed([
      item({ guid: 'g1', title: '第一篇', content: body('one') }),
      item({ guid: 'g2', title: '第二篇', content: body('two') }),
      item({ guid: 'g3', title: '第三篇', content: body('three') }),
    ]),
  );

  it('第一次跑（known 空）→ 逐篇睇曬', () => {
    const work = selectFeedWork(items, {});
    expect(work.toProcess.map((w) => w.item.guid)).toEqual(['g1', 'g2', 'g3']);
    expect(work.carried).toEqual({});
    expect(work.notes[0]).toContain('3 篇要重新讀');
  });

  it('第二次跑 → 舊 post 一篇都唔再讀', () => {
    const first = selectFeedWork(items, {});
    const known = Object.fromEntries(first.toProcess.map((w) => [w.item.guid, w.hash]));

    const second = selectFeedWork(items, known);
    expect(second.toProcess).toEqual([]);
    expect(second.carried).toEqual(known);
    expect(second.notes[0]).toContain('3 篇 hash 命中冇改過');
  });

  it('只讀新出嗰篇', () => {
    const first = selectFeedWork(items, {});
    const known = Object.fromEntries(first.toProcess.map((w) => [w.item.guid, w.hash]));

    const withNew = parseFeedItems(
      feed([
        item({ guid: 'g0', title: '啱啱出', content: body('brand new') }),
        item({ guid: 'g1', title: '第一篇', content: body('one') }),
        item({ guid: 'g2', title: '第二篇', content: body('two') }),
        item({ guid: 'g3', title: '第三篇', content: body('three') }),
      ]),
    );

    const work = selectFeedWork(withNew, known);
    expect(work.toProcess.map((w) => w.item.guid)).toEqual(['g0']);
    expect(Object.keys(work.carried).sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('舊 post 改咗內容 → 重新讀（銀行改咗上限、延咗期）', () => {
    const first = selectFeedWork(items, {});
    const known = Object.fromEntries(first.toProcess.map((w) => [w.item.guid, w.hash]));

    const edited = parseFeedItems(
      feed([
        item({ guid: 'g1', title: '第一篇', content: body('one') }),
        item({ guid: 'g2', title: '第二篇（延期咗）', content: body('two 上限改咗做 HK$800') }),
        item({ guid: 'g3', title: '第三篇', content: body('three') }),
      ]),
    );

    const work = selectFeedWork(edited, known);
    expect(work.toProcess.map((w) => w.item.guid)).toEqual(['g2']);
  });

  it('跌咗出 feed 嘅舊 guid 唔會留喺新 map——所以個 map 唔會無限膨脹', () => {
    const known = { g1: 'x'.repeat(64), 已經跌出feed: 'y'.repeat(64) };
    const work = selectFeedWork(items, known);
    expect(Object.keys(work.carried)).not.toContain('已經跌出feed');
  });

  it('抽取太薄嗰篇唔會寫 hash——寫咗就等於話睇過，之後永遠唔會再試', () => {
    const thin = parseFeedItems(feed([item({ guid: 'thin', title: '得幾隻字', content: '<p>睇官網</p>' })]));
    const work = selectFeedWork(thin, {});
    expect(work.toProcess).toEqual([]);
    expect(work.carried).toEqual({});
    expect(work.notes.join('\n')).toContain('下次再試');
  });

  it('超過上限嗰啲順延，唔會寫 hash，下次接住跑', () => {
    const many = parseFeedItems(
      feed(Array.from({ length: 5 }, (_, i) => item({ guid: `m${i}`, title: `文${i}`, content: body(`m${i}`) }))),
    );
    const work = selectFeedWork(many, {}, 2);
    expect(work.toProcess.map((w) => w.item.guid)).toEqual(['m0', 'm1']);
    expect(work.carried).toEqual({});
    expect(work.notes.join('\n')).toContain('下次接住跑');

    // 落一個週期：頭兩篇入咗 known，剩返嘅接住跑。
    const known = Object.fromEntries(work.toProcess.map((w) => [w.item.guid, w.hash]));
    const next = selectFeedWork(many, known, 2);
    expect(next.toProcess.map((w) => w.item.guid)).toEqual(['m2', 'm3']);
  });

  it('預設上限係 MAX_FEED_ITEMS_PER_RUN', () => {
    expect(MAX_FEED_ITEMS_PER_RUN).toBe(40);
    const many = parseFeedItems(
      feed(Array.from({ length: 41 }, (_, i) => item({ guid: `n${i}`, title: `文${i}`, content: body(`n${i}`) }))),
    );
    expect(selectFeedWork(many, {}).toProcess).toHaveLength(40);
  });
});
