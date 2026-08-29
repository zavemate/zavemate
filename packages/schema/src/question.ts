import { z } from 'zod';
import { Id } from './common.ts';

/**
 * 未解問題——一件我哋知道自己唔知、而且知道要問乜嘅事。
 *
 * 點解要有呢個檔：
 *
 * 1. 人答過嘅嘢要存返 repo。一個判斷如果淨係活喺對話或者某個介面入面，
 *    下個週期冇任何嘢知道佢問過——人手工作永遠唔會收斂，同一條問題會被問到爛。
 *
 * 2. confidence: 'unconfirmed' 本來撈埋咗四件唔同嘅事：從來未 check 過、
 *    原文讀唔到、evidence 撐唔住、有一條具體嘅語義問題。四種跟進方法完全唔同，
 *    共用一個標籤就等於冇一種會被解決。Question 將第四種拆咗出嚟——因為佢係
 *    唯一一種「有一條可以答嘅問題」。
 *
 * 3. 對外要睇得到。有 open question 嘅 rule 唔可以標 official（見 Card
 *    嘅檢查）——即係我哋唔知嘅嘢，API 上面睇得出。
 *
 * 答完唔刪檔：git history 係產品資產，而且同一條問題將來復發嗰陣，睇返上次
 * 點答係最有用嘅嘢。
 */
export const QuestionKind = z.enum([
  /** 原文講嘅嘢同我哋記錄嘅數值唔一致。 */
  'value_conflict',
  /** 原文有講，但我哋條 rule 表達唔到（例如官方分 tier，我哋得一個數）。 */
  'expressiveness',
  /** 原文讀唔到（圖片型 PDF、fetch 一路失敗）。 */
  'source_unreadable',
  /** 搵唔到任何撐得住呢個數值嘅原文。 */
  'evidence_absent',
  /**
   * 我哋引用緊嘅文件，發卡行自己已經唔再 link。
   *
   * 2026-08-29 撞到：`sc_simply_cash_visa` 引用緊一份 **2020 年 6 月**嘅
   * T&C，而渣打自己個卡頁 link 緊 2026 年 4 月嗰份（檔名多咗 `-noc`）。
   * 三張 Cathay 卡亦都共用咗 `t0`，但官方同時 link `t1`／`t2`，各自對應
   * Priority Banking／Priority Private。
   *
   * 呢類問題所有現有檢查都捉唔到：evidence 逐字驗得過（舊文件真係有嗰句）、
   * hash 短路命中（舊文件真係冇改過）、`source_moved` gate 唔會響（host 一樣）。
   * 每個燈都綠，因為佢哋全部只問「呢句嘢喺唔喺呢份文件」——**冇一個問過
   * 「呢份文件仲係咪嗰份文件」**。
   *
   * 跟進方法同其他 kind 唔同：唔係改數值，係換 `source_url` 再重新核實。
   */
  'source_superseded',
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionStatus = z.enum(['open', 'answered', 'wont_fix']);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const Question = z.strictObject({
  /** 決定性產生：{rule_id}_{kind}。同一條 rule 同一種問題唔會開兩次。 */
  question_id: Id,
  card_id: Id,
  /** null = 問題關乎成張卡，唔係單一條 rule。 */
  rule_id: Id.nullable(),
  kind: QuestionKind,
  status: QuestionStatus.default('open'),
  /** 一句人話，講清楚要答乜。唔係「呢條有問題」，係「5% 係咪兩個 tier 都適用？」 */
  question: z.string().min(1).max(600),
  /** 引發呢條問題嘅原文節錄。 */
  evidence: z.string().max(500).nullable(),
  source_url: z.string().url(),
  raised_at: z.string().datetime(),
  /** 邊個流程開嘅：agent1 / agent2 / evidence_repair / human。 */
  raised_by: z.string().min(1),
  /** 人答完先有值。 */
  answer: z.string().max(1000).nullable().default(null),
  answered_at: z.string().datetime().nullable().default(null),
});
export type Question = z.infer<typeof Question>;

export function questionId(ruleId: string, kind: QuestionKind): string {
  return `${ruleId}_${kind}`;
}
