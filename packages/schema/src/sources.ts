import { z } from 'zod';
import { Id } from './common.ts';

/**
 * Agent 2 嘅監察來源清單。
 *
 * 同 Card.sources[] 唔同：嗰邊係「呢張卡嘅條款喺邊幾份文件」（Agent 1 監察），
 * 呢邊係「去邊度搵未知嘅新優惠」（Agent 2 發現）。同一條 URL 可以兩邊都有，
 * 因為佢哋問緊唔同問題。
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
  /**
   * 第三方來源抽到嘅優惠一律 confidence: 'crowdsourced'（§6.5）。
   * 呢個唔係品質評分，係出處性質——第三方講嘅嘢我哋核實唔到。
   */
  source_type: SourceType,
  /**
   * 呢個來源可能涉及邊幾張卡。空 array = 唔限（例如發卡機構嘅優惠總覽頁）。
   *
   * 原本係單數 card_id，但實際上一版「HSBC 信用卡優惠」會同時講幾張卡，
   * 而我哋要餵一個卡清單俾 LLM 去對應 card_id。
   */
  card_ids: z.array(Id).default([]),
  /**
   * 上次抽取到嘅內容 hash。內容冇變就跳過 LLM（§6.1 步驟 4）。
   *
   * 存喺 source 而唔係 promotion 度：一版優惠頁對應零個到十幾個 promotion，
   * hash 講嘅係「呢版嘢有冇變」，唔係「某個優惠有冇變」。
   */
  content_hash: z.string().length(64).nullable().default(null),
  last_checked_at: z.string().datetime().nullable().default(null),
  /** 連續 fetch 失敗次數，連續 3 次就標 broken-source（§6.2）。 */
  check_fail_count: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
});
export type Source = z.infer<typeof Source>;

export const Sources = z.strictObject({
  note: z.string(),
  sources: z.array(Source),
});
export type Sources = z.infer<typeof Sources>;
