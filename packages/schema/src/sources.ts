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
  /**
   * 呢條 URL 係一個 feed，要拆成一篇篇文章分開抽，唔係當一版嘢餵落 LLM。
   *
   * 點解要一個明確欄位而唔係嗅返個 content-type：`render_mode` 講嘅係「點攞」
   * （html / pdf / 行 JS），呢個講嘅係「攞返嚟之後點理解」。兩件事撈埋，將來
   * 一個 render_mode: 'js' 嘅 feed 就冇位表達。
   */
  feed_format: z.enum(['rss']).nullable().default(null),
  /**
   * Feed 專用：每篇文章嘅 guid → 佢自己嗰段內容嘅 hash。
   *
   * 點解唔靠 `content_hash` 一個就算：feed 成日為咗無關嘅嘢改（`lastBuildDate`、
   * 留言數、utm 參數），成個 feed 嘅 hash 一郁就要重新餵成 12 篇文——實測
   * 22,000 字元一次過餵，模型直頭抽唔到嘢（16,664 tokens in / 8 out，交空陣列）。
   * 逐篇 hash 之後，穩定狀態每次只餵新出嗰一兩篇。
   *
   * ⚠️ 呢個唔係歷史記錄（CLAUDE.md 禁嘅嗰種）。每次跑完會**剪返到 feed 而家
   * 仲有嗰批 guid**，所以佢永遠只反映現況，大細跟住 feed 走，唔會無限膨脹。
   * 舊文跌出 feed 之後再返嚟會當新文重抽一次——可以接受。
   *
   * 空 map = 由零開始，第一次跑會**成個 feed 逐篇睇曬**。
   */
  item_hashes: z.record(z.string(), z.string().length(64)).default({}),
  /**
   * Feed 專用：一次最多揭幾多頁。
   *
   * WordPress feed 支援 `?paged=N`，每頁十幾篇。hkcashrebate 個「限時優惠」
   * category 有 321 篇、揭到 27 頁，一頁大約一個月——即係淨係讀第一頁嘅話，
   * 一個仲 running 但出咗街一個月以上嘅優惠我哋由頭到尾唔會見過。實測 page 2
   * 第一篇就係「滙豐HSBC最紅內地簽賬優惠」，正正係我哋覆蓋緊嗰批卡。
   *
   * 揭幾深係成本同噪音嘅取捨：一頁一個月，而推廣期超過半年嘅通常已經係張卡
   * 嘅長期結構而唔係限時優惠。所以 4 頁（約半年）就夠接住所有仲生效嘅優惠，
   * 再深就淨係抽返一堆過咗期、跟住被 apply 擋走嘅嘢。
   *
   * 呢個只係上限。實際會揭到某一頁「全部 item 都已經睇過」為止——所以穩定
   * 狀態通常揭兩頁就停。
   */
  feed_max_pages: z.number().int().positive().default(4),
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
