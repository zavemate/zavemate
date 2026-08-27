import { z } from 'zod';
import { Cap, Id, MatchCriteria, matchScopeIssue, Provenance } from './common.ts';

export const PromotionRewardType = z.enum([
  'rate_multiplier',
  'flat_rate',
  'bonus_points',
  'cash_rebate',
  'miles',
]);
export type PromotionRewardType = z.infer<typeof PromotionRewardType>;

export const PromotionReward = z.strictObject({
  type: PromotionRewardType,
  rate: z.number().nullable(),
  multiplier: z.number().nullable(),
  bonus_amount: z.number().nullable(),
  /** miles：每 HKD 要幾多蚊先換到 1 里，同 RewardValue.hkd_per_mile 意思一樣。 */
  hkd_per_mile: z.number().nullable(),
});
export type PromotionReward = z.infer<typeof PromotionReward>;

export const Stacking = z.strictObject({
  /** 可否同 base rate 相加。false = 取代 base rate。 */
  stackable_with_base: z.boolean().default(true),
  /** 同 group 內互斥，只計最高。 */
  stack_group: Id.nullable(),
  priority: z.number().int().default(0),
});
export type Stacking = z.infer<typeof Stacking>;

export const PromotionBase = z.strictObject({
  /** 決定性產生：{card_id}_{yyyyqn}_{slug}。同名就係同一個，直接覆寫。 */
  promotion_id: Id,
  card_id: Id,
  title: z.string().min(1),
  description: z.string().nullable(),
  match: MatchCriteria,
  reward: PromotionReward,
  cap: Cap.nullable(),
  stacking: Stacking,
  start_date: z.string().date().nullable(),
  /** null + unconfirmed = 唔知幾時完。唔好估。 */
  end_date: z.string().date().nullable(),
  requires_registration: z.boolean().default(false),
  registration_url: z.string().url().nullable(),
  new_customer_only: z.boolean().default(false),
  /** 過期唔好刪檔，改 active: false（§6.5）。 */
  active: z.boolean().default(true),
  provenance: Provenance,
});

export const Promotion = PromotionBase.superRefine((promo, ctx) => {
  const scopeIssue = matchScopeIssue(promo.match);
  if (scopeIssue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['match', 'scope'], message: scopeIssue });
  }

  const { type, rate, multiplier, bonus_amount, hkd_per_mile } = promo.reward;
  const required: Record<PromotionRewardType, 'rate' | 'multiplier' | 'bonus_amount' | 'hkd_per_mile'> = {
    rate_multiplier: 'multiplier',
    flat_rate: 'rate',
    cash_rebate: 'rate',
    bonus_points: 'bonus_amount',
    miles: 'hkd_per_mile',
  };
  const values = { rate, multiplier, bonus_amount, hkd_per_mile };
  const field = required[type];
  for (const key of ['rate', 'multiplier', 'bonus_amount', 'hkd_per_mile'] as const) {
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
        message: `reward.type = "${type}" 就唔可以填 reward.${key}`,
      });
    }
  }

  if (type === 'cash_rebate' || type === 'flat_rate') {
    if (rate !== null && rate > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reward', 'rate'],
        message: 'rate 係比例（0.05 = 5%），唔可以大過 1',
      });
    }
  }

  if (promo.start_date && promo.end_date && promo.end_date < promo.start_date) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_date'],
      message: 'end_date 唔可以早過 start_date',
    });
  }

  // §6.5：冇明確 end_date 就唔可以聲稱 official。唔好估。
  //
  // 原本呢條寫死「一定要 unconfirmed」，但同「第三方來源一律 crowdsourced」
  // 撞板——一個第三方抽到、冇寫結束日嘅優惠兩條規則都符合唔到。兩者講緊唔同
  // 嘅嘢：`crowdsourced` 講**出處性質**（第三方講嘅嘢我哋核實唔到），
  // `unconfirmed` 講**資料完整度**。夾硬要第三方嘅嘢變 unconfirmed，等於話
  // 「我哋核實過，但唔肯定」——兩樣都唔係真。
  //
  // 真正要守住嘅係：冇結束日就唔可以話自己 official。噉樣兩條規則就唔會打交。
  if (promo.end_date === null && promo.provenance.confidence === 'official') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['provenance', 'confidence'],
      message:
        'end_date 係 null（即係唔知幾時完）就唔可以 confidence = "official"；如果真係讀到結束日就填落 end_date',
    });
  }

  // 要登記但冇俾登記連結——淨係對 official 強制。
  //
  // 官方頁面我哋讀得到，登記連結一定攞得到。但第三方報導成日淨係寫「一經
  // 滙豐Reward+ App登記」——嗰個係 app 唔係 URL，根本冇連結可以抄。
  //
  // 呢種情況下，寧願講「要登記，但唔知去邊登記」都好過隱瞞「要登記」。
  // **「要登記」呢個事實本身比「登記連結」重要得多**：唔講嘅話用戶會以為
  // 碌咗就有，最後成個回贈都攞唔到。
  if (promo.requires_registration && promo.registration_url === null && promo.provenance.confidence === 'official') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registration_url'],
      message: 'official 來源嘅 requires_registration = true 就要俾 registration_url',
    });
  }

  if (promo.cap && promo.cap.period === 'promo_period' && promo.end_date === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cap', 'period'],
      message: 'cap.period = "promo_period" 但冇 end_date —— 個 period 無法定義',
    });
  }
});
export type Promotion = z.infer<typeof Promotion>;
