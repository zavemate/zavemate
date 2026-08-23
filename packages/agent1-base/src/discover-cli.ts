import { discoverCardPages, discoverSources } from './discover.ts';

try {
  process.loadEnvFile();
} catch {
  // 冇 .env 就算（js render mode 要 Cloudflare 憑證）。
}

const args = process.argv.slice(2);
const cardsMode = args[0] === '--cards';
const [pageUrl, renderMode] = cardsMode ? args.slice(1) : args;
if (!pageUrl) {
  console.error('用法：');
  console.error('  npm run discover -- <卡嘅官網頁面 URL> [html|js]        逐份 PDF 量度');
  console.error('  npm run discover -- --cards <銀行 hub 頁 URL> [html|js]  列出成間銀行嘅卡頁面');
  process.exit(1);
}

if (cardsMode) {
  const pages = await discoverCardPages(pageUrl, (renderMode as 'html' | 'js') ?? 'js');
  console.log(`\n${pageUrl}\n${pages.length} 條卡相關頁面：\n`);
  pages.forEach((p) => console.log('  ' + p));
  console.log('');
  process.exit(0);
}

const results = await discoverSources(pageUrl, (renderMode as 'html' | 'js') ?? 'js');
console.log(`\n${pageUrl}\n搵到 ${results.length} 份 PDF\n`);
for (const r of results) {
  const flag = r.error ? '⛔' : r.tooThin ? '⚠️ ' : '  ';
  console.log(`${flag} ${r.url}`);
  if (r.error) {
    console.log(`      ${r.error}`);
    continue;
  }
  const size = r.contentLength === null ? '?' : `${Math.round(r.contentLength / 1024)}KB`;
  console.log(`      ${size}  ${r.chars} 字元${r.pages ? ` / ${r.pages} 頁` : ''}${r.tooThin ? '  ← 抽取太薄，多數係圖片型 PDF' : ''}`);
  console.log(`      Last-Modified: ${r.lastModified ?? '(冇)'}${r.etag ? `  ETag: ${r.etag}` : ''}`);
}
console.log('\npurpose 要人手打——分 scheme / programme_base / merchant_list 要讀完份文件先講得準。\n');
