import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendChangeEvents, type ChangeEvent, parsePrNumber, rebuildAllChangeEvents } from '../changes.ts';

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    change_id: 'abc1234:demo_card:demo_rule:reward',
    commit: 'abc1234',
    detected_at: '2026-08-24T00:00:00.000Z',
    card_id: 'demo_card',
    rule_id: 'demo_rule',
    type: 'rate_changed',
    field: 'reward',
    old: 0.04,
    new: 0.038,
    pct_change: -0.05,
    effective_from: null,
    confidence: 'official',
    source_url: 'https://example.com/',
    evidence_excerpt: '網上簽賬回贈 3.8%',
    pr: 42,
    ...overrides,
  };
}

describe('parsePrNumber', () => {
  it('squash merge 嘅 "(#123)" 尾綴攞得返', () => {
    expect(parsePrNumber('data: 更新回贈率 (#123)')).toBe(123);
  });

  it('冇尾綴 → null（唔好靠估）', () => {
    expect(parsePrNumber('data: 更新回贈率')).toBeNull();
  });

  it('中間出現 #123 唔算（一定要喺結尾）', () => {
    expect(parsePrNumber('fix #123 之後再改')).toBeNull();
  });
});

describe('appendChangeEvents', () => {
  it('按年份分檔', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zave-changes-'));
    appendChangeEvents(
      [
        event({ change_id: 'a', detected_at: '2026-01-01T00:00:00.000Z' }),
        event({ change_id: 'b', detected_at: '2027-01-01T00:00:00.000Z' }),
      ],
      dir,
    );
    expect(readFileSync(join(dir, '2026.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(dir, '2027.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('同一個 change_id 重跑唔會重複寫（build 可以安全重跑）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zave-changes-'));
    appendChangeEvents([event()], dir);
    const written = appendChangeEvents([event()], dir);
    expect(written.get('2026')).toBe(0);
    expect(readFileSync(join(dir, '2026.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('每行都係獨立 JSON（JSONL，唔係一個大 array）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zave-changes-'));
    appendChangeEvents([event({ change_id: 'x' }), event({ change_id: 'y' })], dir);
    const lines = readFileSync(join(dir, '2026.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('rebuildAllChangeEvents（行真 git history）', () => {
  const events = rebuildAllChangeEvents();

  it('由 commit 1 重建到成條 stream', () => {
    // 呢啲 test 需要完整 git history。CI 嘅 actions/checkout 預設 fetch-depth: 1
    // （shallow），咁樣會咩都搵唔到而靜靜哋通過——所以 validate.yml 設咗
    // fetch-depth: 0。如果呢度 fail，先睇下係咪 shallow clone。
    expect(events.length, '冇 event——係咪 shallow clone？需要 fetch-depth: 0').toBeGreaterThan(0);
  });

  it('每個 event 都帶住 provenance——change stream 都係 API response', () => {
    // §9：唔可以由 API response 剝走 provenance。「HSBC 減咗 cap」冇出處同傳聞冇分別。
    for (const e of events) {
      expect(e).toHaveProperty('source_url');
      expect(e).toHaveProperty('confidence');
      expect(e.change_id).toContain(e.commit);
    }
  });

  it('捉到 hsbc_everymile_general 被刪走', () => {
    // 真實個案：嗰條 rule 記住 HK$12.5 但 label 寫「一般簽賬」，改正嗰陣刪咗。
    expect(events.some((e) => e.type === 'rule_removed' && e.rule_id === 'hsbc_everymile_general')).toBe(true);
  });

  it('捉到 confidence 由 official 跌做 unconfirmed', () => {
    expect(
      events.some((e) => e.type === 'confidence_changed' && e.old === 'official' && e.new === 'unconfirmed'),
    ).toBe(true);
  });

  it('change_id 唔會重複（重跑 build 唔會出重複行）', () => {
    expect(new Set(events.map((e) => e.change_id)).size).toBe(events.length);
  });
});
