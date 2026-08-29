import { describe, expect, it } from 'vitest';
import { buildPRBody } from '../report.ts';

const base = { title: '自動核實', date: '2026-08-29', totalCostUsd: 0 };

describe('buildPRBody', () => {
  it('空段落唔會出——PR 上面唔應該有得個標題冇內容嘅段', () => {
    const body = buildPRBody({
      ...base,
      sections: [
        { heading: '改動', items: ['✓ 冇變'] },
        { heading: '⚠️ 需要人手覆核', items: [] },
      ],
    });

    expect(body).toContain('### 改動');
    expect(body).not.toContain('需要人手覆核');
  });

  it('$0 都要出——「全部 hash 短路」係一個結果，唔係「冇資料」', () => {
    // Phase 2 acceptance 明文要驗「全部 hash 命中時成本 = $0」，
    // 所以呢一行唔可以因為係零就慳咗。
    expect(buildPRBody({ ...base, sections: [] })).toContain('- 總 LLM cost：$0.0000');
  });

  it('成本一律四位小數——$0.0030 唔可以印成 $0.003', () => {
    expect(buildPRBody({ ...base, totalCostUsd: 0.003, sections: [] })).toContain('$0.0030');
  });

  it('intro 擺喺標題同清單中間，冇 intro 就唔出多餘空行', () => {
    const withIntro = buildPRBody({
      ...base,
      sections: [{ heading: '🔎 提議新增官方來源', intro: '第三方快但唔準。', items: ['`a`：https://x.test/t.pdf'] }],
    });
    expect(withIntro).toContain('### 🔎 提議新增官方來源\n第三方快但唔準。\n- `a`：https://x.test/t.pdf');

    const noIntro = buildPRBody({ ...base, sections: [{ heading: '改動', items: ['一行'] }] });
    expect(noIntro).toContain('### 改動\n- 一行');
  });

  it('每項自動加 `- `，段落之間有空行', () => {
    const body = buildPRBody({
      ...base,
      sections: [
        { heading: '改動', items: ['甲', '乙'] },
        { heading: 'Gate 結果', items: ['demo_card：✅ 全過'] },
      ],
    });

    expect(body).toBe(
      [
        '**自動核實 —— 2026-08-29**',
        '',
        '### 改動',
        '- 甲',
        '- 乙',
        '',
        '### Gate 結果',
        '- demo_card：✅ 全過',
        '',
        '### 成本',
        '- 總 LLM cost：$0.0000',
      ].join('\n'),
    );
  });

  it('多行嘅 item 原樣保留——修復 pass 嗰啲「舊：… 新：…」要睇得到', () => {
    const body = buildPRBody({ ...base, sections: [{ heading: '改動', items: ['🔧 修好咗\n    舊：A\n    新：B'] }] });
    expect(body).toContain('- 🔧 修好咗\n    舊：A\n    新：B');
  });
});
