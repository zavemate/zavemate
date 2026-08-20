import { z } from 'zod';
import { Cap, Id, MatchCriteria, Provenance } from './common.ts';

export const PromotionRewardType = z.enum([
  'rate_multiplier',
  'flat_rate',
  'bonus_points',
  'cash_rebate',
]);
export type PromotionRewardType = z.infer<typeof PromotionRewardType>;

export const PromotionReward = z.strictObject({
  type: PromotionRewardType,
  rate: z.number().nullable(),
  multiplier: z.number().nullable(),
  bonus_amount: z.number().nullable(),
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
  const { type, rate, multiplier, bonus_amount } = promo.reward;
  const required: Record<PromotionRewardType, 'rate' | 'multiplier' | 'bonus_amount'> = {
    rate_multiplier: 'multiplier',
    flat_rate: 'rate',
    cash_rebate: 'rate',
    bonus_points: 'bonus_amount',
  };
  const values = { rate, multiplier, bonus_amount };
  const field = required[type];
  for (const key of ['rate', 'multiplier', 'bonus_amount'] as const) {
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

  // §6.5：冇明確 end_date → null + unconfirmed。唔好估。
  if (promo.end_date === null && promo.provenance.confidence !== 'unconfirmed') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['provenance', 'confidence'],
      message:
        'end_date 係 null（即係唔知幾時完）就一定要 confidence = "unconfirmed"；如果真係讀到結束日就填落 end_date',
    });
  }

  if (promo.requires_registration && promo.registration_url === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registration_url'],
      message: 'requires_registration = true 就要俾 registration_url',
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
