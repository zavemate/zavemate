import { describe, expect, it } from 'vitest';
import { loadData } from '../load.ts';
import { buildIndex, buildSnapshot } from '../snapshot.ts';

const NOW = new Date('2026-08-24T00:00:00.000Z');
const opts = (asOf: string) => ({ version: 'abc1234', asOf, now: NOW });

describe('buildSnapshot（用真實 data/）', () => {
  const data = loadData();

  it('版本號用傳入嘅 commit sha，唔自己發明', () => {
    expect(buildSnapshot(data, opts('2026-08-24')).snapshot_version).toBe('abc1234');
  });

  it('coverage 數埋「唔肯定」同「範圍表達唔到」，唔止數總數', () => {
    // 對外要睇得到我哋幾肯定，唔可以淨係報一個總數扮晒齊全。
    const { coverage } = buildSnapshot(data, opts('2026-08-24'));
    expect(coverage.cards).toBeGreaterThan(0);
    expect(coverage.rules).toBeGreaterThanOrEqual(coverage.undetermined_rules);
    expect(coverage.undetermined_rules).toBeGreaterThan(0); // hsbc_everymile_other_designated
  });

  it('EveryMile 三條 rule 齊，包括 scope = undetermined 嗰條（唔會被篩走）', () => {
    const card = buildSnapshot(data, opts('2026-08-24')).cards.find((c) => c.card_id === 'hsbc_everymile')!;
    expect(card.rewards.map((r) => r.rule_id).sort()).toEqual([
      'hsbc_everymile_designated',
      'hsbc_everymile_local_overseas',
      'hsbc_everymile_other_designated',
    ]);
    expect(card.rewards.some((r) => r.match.scope === 'undetermined')).toBe(true);
  });

  it('推廣期未開始 → 嗰啲 rule 唔會出現喺 snapshot', () => {
    // EveryMile 三條 rule 嘅 effective_from 係 2026-07-01。
    const card = buildSnapshot(data, opts('2026-06-30')).cards.find((c) => c.card_id === 'hsbc_everymile')!;
    expect(card.rewards).toHaveLength(0);
  });

  it('推廣期完咗 → 一樣會篩走', () => {
    const card = buildSnapshot(data, opts('2027-01-01')).cards.find((c) => c.card_id === 'hsbc_everymile')!;
    expect(card.rewards).toHaveLength(0);
  });

  it('promotion 貼返落自己張卡，過期嘅唔會貼', () => {
    const inPeriod = buildSnapshot(data, opts('2026-08-24')).cards.find((c) => c.card_id === 'hsbc_red')!;
    expect(inPeriod.promotions.length).toBeGreaterThan(0);
    expect(inPeriod.promotions.every((p) => p.card_id === 'hsbc_red')).toBe(true);

    const afterPeriod = buildSnapshot(data, opts('2027-06-01')).cards.find((c) => c.card_id === 'hsbc_red')!;
    expect(afterPeriod.promotions).toHaveLength(0);
  });

  it('每條 rule 都帶住 provenance——唔可以剝走', () => {
    const snapshot = buildSnapshot(data, opts('2026-08-24'));
    for (const card of snapshot.cards) {
      for (const rule of card.rewards) {
        expect(rule.provenance.source_url).toMatch(/^https?:\/\//);
        expect(rule.provenance).toHaveProperty('confidence');
        expect(rule.provenance).toHaveProperty('last_verified_at');
      }
    }
  });

  it('同一份資料 build 兩次 → 完全一樣（generated_at 固定嗰陣）', () => {
    // ETag 唔可以無故變，否則 agent 嘅快取會白白失效。
    const a = JSON.stringify(buildSnapshot(data, opts('2026-08-24')));
    const b = JSON.stringify(buildSnapshot(data, opts('2026-08-24')));
    expect(a).toBe(b);
  });
});

describe('buildIndex', () => {
  const snapshot = buildSnapshot(loadData(), opts('2026-08-24'));

  it('每張卡一個 entry，summary 純粹由事實砌', () => {
    const index = buildIndex(snapshot);
    expect(index.cards).toHaveLength(snapshot.coverage.cards);
    const entry = index.cards.find((c) => c.card_id === 'hsbc_everymile')!;
    expect(entry.summary).toContain('HSBC');
    expect(entry.summary).toContain('3 條回贈規則');
  });

  it('index 唔會帶 rewards / promotions 詳情（要輕量）', () => {
    const entry = buildIndex(snapshot).cards[0]!;
    expect(entry).not.toHaveProperty('rewards');
    expect(entry).not.toHaveProperty('promotions');
  });
});
