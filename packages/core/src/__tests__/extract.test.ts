import { describe, expect, it } from 'vitest';
import { assessExtraction, evidenceSupportedBy, extractMainContent } from '../extract.ts';
import { sha256 } from '../hash.ts';

// 兩個「同一份條款、唔同時間抓」嘅版本：nav/footer/時間戳/廣告唔同，
// 但實質條款文字（<main> 入面）完全一樣。
const pageVersionA = `
<!DOCTYPE html>
<html>
<head><style>.ad { color: red; }</style></head>
<body>
  <nav><a href="/home">首頁</a><a href="/cards">信用卡</a></nav>
  <header>示範銀行 &amp; 信用卡中心</header>
  <script>trackAd('banner-1');</script>
  <main>
    <h1>示範信用卡</h1>
    <p>網上簽賬回贈 4%，每月上限 HK$10,000。</p>
    <p>最後更新: 2026-08-19</p>
  </main>
  <footer>© 2026 示範銀行 版權所有</footer>
</body>
</html>
`;

const pageVersionB = `
<!DOCTYPE html>
<html>
<head><style>.ad { color: blue; font-size: 14px; }</style></head>
<body>
  <nav><a href="/home">Home</a><a href="/cards">Credit Cards</a><a href="/promo">新優惠</a></nav>
  <header>示範銀行 &amp; 信用卡中心</header>
  <script>trackAd('banner-2-different-campaign');</script>
  <main>
    <h1>示範信用卡</h1>
    <p>網上簽賬回贈 4%，每月上限 HK$10,000。</p>
    <p>最後更新: 2026-08-20</p>
  </main>
  <footer>Copyright © 2026 Demo Bank. All rights reserved.</footer>
</body>
</html>
`;

// 條款實質內容真係變咗嘅版本（回贈率由 4% 變 5%）。
const pageVersionChanged = pageVersionA.replace('回贈 4%', '回贈 5%');

describe('extractMainContent', () => {
  it('nav/header/footer/script/時間戳唔同，但實質條款一樣 → 出嚟嘅內容一樣', () => {
    const a = extractMainContent(pageVersionA);
    const b = extractMainContent(pageVersionB);
    expect(a).toBe(b);
  });

  it('連帶 hash 都一樣，agent 可以完全跳過 LLM', () => {
    expect(sha256(extractMainContent(pageVersionA))).toBe(sha256(extractMainContent(pageVersionB)));
  });

  it('保留咗實質條款文字', () => {
    const content = extractMainContent(pageVersionA);
    expect(content).toContain('網上簽賬回贈 4%，每月上限 HK$10,000。');
    expect(content).toContain('示範信用卡');
  });

  it('剝走咗 nav/header/footer/script 嘅內容', () => {
    const content = extractMainContent(pageVersionA);
    expect(content).not.toContain('首頁');
    expect(content).not.toContain('trackAd');
    expect(content).not.toContain('版權所有');
  });

  it('剝走咗時間戳成行', () => {
    const content = extractMainContent(pageVersionA);
    expect(content).not.toContain('最後更新');
  });

  it('條款實質數值真係變咗 → 內容同 hash 都要唔一樣（唔可以剝到走晒真嘢）', () => {
    const changed = extractMainContent(pageVersionChanged);
    const original = extractMainContent(pageVersionA);
    expect(changed).not.toBe(original);
    expect(sha256(changed)).not.toBe(sha256(original));
  });

  it('解得返常見 HTML entity（喺 header 度嘅唔算，因為 header 本身會剝走）', () => {
    const html = '<main><p>條款 A &amp; 條款 B 都適用，簽賬滿 &quot;HK$500&quot; 先合資格。</p></main>';
    const content = extractMainContent(html);
    expect(content).toContain('條款 A & 條款 B 都適用，簽賬滿 "HK$500" 先合資格。');
  });
});

describe('assessExtraction', () => {
  it('正常條款文件 → 唔算薄', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 條：合資格簽賬指附有正式交易紀錄之簽賬。`).join('\n');
    expect(assessExtraction(text).tooThin).toBe(false);
  });

  it('全份得幾十個字元 → 當抽取失敗', () => {
    const result = assessExtraction('PUBLIC -- 1 of 1 --');
    expect(result.tooThin).toBe(true);
    expect(result.reason).toContain('字元');
  });

  it('多頁但每頁平均字數低到不合理 → 當抽取失敗（圖片型 PDF）', () => {
    // HSBC reward-scheme-terms-and-conditions.pdf 嘅真實形態：4 頁得 101 字元。
    const text = 'PUBLIC iii) iv) ii) iii) -- 1 of 4 -- PUBLIC • • -- 2 of 4 -- PUBLIC -- 3 of 4 -- PUBLIC -- 4 of 4 --'.padEnd(
      250,
      ' x',
    );
    const result = assessExtraction(text);
    expect(result.tooThin).toBe(true);
    expect(result.pages).toBe(4);
    expect(result.reason).toContain('圖片型');
  });

  it('頁數少但內容足夠 → 唔算薄', () => {
    const text = 'x'.repeat(3000) + ' -- 1 of 2 --';
    expect(assessExtraction(text).tooThin).toBe(false);
  });
});

describe('evidenceSupportedBy', () => {
  const source = '持卡人憑本卡於指定商戶簽賬可享\n8% 「獎賞錢」回贈，每月上限港幣 100 元。';

  it('原文節錄搵得返 → true', () => {
    expect(evidenceSupportedBy(source, '於指定商戶簽賬可享 8%「獎賞錢」回贈')).toBe(true);
  });

  it('PDF 抽文字插咗斷行都要當搵到（比對前剝晒空白）', () => {
    expect(evidenceSupportedBy('港幣 2 元簽賬 = 1 飛行里\n數', '港幣 2 元簽賬 = 1 飛行里數')).toBe(true);
  });

  it('全形半形括號當同一個字', () => {
    expect(evidenceSupportedBy('享 8%（獎賞錢）回贈之簽賬', '享 8%(獎賞錢)回贈之簽賬')).toBe(true);
  });

  it('自己寫嘅說明而唔係原文 → false', () => {
    // hsbc_everymile_general 嘅真實 evidence 就係咁：一段推算說明，唔係引句。
    expect(evidenceSupportedBy(source, '推算：base rate 0.4% × 20 里換算率，即 HK$12.5 = 1 里')).toBe(false);
  });

  it('冇 evidence → false', () => {
    expect(evidenceSupportedBy(source, null)).toBe(false);
  });

  it('太短嘅片段唔算證據（隨便都撞到）', () => {
    expect(evidenceSupportedBy(source, '8%')).toBe(false);
  });
});
