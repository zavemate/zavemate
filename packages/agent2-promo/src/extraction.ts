import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Agent 2 抽取結果嘅 schema。
 *
 * 同 Agent 1 最大分別：Agent 1 係對住一張固定 rule 清單逐條核實（監察），
 * Agent 2 係喺一版可能有零個、可能有十個優惠嘅頁面度搵嘢（發現）。所以
 * 冇「已知 id 逐個對」呢回事，要 LLM 自己交出佢見到嘅優惠清單。
 */
export const ExtractedPromoReward = z.strictObject({
  type: z.enum(['rate_multiplier', 'flat_rate', 'bonus_points', 'cash_rebate', 'miles']).nullable(),
  rate: z.number().nullable(),
  multiplier: z.number().nullable(),
  bonus_amount: z.number().nullable(),
  hkd_per_mile: z.number().nullable(),
});
export type ExtractedPromoReward = z.infer<typeof ExtractedPromoReward>;

export const ExtractedPromotion = z.strictObject({
  /** 邊張卡。一定要係我哋 data/cards/ 入面有嘅 card_id，唔係就填 null。 */
  card_id: z.string().nullable(),
  /**
   * 英文 slug。如果 existing_promotions 入面已經有同一個優惠，一定要原封不動
   * 重用返嗰個 slug——id 就係去重嘅唯一機制。
   */
  slug: z.string(),
  title: z.string(),
  reward: ExtractedPromoReward.nullable(),
  cap_value: z.number().nullable(),
  cap_unit: z.enum(['reward', 'spend']).nullable(),
  /** 適用範圍——填得到幾多就幾多。 */
  match_channel: z.array(z.enum(['online', 'offline', 'mobile_pay', 'recurring'])).nullable(),
  match_currency: z.array(z.enum(['HKD', 'FOREIGN'])).nullable(),
  match_merchant_include: z.array(z.string()).nullable(),
  /**
   * 官方有講適用範圍，但你用上面啲欄位表達唔到（例如只得類別名、冇商戶清單）。
   *
   * true 會令個 promotion 標 match.scope = 'undetermined'——即係我哋老實講明
   * 「知有範圍但界定唔到」，而唔係扮咗適用於全部簽賬。
   */
  scope_not_expressible: z.boolean(),
  /** yyyy-mm-dd，或者 null = 官方冇講。唔好估。 */
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  requires_registration: z.boolean(),
  /** 官方明文提早結束咗呢個優惠。 */
  ended_early: z.boolean(),
  /**
   * 呢個回贈率係咪已經**包含**基本回贈（例如「8%『獎賞錢』回贈（含基本獎賞）」）。
   *
   * true  = 包含 → stackable_with_base: false（取代 base，唔相加）
   * false = 額外 → stackable_with_base: true（加落 base 上面）
   * null  = 條款講唔清 → 當 false 處理（唔相加）+ confidence 降做 unconfirmed
   *
   * 呢個欄位唔可以靠 schema default。HSBC Red 個 8% 就係含基本獎賞——當佢
   * 可疊加就會計成 8.4%，**高報**。高報比低報傷得多：用戶會為咗一個唔存在
   * 嘅回贈率去碌卡。
   */
  reward_includes_base: z.boolean().nullable(),
  /**
   * 睇落唔似限時優惠，而係張卡嘅長期條款結構。
   * true 就唔會被寫入 promotions，會喺 PR body 標出嚟叫人手交俾 Agent 1（§6.5）。
   */
  looks_like_base_terms: z.boolean(),
  /**
   * 呢個著數係**寫呢篇文嗰個網站自己俾**嘅，唔係發卡銀行俾。
   *
   * 第三方攻略站靠 affiliate 過活，成日會喺篇文夾一段「經本網指定連結申請
   * 再送你 $1,500 禮品卡」。嗰個係佢哋自己嘅推薦獎賞，同張卡本身冇關係：
   * 唔經佢條 link 就冇，過幾日佢改咗又冇,而且銀行嘅官方條款永遠核實唔到佢。
   *
   * 呢種嘢寫入事實層就係錯：我哋對外承諾每個數字都有 source_url 追返去出處，
   * 而呢個「出處」係一個 affiliate 推廣，唔係一份條款。
   *
   * 認佢嘅字眼：「經本網」「經以下指定連結」「透過本站申請」「填妥換領表格」
   * 「提交批卡截圖」——著數要你經個網站做啲嘢先攞到，就係呢種。
   */
  is_publisher_offer: z.boolean(),
  /**
   * 篇文有冇 link 返去銀行官方條款／優惠頁。有就抄返條 URL。
   *
   * 呢個係 crowdsourced → official 嘅升級路徑。第三方平台快（銀行特登將優惠
   * 散佈落嗰度），但唔準；官方準，但慢。冇呢條 link，第三方發現嘅優惠會永遠
   * 停喺 crowdsourced——「快」嘅價值攞到，「準」嘅價值攞唔到。
   *
   * Agent 2 會喺同一個 PR 度提議將呢條 URL 加入 sources.json。Agent 唔可以
   * 寫 main，PR review 就係批准機制（§2 決策 3、4）。
   */
  official_source_url: z.string().nullable(),
  confidence: z.enum(['official', 'unconfirmed', 'crowdsourced']),
  evidence_excerpt: z.string().max(500).nullable(),
});
export type ExtractedPromotion = z.infer<typeof ExtractedPromotion>;

export const PromoExtractionResult = z.strictObject({
  promotions: z.array(ExtractedPromotion),
});
export type PromoExtractionResult = z.infer<typeof PromoExtractionResult>;

/** 餵俾 LLM 睇嘅現有優惠——同一張卡同一季度嗰啲。 */
export interface ExistingPromotion {
  promotion_id: string;
  card_id: string;
  slug: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
}

export interface PromoPromptInput {
  sourceLabel: string;
  sourceType: 'official' | 'third_party';
  /** 呢個來源可能涉及嘅卡。 */
  cards: Array<{ card_id: string; card_name: string }>;
  existing: ExistingPromotion[];
  today: string;
}

export function buildPromoSystemPrompt(input: PromoPromptInput): string {
  const cardList = input.cards.map((c) => `- ${c.card_id}：${c.card_name}`).join('\n') || '（冇提供）';
  const existingList =
    input.existing
      .map(
        (p) =>
          `- slug "${p.slug}"（id ${p.promotion_id}，${p.card_id}）：${p.title}｜${p.start_date ?? '?'} 至 ${p.end_date ?? '?'}`,
      )
      .join('\n') || '（呢張卡呢個季度暫時未有記錄）';

  const thirdPartyNote =
    input.sourceType === 'third_party'
      ? '\n呢個來源係第三方報導，唔係官方頁面。所有抽取到嘅優惠 confidence 一律填 "crowdsourced"，唔可以填 "official"。'
      : '';

  return `你係一個香港信用卡限時優惠嘅資料整理員。以下係「${input.sourceLabel}」呢個來源嘅內容，今日係 ${input.today}。

你嘅工作係搵出入面提到嘅**限時優惠**，唔係張卡嘅長期回贈結構。${thirdPartyNote}

可以對應嘅信用卡：
${cardList}

呢啲卡呢個季度我哋已經記錄咗嘅優惠：
${existingList}

規則：

1. **如果你搵到嘅優惠同上面某一個已記錄嘅係同一個，slug 一定要原封不動抄返嗰個。**
   唔係新開一個近似嘅名。id 就係我哋唯一嘅去重機制——slug 唔一致就會變成同一個
   優惠有兩份檔。延期咗、改咗上限、改咗商戶名單，全部都仲係「同一個優惠」，
   一樣要重用返個 slug。
2. slug 只可以用細楷英文字母、數字同底線（例如 online、designated、dining_hotel）。
   唔可以用中文。
3. 搵唔到明確嘅結束日期就 end_date 填 null。**唔好估。**「年底前」「暫定」
   呢啲唔算明確日期。
   confidence：第三方來源一律 "crowdsourced"（見上面），呢條規則唔會令佢變。
   官方來源冇明確結束日期就填 "unconfirmed"。
4. 官方明文講咗提早結束，ended_early 填 true，end_date 填實際結束嗰日。
5. 如果段內容睇落係張卡嘅長期回贈結構（例如基本回贈率、常設嘅類別倍數），
   而唔係一個有起訖日嘅推廣，looks_like_base_terms 填 true。呢啲我哋唔會當
   優惠處理，會交返俾人手判斷。
6. card_id 一定要係上面清單入面其中一個。對唔上任何一張卡就填 null。
7. 適用範圍：填得到幾多就填幾多（match_channel / match_currency /
   match_merchant_include）。如果官方有講範圍但你用呢幾個欄位表達唔到
   （例如佢只係寫「餐飲類別」而冇俾商戶清單），scope_not_expressible 填 true。
   **唔好因為表達唔到就當佢適用於全部簽賬**——嗰個係講緊一件唔真嘅事。
8. reward_includes_base：條款寫住個回贈率「已包含基本回贈／含基本獎賞」就填 true；
   明確講係「額外」「另加」就填 false；講唔清就填 null。**唔好估。**
   呢個直接決定我哋計唔計多咗——填錯會令我哋報一個唔存在嘅回贈率。
9. official_source_url：如果段內容有 link 返去銀行官方嘅條款頁或者優惠頁，
   抄返條完整 URL。冇就填 null。呢個係我哋之後去官方核實嘅入口——第三方講
   嘅嘢我哋核實唔到，要返去源頭。唔好自己砌一條 URL 出嚟。
10. 每個數值都要喺 evidence_excerpt 俾返支持佢嘅原文節錄。俾唔到就 confidence
   填 "unconfirmed"。
11. is_publisher_offer：如果段著數係**寫呢篇文嗰個網站自己俾**嘅——要你經佢
   指定連結申請、填佢張換領表格、俾佢批卡截圖先攞到——就填 true。銀行本身
   俾嘅（迎新、簽賬回贈、指定商戶優惠）填 false。
   分唔清就睇一句：唔經呢個網站做嘢仲攞唔攞到？攞到 = false。
12. 呢版冇任何限時優惠嘅話，promotions 交一個空陣列。空陣列係正確答案，
   唔係失敗——唔好為咗交嘢而將長期條款當成優惠。

用 JSON 回覆，一定要符合以下 JSON Schema：
${JSON.stringify(zodToJsonSchema(PromoExtractionResult), null, 2)}`;
}
