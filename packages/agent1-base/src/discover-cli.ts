import { discoverSources } from './discover.ts';

try {
  process.loadEnvFile();
} catch {
  // 冇 .env 就算（js render mode 要 Cloudflare 憑證）。
}

const [pageUrl, renderMode] = process.argv.slice(2);
if (!pageUrl) {
  console.error('用法：npm run discover -- <卡嘅官網頁面 URL> [html|js]（預設 js）');
  process.exit(1);
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
