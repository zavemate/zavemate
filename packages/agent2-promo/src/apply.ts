import type { MatchCriteria, Promotion, PromotionReward } from '@zavemate/schema';
import { findSuspectedDuplicates, type SuspectedDuplicate } from './dedupe.ts';
import type { ExistingPromotion, ExtractedPromotion } from './extraction.ts';
import { normalizeSlug, promotionId } from './id.ts';
import { daysBetween, EXPIRY_GRACE_DAYS } from './expire.ts';

export interface ApplyPromoResult {
  /** promotion_id → 新／改咗嘅 Promotion。冇郁過嘅唔會出現。 */
  updated: Map<string, Promotion>;
  notes: string[];
  /** 要人手睇嘅嘢，入 PR body 嘅 ⚠️ 區。 */
  attentionNeeded: string[];
  suspectedDuplicates: SuspectedDuplicate[];
}

function toReward(extracted: ExtractedPromotion['reward']): PromotionReward | null {
  if (extracted === null || extracted.type === null) return null;
  return {
    type: extracted.type,
    rate: extracted.rate,
    multiplier: extracted.multiplier,
    bonus_amount: extracted.bonus_amount,
    hkd_per_mile: extracted.hkd_per_mile,
  };
}

/**
 * 適用範圍。scope 嘅語義同 cards 嗰邊一樣：
 * 'all' 係一個斷言（真係適用於全部），唔係「我哋冇填準則」嘅同義詞。
 */
function toMatch(extracted: ExtractedPromotion): MatchCriteria {
  const criteria = {
    channel: extracted.match_channel,
    currency: extracted.match_currency,
    mcc_include: null,
    mcc_exclude: null,
    merchant_include: extracted.match_merchant_include,
    merchant_exclude: null,
    min_spend_per_txn: null,
  };
  const hasCriteria = criteria.channel !== null || criteria.currency !== null || criteria.merchant_include !== null;
  const scope = extracted.scope_not_expressible ? 'undetermined' : hasCriteria ? 'criteria' : 'all';
  // undetermined / all 唔可以帶住準則（schema 會 reject），所以要清走。
  return scope === 'criteria' ? { scope, ...criteria } : { scope, ...criteria, channel: null, currency: null, merchant_include: null };
}

export interface ApplyPromoInput {
  extracted: ExtractedPromotion[];
  /** 現有優惠，key = promotion_id。 */
  existing: Map<string, Promotion>;
  /** 餵過俾 LLM 睇嗰批（同卡同季度），用嚟做去重兜底。 */
  existingForPrompt: ExistingPromotion[];
  /** 呢個來源涉及嘅卡——要 issuer 做機器驗證，唔淨係 card_id。 */
  cards: Array<{ card_id: string; issuer: string; issuer_aliases: string[] }>;
  sourceUrl: string;
  sourceType: 'official' | 'third_party';
  /** yyyy-mm-dd */
  today: string;
  nowIso: string;
}

/**
 * 篇原文有冇真係提過呢張卡嘅發卡行。
 *
 * 2026-08-27 真跑：恒生（Hang Seng）嘅 IKEA／萬寧／豐澤／繳費／夏日簽賬賞
 * 全部掛咗落三張滙豐（HSBC）卡度，22 條入面錯咗約 14 條。恒生係滙豐集團成員、
 * 中文名又似，LLM 當咗同一間——而佢**同一次抽取交返嘅 evidence_excerpt 白紙
 * 黑字寫住「憑恒生信用卡」**。即係證據本身已經推翻咗個 card_id。
 *
 * 所以呢度唔問 LLB「你肯唔肯定」，直接攞佢自己交嘅原文嚟對：issuer 或者其中
 * 一個 alias 要喺 title／evidence 出現過。同 Agent 1 嘅 evidenceSupportedBy
 * 一樣嘅道理——LLM 可以提議，但唔可以自己認證自己。
 *
 * 漏報（一篇真係滙豐嘅文冇寫「滙豐」兩隻字）嘅代價係少收一個優惠，而且會出
 * attention note 睇得到；誤收一間錯嘅銀行嘅優惠係對外講錯數。兩者唔對稱。
 */
function issuerMentioned(
  title: string,
  evidence: string | null,
  card: { issuer: string; issuer_aliases: string[] },
): boolean {
  const haystack = `${title}\n${evidence ?? ''}`.toLowerCase();
  return [card.issuer, ...card.issuer_aliases].some((name) => haystack.includes(name.toLowerCase()));
}

export function applyExtractedPromotions(input: ApplyPromoInput): ApplyPromoResult {
  const updated = new Map<string, Promotion>();
  const notes: string[] = [];
  const attentionNeeded: string[] = [];
  const newByCard = new Map<string, string[]>();

  for (const promo of input.extracted) {
    // §6.5：似係長期條款就唔好自己處理，交返俾人手加落 Agent 1 範圍。
    if (promo.looks_like_base_terms) {
      attentionNeeded.push(
        `「${promo.title}」睇落係長期條款唔係限時優惠——冇當優惠處理。要人手判斷使唔使加落 Agent 1 嘅 source 清單（${input.sourceUrl}）`,
      );
      continue;
    }

    // §6.5：篇文嗰個網站自己俾嘅著數，唔係銀行俾——唔屬於事實層。
    //
    // 唔經佢條 affiliate link 就冇，佢改咗又冇，而且銀行嘅官方條款永遠核實
    // 唔到佢。收咗佢即係我哋對外話「呢個數字嘅出處係一份條款」，但實情個
    // 出處係一個推薦推廣。
    if (promo.is_publisher_offer) {
      attentionNeeded.push(
        `「${promo.title}」係 ${new URL(input.sourceUrl).hostname} 自己俾嘅著數（要經佢申請先有），唔係銀行推廣——冇寫入`,
      );
      continue;
    }

    if (promo.card_id === null) {
      attentionNeeded.push(`「${promo.title}」對唔上任何一張已知嘅卡——冇寫入。可能係我哋未收錄嗰張卡`);
      continue;
    }

    // 一出世就已經死咗嘅優惠，唔好收。
    //
    // 舊 promotion 過期係由 §6.5 步驟 0 熄（active: false，唔刪檔——歷史係
    // 產品資產）。但「新抽到一個過咗期好耐嘅優惠」唔同：佢喺我哋個事實層
    // 入面從來冇生效過，收咗佢即係開一個檔、出一條 change event、落一行
    // PR，然後下個週期即刻熄返——全部都係噪音。
    //
    // Feed 一拆開就會見到幾個月舊文，所以呢個 guard 而家先變得重要：冇佢
    // 嘅話，第一次跑會一次過寫一批死咗嘅優惠入 repo。
    //
    // 用返同一個 EXPIRY_GRACE_DAYS：銀行成日過咗期第二日先改官網，所以
    // 「啱啱先完」嗰啲照收，同步驟 0 嘅判斷保持一致。
    if (promo.end_date !== null && daysBetween(promo.end_date, input.today) > EXPIRY_GRACE_DAYS) {
      attentionNeeded.push(
        `「${promo.title}」end_date ${promo.end_date} 已經過咗（今日 ${input.today}）——冇寫入。呢篇係 feed 入面嘅舊文`,
      );
      continue;
    }

    const card = input.cards.find((c) => c.card_id === promo.card_id);
    if (card === undefined) {
      attentionNeeded.push(`「${promo.title}」嘅 card_id "${promo.card_id}" 唔喺呢個來源嘅卡清單入面——冇寫入`);
      continue;
    }
    if (!issuerMentioned(promo.title, promo.evidence_excerpt, card)) {
      attentionNeeded.push(
        `「${promo.title}」掛咗落 ${promo.card_id}，但原文一次都冇提過 ${card.issuer}——冇寫入。多數係撈亂咗發卡行（恒生 ≠ 滙豐）`,
      );
      continue;
    }

    const slug = normalizeSlug(promo.slug);
    if (slug === '') {
      attentionNeeded.push(`「${promo.title}」個 slug "${promo.slug}" 正規化之後係空（要 ASCII 英文）——冇寫入`);
      continue;
    }

    const reward = toReward(promo.reward);
    if (reward === null) {
      attentionNeeded.push(`「${promo.title}」冇 reward.type——冇寫入。抽取結果自相矛盾`);
      continue;
    }

    const id = promotionId({
      cardId: promo.card_id,
      startDate: promo.start_date,
      detectedOn: input.today,
      slug,
    });

    // reward_includes_base 決定計唔計多咗。講唔清就當「唔可疊加」——高報比
    // 低報傷得多：用戶會為咗一個唔存在嘅回贈率去碌卡。
    const stackable = promo.reward_includes_base === false;
    let confidence = promo.confidence;
    if (promo.reward_includes_base === null) {
      confidence = confidence === 'crowdsourced' ? 'crowdsourced' : 'unconfirmed';
      attentionNeeded.push(
        `${promo.card_id}/${id}：條款講唔清個回贈率包唔包基本回贈——當咗唔可疊加（保守），confidence 降做 ${confidence}`,
      );
    }
    // §6.5：冇明確 end_date 就 null + unconfirmed，唔好估。
    if (promo.end_date === null && confidence === 'official') confidence = 'unconfirmed';

    const existing = input.existing.get(id);
    const promotion: Promotion = {
      promotion_id: id,
      card_id: promo.card_id,
      title: promo.title,
      description: existing?.description ?? null,
      match: toMatch(promo),
      reward,
      cap:
        promo.cap_value !== null && promo.cap_unit !== null
          ? {
              pool_id: `${id}_cap`,
              value: promo.cap_value,
              unit: promo.cap_unit,
              period: existing?.cap?.period ?? 'month',
              shared_with: existing?.cap?.shared_with ?? [],
            }
          : null,
      stacking: {
        stackable_with_base: stackable,
        // 互斥分組要睇成個推廣嘅結構，唔係一條優惠自己睇得出——留返人手。
        stack_group: existing?.stacking.stack_group ?? null,
        priority: existing?.stacking.priority ?? 0,
      },
      start_date: promo.start_date,
      end_date: promo.end_date,
      requires_registration: promo.requires_registration,
      registration_url: existing?.registration_url ?? null,
      new_customer_only: existing?.new_customer_only ?? false,
      // 官方明文提早結束 → active: false，但唔刪檔（§6.5）。
      active: !promo.ended_early,
      provenance: {
        confidence,
        source_url: input.sourceUrl,
        evidence_excerpt: promo.evidence_excerpt,
        content_hash: null,
        last_checked_at: input.nowIso,
        last_verified_at: confidence === 'official' ? input.nowIso : (existing?.provenance.last_verified_at ?? null),
        check_fail_count: 0,
      },
    };

    updated.set(id, promotion);

    // 「新／舊」同「有冇提早結束」係兩件事。一個啱啱先發現、但官方已經腰斬咗
    // 嘅優惠，兩樣都要講——淨係報「全新優惠」會令人以為佢仲行緊。
    const kind = existing ? `🔄 更新` : `✨ 全新優惠「${promo.title}」`;
    const ended = promo.ended_early ? `⏹ 官方提早結束，end_date ${promo.end_date ?? '?'}，active: false` : '';
    notes.push(
      [`${kind}`, ended].filter(Boolean).join('｜') +
        ` — ${promo.card_id}/${id}（${promo.start_date ?? '?'} 至 ${promo.end_date ?? '?'}）`,
    );
    if (!existing) newByCard.set(promo.card_id, [...(newByCard.get(promo.card_id) ?? []), id]);
  }

  // 同一張卡一次過多咗幾個優惠，好多時係同一個推廣嘅唔同類別（互斥），
  // 但一條優惠自己睇唔出佢同邊條互斥。標出嚟俾人手決定 stack_group。
  for (const [cardId, ids] of newByCard) {
    if (ids.length < 2) continue;
    attentionNeeded.push(
      `${cardId}：今次一次過新增咗 ${ids.length} 個優惠（${ids.join('、')}）。如果佢哋係同一個推廣嘅唔同類別，通常互斥——要人手設 stack_group，否則 /best-card 會將佢哋加埋一齊`,
    );
  }

  return {
    updated,
    notes,
    attentionNeeded,
    suspectedDuplicates: findSuspectedDuplicates(input.extracted, input.existingForPrompt),
  };
}
