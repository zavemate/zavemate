import { z } from 'zod';

/**
 * 積分/里數估值係主觀判斷，唔係事實 —— 所以獨立於 data/cards 維護（§4.5）。
 * 唔可以混入 cards/*.json：呢啲數字唔可核實、會有爭議，
 * 而且客戶可以喺 /best-card request 覆寫。
 */
export const Valuations = z.strictObject({
  note: z.string(),
  updated_at: z.string().date(),
  /** 每里數值幾多港元。 */
  miles: z.record(z.string(), z.number().positive()),
  /** 每分值幾多港元。 */
  points: z.record(z.string(), z.number().positive()),
});
export type Valuations = z.infer<typeof Valuations>;
