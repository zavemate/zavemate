import { describe, expect, it } from 'vitest';
import type { Promotion } from '@zavemate/schema';
import { applyExtractedPromotions, type ApplyPromoInput } from '../apply.ts';
import type { ExtractedPromotion } from '../extraction.ts';

const TODAY = '2026-08-27';
const NOW = '2026-08-27T04:00:00.000Z';

function extracted(overrides: Partial<ExtractedPromotion> = {}): ExtractedPromotion {
  return {
    card_id: 'hsbc_red',
    slug: 'online',
    title: '網上簽賬 4%',
    reward: { type: 'cash_rebate', rate: 0.04, multiplier: null, bonus_amount: null, hkd_per_mile: null },
    cap_value: 10000,
    cap_unit: 'spend',
    match_channel: ['online'],
    match_currency: null,
    match_merchant_include: null,
    scope_not_expressible: false,
    start_date: '2026-07-01',
    end_date: '2026-12-31',
    requires_registration: false,
    ended_early: false,
    reward_includes_base: true,
    looks_like_base_terms: false,
    official_source_url: null,
    confidence: 'official',
    evidence_excerpt: '網上簽賬 4%「獎賞錢」回贈',
    ...overrides,
  };
}

function input(overrides: Partial<ApplyPromoInput> = {}): ApplyPromoInput {
  return {
    extracted: [extracted()],
    existing: new Map<string, Promotion>(),
    existingForPrompt: [],
    sourceUrl: 'https://www.hsbc.com.hk/credit-cards/',
    sourceType: 'official',
    today: TODAY,
    nowIso: NOW,
    ...overrides,
  };
}

describe('全新優惠', () => {
  it('砌到 {card}_{quarter}_{slug}，標 ✨', () => {
    const result = applyExtractedPromotions(input());
    expect([...result.updated.keys()]).toEqual(['hsbc_red_2026q3_online']);
    expect(result.notes[0]).toContain('✨');
    expect(result.updated.get('hsbc_red_2026q3_online')!.active).toBe(true);
  });

  it('連跑兩次唔會產生兩個檔（acceptance）', () => {
    const first = applyExtractedPromotions(input());
    const second = applyExtractedPromotions(input({ existing: first.updated }));
    expect([...second.updated.keys()]).toEqual([...first.updated.keys()]);
    expect(second.notes[0]).toContain('🔄'); // 第二次係更新，唔係新增
  });
});

describe('reward_includes_base 決定計唔計多咗', () => {
  it('含基本回贈 → stackable_with_base: false（唔相加）', () => {
    // HSBC Red 個 8% 就係咁。當佢可疊加就會計成 8.4%，高報。
    const result = applyExtractedPromotions(input({ extracted: [extracted({ reward_includes_base: true })] }));
    expect(result.updated.get('hsbc_red_2026q3_online')!.stacking.stackable_with_base).toBe(false);
  });

  it('明確係額外 → stackable_with_base: true', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ reward_includes_base: false })] }));
    expect(result.updated.get('hsbc_red_2026q3_online')!.stacking.stackable_with_base).toBe(true);
  });

  it('講唔清 → 當唔可疊加（保守）+ 降 confidence + 標出嚟', () => {
    // 高報比低報傷得多：用戶會為咗一個唔存在嘅回贈率去碌卡。
    const result = applyExtractedPromotions(input({ extracted: [extracted({ reward_includes_base: null })] }));
    const promo = result.updated.get('hsbc_red_2026q3_online')!;
    expect(promo.stacking.stackable_with_base).toBe(false);
    expect(promo.provenance.confidence).toBe('unconfirmed');
    expect(result.attentionNeeded.some((n) => n.includes('包唔包基本回贈'))).toBe(true);
  });
});

describe('§6.5 特殊情況', () => {
  it('冇 end_date → confidence 唔可以係 official', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ end_date: null })] }));
    expect(result.updated.get('hsbc_red_2026q3_online')!.provenance.confidence).toBe('unconfirmed');
  });

  it('官方提早結束 → active: false，但個檔仲喺度', () => {
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ ended_early: true, end_date: '2026-09-30' })] }),
    );
    const promo = result.updated.get('hsbc_red_2026q3_online')!;
    expect(promo.active).toBe(false);
    expect(promo.end_date).toBe('2026-09-30');
    // 「新」同「已腰斬」係兩件事，兩樣都要報——淨係講「全新優惠」會令人以為仲行緊。
    expect(result.notes[0]).toContain('⏹');
    expect(result.notes[0]).toContain('✨');
  });

  it('似係長期條款 → 唔寫入，交返人手（§6.5：唔好自己處理）', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ looks_like_base_terms: true })] }));
    expect(result.updated.size).toBe(0);
    expect(result.attentionNeeded[0]).toContain('Agent 1');
  });

  it('對唔上任何一張卡 → 唔寫入', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ card_id: null })] }));
    expect(result.updated.size).toBe(0);
    expect(result.attentionNeeded[0]).toContain('對唔上');
  });

  it('slug 唔係 ASCII → 唔寫入，唔會砌個爛 id', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ slug: '指定商戶' })] }));
    expect(result.updated.size).toBe(0);
  });
});

describe('一出世就死咗嘅優惠', () => {
  it('end_date 過咗緩衝期 → 唔寫入，出 attention note', () => {
    // Feed 拆開之後會見到幾個月舊文——實測 hkcashrebate 個 feed 有一篇
    // 7月6日至7月31日嘅滙豐麥當勞優惠，今日已經 8月27日。
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ end_date: '2026-07-31', title: '滙豐麥當勞額外15%回贈' })] }),
    );
    expect(result.updated.size).toBe(0);
    expect(result.attentionNeeded.join('\n')).toContain('已經過咗');
  });

  it('啱啱先完（仲喺 7 日緩衝期內）→ 照收，同步驟 0 嘅判斷一致', () => {
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ end_date: '2026-08-25' })] }),
    );
    expect(result.updated.size).toBe(1);
  });

  it('end_date null（官方冇講幾時完）→ 照收，冇日期就冇得判過期', () => {
    const result = applyExtractedPromotions(input({ extracted: [extracted({ end_date: null })] }));
    expect(result.updated.size).toBe(1);
  });
});

describe('match.scope', () => {
  it('有準則 → criteria', () => {
    const result = applyExtractedPromotions(input());
    expect(result.updated.get('hsbc_red_2026q3_online')!.match.scope).toBe('criteria');
  });

  it('表達唔到範圍 → undetermined，而且清走準則', () => {
    // 唔可以因為表達唔到就扮咗適用於全部簽賬。
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ scope_not_expressible: true })] }),
    );
    const match = result.updated.get('hsbc_red_2026q3_online')!.match;
    expect(match.scope).toBe('undetermined');
    expect(match.channel).toBeNull();
  });

  it('冇準則又冇講表達唔到 → all', () => {
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ match_channel: null })] }),
    );
    expect(result.updated.get('hsbc_red_2026q3_online')!.match.scope).toBe('all');
  });
});

describe('一次過新增多個優惠', () => {
  it('同一張卡 2 個以上 → 提醒人手諗 stack_group', () => {
    // 同一個推廣嘅唔同類別通常互斥，但一條優惠自己睇唔出佢同邊條互斥。
    const result = applyExtractedPromotions(
      input({ extracted: [extracted({ slug: 'online' }), extracted({ slug: 'designated' })] }),
    );
    expect(result.updated.size).toBe(2);
    expect(result.attentionNeeded.some((n) => n.includes('stack_group'))).toBe(true);
  });

  it('得一個就唔會嘈', () => {
    expect(applyExtractedPromotions(input()).attentionNeeded).toEqual([]);
  });
});
