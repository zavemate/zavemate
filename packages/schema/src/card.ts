import { z } from 'zod';
import { Cap, Eligibility, Id, MatchCriteria, matchScopeIssue, Provenance, TierPeriod } from './common.ts';

export const RewardType = z.enum(['cash_rebate', 'points', 'miles']);
export type RewardType = z.infer<typeof RewardType>;

export const RewardValue = z.strictObject({
  type: RewardType,
  /** cash_rebate：0.04 = 4% */
  rate: z.number().nullable(),
  /** points：每 HKD 攞幾多分 */
  points_per_hkd: z.number().nullable(),
  /** miles：每里數要幾多蚊 */
  hkd_per_mile: z.number().nullable(),
});
export type RewardValue = z.infer<typeof RewardValue>;

export const Tier = z.strictObject({
  min_spend: z.number().nonnegative(),
  max_spend: z.number().positive().nullable(),
  period: TierPeriod,
});
export type Tier = z.infer<typeof Tier>;

export const RewardRuleBase = z.strictObject({
  /** 全域唯一，永不重用（§9 唔可以做 #9）。 */
  rule_id: Id,
  /** 人睇嘅描述，例如「網上簽賬」。 */
  label: z.string().min(1),
  match: MatchCriteria,
  reward: RewardValue,
  tier: Tier.nullable(),
  cap: Cap.nullable(),
  requires_registration: z.boolean().default(false),
  registration_url: z.string().url().nullable(),
  /**
   * null = 一直生效。
   * 銀行通常公布「9月1日起生效」—— 唔可以即刻覆蓋現值，
   * 要新增一條 effective_from 為未來日期嘅 rule，同時將舊 rule 嘅 effective_to 設為前一日。
   */
  effective_from: z.string().date().nullable(),
  effective_to: z.string().date().nullable(),
  provenance: Provenance,
});

export const RewardRule = RewardRuleBase.superRefine((rule, ctx) => {
  const { type, rate, points_per_hkd, hkd_per_mile } = rule.reward;

  const requireOnly = (field: 'rate' | 'points_per_hkd' | 'hkd_per_mile') => {
    const values = { rate, points_per_hkd, hkd_per_mile };
    for (const key of ['rate', 'points_per_hkd', 'hkd_per_mile'] as const) {
      const value = values[key];
      if (key === field) {
        if (value === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['reward', key],
            message: `reward.type = "${type}" 就一定要有 reward.${key}`,
          });
        } else if (value <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['reward', key],
            message: `reward.${key} 要大過 0`,
          });
        }
      } else if (value !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reward', key],
          message: `reward.type = "${type}" 就唔可以填 reward.${key}（現金回贈/積分/里數唔可以互換）`,
        });
      }
    }
  };

  if (type === 'cash_rebate') {
    requireOnly('rate');
    if (rate !== null && rate > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reward', 'rate'],
        message: 'cash_rebate rate 係比例（0.04 = 4%），唔可以大過 1',
      });
    }
  } else if (type === 'points') {
    requireOnly('points_per_hkd');
  } else {
    requireOnly('hkd_per_mile');
  }

  const scopeIssue = matchScopeIssue(rule.match);
  if (scopeIssue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['match', 'scope'], message: scopeIssue });
  }

  if (rule.tier && rule.tier.max_spend !== null && rule.tier.max_spend <= rule.tier.min_spend) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tier', 'max_spend'],
      message: 'tier.max_spend 要大過 tier.min_spend',
    });
  }

  if (rule.effective_from && rule.effective_to && rule.effective_to < rule.effective_from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effective_to'],
      message: 'effective_to 唔可以早過 effective_from',
    });
  }

  if (rule.cap && rule.cap.shared_with.includes(rule.rule_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cap', 'shared_with'],
      message: 'cap.shared_with 唔應該包含自己嘅 rule_id',
    });
  }

  if (rule.requires_registration && rule.registration_url === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registration_url'],
      message: 'requires_registration = true 就要俾 registration_url（搵唔到就將 requires_registration 留返 false 並標 unconfirmed）',
    });
  }
});
export type RewardRule = z.infer<typeof RewardRule>;

/**
 * 一份來源文件係咩嚟。
 *
 * 分呢個用途出嚟，唔係為咗好睇——係因為「張卡有冇自己嘅獎賞計劃條款」呢個問題
 * 冇欄位表達嘅話，根本檢查唔到。hsbc_red / hsbc_premier_mastercard 就係咁：
 * 兩張卡都淨係指住通用嘅 RewardCash Programme 條款（成個計劃嘅地板，原文寫明
 * "Except as specified in Clause 5"），但標住 confidence: official，冇任何嘢
 * 攔得住。
 */
export const SourcePurpose = z.enum([
  /** 呢張卡自己嘅獎賞計劃條款——回贈率嘅正式出處。 */
  'scheme',
  /** 發卡行通用獎賞計劃條款（例如 HSBC RewardCash Programme）。係地板，唔係邊張卡嘅回贈率。 */
  'programme_base',
  /** 指定商戶／類別名單。講「邊度用」，唔講「賺幾多」。 */
  'merchant_list',
  /** 信用卡一般條款。 */
  'card_terms',
  /** Key Facts Statement。 */
  'kfs',
  /**
   * 銀行自己列嘅「呢張卡適用邊幾份條款」目錄（HSBC 嘅 important-information.pdf）。
   *
   * 佢係「呢張卡真係冇卡專屬獎賞計劃」嘅權威證據——冇呢樣嘢，我哋分唔到
   * 「銀行冇出過」同「我哋搵漏咗」。hsbc_premier_mastercard 就係前者：
   * 目錄由頭到尾冇 reward scheme，佢個回贈本身就係 RewardCash 計劃地板；
   * 而 hsbc_red 個目錄就明確列住「Terms and Conditions for HSBC Red Credit
   * Card Reward Scheme」。
   */
  'card_index',
  /** 產品／行銷頁。永遠唔可以做 official 數值嘅出處（CLAUDE.md：行銷頁成日將限時優惠講到似永久 base rate）。 */
  'product_page',
]);
export type SourcePurpose = z.infer<typeof SourcePurpose>;

export const CardSource = z.strictObject({
  url: z.string().url(),
  purpose: SourcePurpose,
  /** 點解收呢份、或者佢有咩限制（例如：圖片型 PDF，抽唔到文字）。 */
  note: z.string().nullable(),
  /**
   * 上次見到嘅 HTTP Last-Modified（原樣保留）。下次 check 就有基準可比。
   *
   * 呢個係「使唔使落載」嘅答案，唔係「使唔使餵 LLM」——CMS 重新發佈、CDN
   * 重新上傳，日期會跳但內容一模一樣。所以佢唔取代 provenance.content_hash，
   * 兩者答緊唔同問題。
   */
  last_modified: z.string().nullable().default(null),
  /** 上次見到嘅 ETag。渣打 (av.sc.com) 有俾，HSBC 冇。 */
  etag: z.string().nullable().default(null),
  /**
   * 呢份係邊個語言版本。null = 中英合體（渣打啲 T&C PDF 就係咁，一份文件
   * 入面中英並列，/hk/zh/content/docs/ 同 /hk/content/docs/ 兩條路徑
   * serve 緊同一個 file，hash 一模一樣）。
   */
  language: z.enum(['en', 'zh']).nullable().default(null),
  /**
   * 呢版係咪法律上為準嗰版。
   *
   * 點解要分：HSBC 啲條款寫明「中英文本如有歧義，概以英文本為準」，但英文版
   * 好多時係圖片型 PDF（Red 個獎賞計劃：英文 101 字元、中文 4,204 字元）。
   * 即係我哋**由非權威版本抽數字**。呢件事對一個賣 provenance 嘅產品唔可以
   * 隱形——所以規則係：引用非權威版嘅 rule，同一個 purpose 嘅權威版都要收入
   * sources[] 一齊監察。權威版改咗而抽取版未改（或者相反），我哋要知。
   */
  is_authoritative: z.boolean().default(true),
});
export type CardSource = z.infer<typeof CardSource>;

export const Network = z.enum(['visa', 'mastercard', 'amex', 'unionpay', 'jcb']);
export type Network = z.infer<typeof Network>;

export const CardBase = z.strictObject({
  /** 永不重用，停用咗都唔可以俾第二張卡。 */
  card_id: Id,
  card_name: z.string().min(1),
  card_name_zh: z.string().nullable(),
  issuer: z.string().min(1),
  network: Network,
  annual_fee: z.number().nonnegative(),
  annual_fee_waiver_note: z.string().nullable(),
  fx_fee_rate: z.number().nullable(),
  eligibility: Eligibility,
  active: z.boolean().default(true),
  /**
   * 呢張卡要監察嘅全部來源文件。
   *
   * source_url 之前淨係埋喺每條 rule 嘅 provenance 入面，所以冇人答到
   * 「呢張卡啲條款收齊咗未」。呢個 array 就係嗰個答案。
   */
  sources: z.array(CardSource),
  rewards: z.array(RewardRule),
  /** 卡層面嘅出處（產品主頁）。 */
  provenance: Provenance,
});

export const Card = CardBase.superRefine((card, ctx) => {
  if (
    (card.eligibility.min_relationship_balance === null) !==
    (card.eligibility.note === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eligibility'],
      message: 'eligibility.min_relationship_balance 同 eligibility.note 要一齊有值或者一齊 null',
    });
  }

  // ── sources[] 覆蓋率檢查 ──────────────────────────────────────────────
  const byUrl = new Map<string, SourcePurpose>();
  for (const [index, source] of card.sources.entries()) {
    if (byUrl.has(source.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'url'],
        message: `sources[] 入面 "${source.url}" 重複咗`,
      });
    }
    byUrl.set(source.url, source.purpose);
  }

  /** 有冇自己嘅獎賞計劃條款。 */
  const hasScheme = card.sources.some((source) => source.purpose === 'scheme');
  const hasProgrammeBase = card.sources.some((source) => source.purpose === 'programme_base');
  /** 銀行自己張適用條款目錄——「佢真係冇出 scheme」嘅證據。 */
  const hasCardIndex = card.sources.some((source) => source.purpose === 'card_index');

  const checkSourceListed = (url: string, path: (string | number)[]) => {
    if (!byUrl.has(url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `source_url "${url}" 冇列喺卡層 sources[] 入面——每個抓緊嘅來源都要登記埋用途`,
      });
      return null;
    }
    return byUrl.get(url)!;
  };

  checkSourceListed(card.provenance.source_url, ['provenance', 'source_url']);

  const bySourceUrl = new Map(card.sources.map((source) => [source.url, source]));

  for (const [index, rule] of card.rewards.entries()) {
    const purpose = checkSourceListed(rule.provenance.source_url, ['rewards', index, 'provenance', 'source_url']);

    // 由非權威語言版本抽數字係可以嘅（好多時權威版根本抽唔到文字），但一定要
    // 連權威版一齊監察，否則權威版改咗我哋唔會知。
    const cited = bySourceUrl.get(rule.provenance.source_url);
    if (cited && !cited.is_authoritative) {
      const hasAuthoritativeCounterpart = card.sources.some(
        (source) => source.purpose === cited.purpose && source.is_authoritative,
      );
      if (!hasAuthoritativeCounterpart) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rewards', index, 'provenance', 'source_url'],
          message: `呢條 rule 引用緊非權威語言版本，但 sources[] 冇收埋同一個 purpose ("${cited.purpose}") 嘅權威版——權威版改咗就冇人知`,
        });
      }
    }

    if (rule.provenance.confidence !== 'official') continue;

    // official 唔可以建基於「賺幾多」以外嘅文件。
    if (purpose === 'product_page' || purpose === 'merchant_list') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewards', index, 'provenance', 'confidence'],
        message: `confidence "official" 唔可以攞 purpose "${purpose}" 嘅文件做出處——行銷頁同商戶名單講「邊度用」，唔講「賺幾多」`,
      });
    }

    // 冇 scheme 文件就要有證據證明「銀行根本冇出過」，唔係就冇資格話自己肯定。
    if (!hasScheme && !(hasProgrammeBase && hasCardIndex)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewards', index, 'provenance', 'confidence'],
        message:
          '張卡 sources[] 冇 purpose "scheme" 嘅文件。如果係因為銀行根本冇出卡專屬獎賞計劃（例如回贈就係計劃地板），要同時收埋 "programme_base" 同 "card_index"（銀行自己列嘅適用條款目錄）做證據；否則即係未搵齊，confidence 要標 "unconfirmed"',
      });
    }
  }

  const seen = new Set<string>();
  for (const [index, rule] of card.rewards.entries()) {
    if (seen.has(rule.rule_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewards', index, 'rule_id'],
        message: `rule_id "${rule.rule_id}" 喺同一張卡入面重複咗`,
      });
    }
    seen.add(rule.rule_id);
  }

  // 同一個 pool_id 就係同一個上限池，三個欄位必須一致，否則展開嘅時候唔知信邊個。
  const pools = new Map<string, { value: number; unit: string; period: string; index: number }>();
  for (const [index, rule] of card.rewards.entries()) {
    if (!rule.cap) continue;
    const existing = pools.get(rule.cap.pool_id);
    if (!existing) {
      pools.set(rule.cap.pool_id, { ...rule.cap, index });
      continue;
    }
    if (
      existing.value !== rule.cap.value ||
      existing.unit !== rule.cap.unit ||
      existing.period !== rule.cap.period
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewards', index, 'cap'],
        message: `pool_id "${rule.cap.pool_id}" 喺 rewards[${existing.index}] 嘅 value/unit/period 唔一致 —— 共用池要三個欄位完全一樣`,
      });
    }
  }

  const ruleIds = new Set(card.rewards.map((rule) => rule.rule_id));
  for (const [index, rule] of card.rewards.entries()) {
    for (const shared of rule.cap?.shared_with ?? []) {
      if (!ruleIds.has(shared)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rewards', index, 'cap', 'shared_with'],
          message: `cap.shared_with 指住 "${shared}"，但呢張卡冇呢條 rule`,
        });
      }
    }
  }
});
export type Card = z.infer<typeof Card>;
