import { canonicalStringify, type JsonValue } from '@zavemate/schema';
import type { DataSet } from './load.ts';
import { expandCard, type SnapshotCard } from './expand.ts';

/** 對外 schema 版本。改 breaking 嘢先加 major（§7.7：同一 major 內只加欄位）。 */
export const SCHEMA_VERSION = '1.0.0';

export interface Coverage {
  cards: number;
  rules: number;
  promotions: number;
  /** 幾多條 rule 唔係 official——對外要睇得到我哋幾肯定。 */
  unconfirmed_rules: number;
  /** 幾多條 rule 嘅適用範圍我哋表達唔到（match.scope = 'undetermined'）。 */
  undetermined_rules: number;
}

export interface Snapshot {
  schema_version: string;
  snapshot_version: string;
  generated_at: string;
  as_of: string;
  coverage: Coverage;
  cards: SnapshotCard[];
}

export interface IndexEntry {
  card_id: string;
  card_name: string;
  card_name_zh: string | null;
  issuer: string;
  network: string;
  annual_fee: number;
  /** 純粹由事實砌出嚟，唔係行銷文案。 */
  summary: string;
}

export interface SnapshotIndex {
  schema_version: string;
  snapshot_version: string;
  generated_at: string;
  coverage: Coverage;
  cards: IndexEntry[];
}

function summarize(card: SnapshotCard): string {
  const fee = card.annual_fee === 0 ? '免年費' : `年費 HK$${card.annual_fee}`;
  return [card.issuer, card.network, fee, `${card.rewards.length} 條回贈規則`, `${card.promotions.length} 個限時優惠`].join(
    ' · ',
  );
}

export interface BuildOptions {
  /** commit SHA。§7.2：唔好自己發明版本號。 */
  version: string;
  /** 用邊日做「今日」嚟過濾 effective date。 */
  asOf: string;
  now?: Date;
}

export function buildSnapshot(data: DataSet, options: BuildOptions): Snapshot {
  const cards = data.cards
    .filter((card) => card.active)
    .map((card) => expandCard(card, data.promotions, options.asOf));

  const rules = cards.flatMap((card) => card.rewards);
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_version: options.version,
    generated_at: (options.now ?? new Date()).toISOString(),
    as_of: options.asOf,
    coverage: {
      cards: cards.length,
      rules: rules.length,
      promotions: cards.reduce((n, card) => n + card.promotions.length, 0),
      unconfirmed_rules: rules.filter((rule) => rule.provenance.confidence !== 'official').length,
      undetermined_rules: rules.filter((rule) => rule.match.scope === 'undetermined').length,
    },
    cards,
  };
}

export function buildIndex(snapshot: Snapshot): SnapshotIndex {
  return {
    schema_version: snapshot.schema_version,
    snapshot_version: snapshot.snapshot_version,
    generated_at: snapshot.generated_at,
    coverage: snapshot.coverage,
    cards: snapshot.cards.map((card) => ({
      card_id: card.card_id,
      card_name: card.card_name,
      card_name_zh: card.card_name_zh,
      issuer: card.issuer,
      network: card.network,
      annual_fee: card.annual_fee,
      summary: summarize(card),
    })),
  };
}

/**
 * 一律用 canonical formatting（key 排序、2 空格）。
 *
 * 唔係為咗好睇：同一份資料一定要產生同一啲 bytes，否則 ETag 會無故變、
 * agent 嘅快取會白白失效，而我哋想「攞最新」比「用舊嘅」平。
 */
export function serialize(value: unknown): string {
  return canonicalStringify(value as JsonValue);
}
