import { z } from 'zod';
import { Id } from './common.ts';

/**
 * ⚠️ 暫定 schema。Agent 2 係 Phase 4 先做，實際欄位要等嗰陣先定死。
 * 而家有呢個定義純粹係為咗 data/sources.json 唔會係一個冇人驗證嘅檔。
 */
export const RenderMode = z.enum(['html', 'js', 'pdf']);
export type RenderMode = z.infer<typeof RenderMode>;

export const SourceType = z.enum(['official', 'third_party']);
export type SourceType = z.infer<typeof SourceType>;

export const Source = z.strictObject({
  source_id: Id,
  label: z.string().min(1),
  url: z.string().url(),
  render_mode: RenderMode,
  source_type: SourceType,
  /** null = 呢個來源唔綁定單一張卡（例如發卡機構嘅優惠總覽頁）。 */
  card_id: Id.nullable(),
  active: z.boolean().default(true),
});
export type Source = z.infer<typeof Source>;

export const Sources = z.strictObject({
  note: z.string(),
  sources: z.array(Source),
});
export type Sources = z.infer<typeof Sources>;
