import type { Card, RewardRule, RewardValue } from '@zavemate/schema';

/**
 * Gate 係防止「agent 自信地讀錯數」嘅唯一防線（BUILD_SPEC §5）。
 * LLM 最危險嘅 failure mode 唔係唔肯定，係好肯定咁撈亂咗積分同現金回贈、
 * 或者將 promotion 當咗 base rate —— 嗰陣佢會寫 confidence: 'official'。
 * 所以呢度全部用數值合理性判斷，唔靠 agent 自我懷疑。
 */
export type GateReason =
  | 'rate_jump' // new/old > 1.5 或 < 0.67
  | 'rate_implausible' // cash_rebate rate > 0.15
  | 'cap_drop' // new/old < 0.7
  | 'cap_unit_changed' // cap.unit 由 reward 變 spend 或相反
  | 'structure_change' // tier 數目變 / 新增 rule_id / 刪 rule_id / reward.type 變
  | 'first_rule' // 呢張卡第一次出現（冇歷史可以比較）
  | 'official_conflict' // content_hash 冇變，但 confidence 仍係 official 嘅數值變咗
  | 'confidence_upgraded' // confidence 由 unconfirmed/crowdsourced 升做 official
  | 'source_moved' // source_url 嘅 host 變咗
  | 'future_effective' // effective_from > today + 7d
  | 'card_deactivated'; // active: true → false

export interface GateResult {
  passed: boolean;
  reasons: GateReason[];
  details: string[]; // 人睇嘅解釋，直接放入 PR body
}

const RATE_JUMP_UPPER = 1.5;
const RATE_JUMP_LOWER = 1 / 1.5; // 0.67，同上限對稱
const CASH_REBATE_IMPLAUSIBLE = 0.15;
const CAP_DROP_THRESHOLD = 0.7;
const FUTURE_EFFECTIVE_DAYS = 7;

/**
 * 將唔同 reward.type 統一做「數值越大越著數」嘅可比較數字。
 * miles 用 hkd_per_mile（每 1 里要幾多蚊），數值越細越著數，所以要取倒數。
 * 搵唔到對應欄位（唔應該發生，Zod 已經驗證過）就回傳 null，call 嗰邊要防守。
 */
function effectiveRateValue(reward: RewardValue): number | null {
  switch (reward.type) {
    case 'cash_rebate':
      return reward.rate;
    case 'points':
      return reward.points_per_hkd;
    case 'miles':
      return reward.hkd_per_mile === null || reward.hkd_per_mile === 0
        ? null
        : 1 / reward.hkd_per_mile;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // source_url 已經俾 Zod 驗證過一定係合法 URL，呢度純粹防守。
    return url;
  }
}

function ruleMap(rules: readonly RewardRule[]): Map<string, RewardRule> {
  return new Map(rules.map((rule) => [rule.rule_id, rule]));
}

function tieredRuleCount(rules: readonly RewardRule[]): number {
  return rules.filter((rule) => rule.tier !== null).length;
}

/**
 * @param now 測試用嘅「而家」，預設用真實時間。
 */
export function evaluateGate(oldCard: Card | null, newCard: Card, now: Date = new Date()): GateResult {
  const reasons = new Set<GateReason>();
  const details: string[] = [];

  const addReason = (reason: GateReason, detail: string) => {
    reasons.add(reason);
    details.push(detail);
  };

  // ── 呢張卡第一次出現：冇歷史可以比較，一定要人睇一眼 ──────────────
  if (oldCard === null) {
    addReason('first_rule', `card_id "${newCard.card_id}" 係新卡，冇歷史數據可以比較`);
  }

  // ── card_deactivated：active true → false ──────────────────────
  if (oldCard !== null && oldCard.active && !newCard.active) {
    addReason('card_deactivated', `card_id "${newCard.card_id}" 由 active 變 inactive`);
  }

  // ── card 層面 source_url host 變咗 ──────────────────────────────
  if (oldCard !== null) {
    const oldHost = hostOf(oldCard.provenance.source_url);
    const newHost = hostOf(newCard.provenance.source_url);
    if (oldHost !== newHost) {
      addReason(
        'source_moved',
        `card "${newCard.card_id}" 嘅卡層面 source_url host 由 "${oldHost}" 變咗 "${newHost}"`,
      );
    }
  }

  // ── 淨係睇新卡本身嘅檢查（唔需要舊卡） ───────────────────────────
  for (const rule of newCard.rewards) {
    if (rule.reward.type === 'cash_rebate' && rule.reward.rate !== null && rule.reward.rate > CASH_REBATE_IMPLAUSIBLE) {
      addReason(
        'rate_implausible',
        `rule "${rule.rule_id}" 嘅 cash_rebate rate = ${rule.reward.rate}，大過 ${CASH_REBATE_IMPLAUSIBLE}（${CASH_REBATE_IMPLAUSIBLE * 100}%）呢個上限`,
      );
    }

    if (rule.effective_from !== null) {
      const threshold = new Date(now);
      threshold.setDate(threshold.getDate() + FUTURE_EFFECTIVE_DAYS);
      if (new Date(rule.effective_from) > threshold) {
        addReason(
          'future_effective',
          `rule "${rule.rule_id}" 嘅 effective_from (${rule.effective_from}) 喺 ${FUTURE_EFFECTIVE_DAYS} 日之後，要人確認日期冇打錯`,
        );
      }
    }
  }

  // ── 需要新舊卡對比嘅檢查 ─────────────────────────────────────────
  if (oldCard !== null) {
    const oldRules = ruleMap(oldCard.rewards);
    const newRules = ruleMap(newCard.rewards);

    // 結構變化：rule_id 新增/刪除
    for (const ruleId of newRules.keys()) {
      if (!oldRules.has(ruleId)) {
        addReason('structure_change', `新增咗 rule_id "${ruleId}"`);
      }
    }
    for (const ruleId of oldRules.keys()) {
      if (!newRules.has(ruleId)) {
        addReason('structure_change', `刪走咗 rule_id "${ruleId}"（rule_id 唔可以重用，確認係咪打錯）`);
      }
    }

    // 結構變化：帶 tier 嘅 rule 數目變咗
    const oldTiered = tieredRuleCount(oldCard.rewards);
    const newTiered = tieredRuleCount(newCard.rewards);
    if (oldTiered !== newTiered) {
      addReason('structure_change', `帶 tier 嘅 rule 數目由 ${oldTiered} 變咗 ${newTiered}`);
    }

    // 逐條配對嘅 rule 做數值比較
    for (const [ruleId, newRule] of newRules) {
      const oldRule = oldRules.get(ruleId);
      if (!oldRule) continue; // 新 rule 已經喺上面 flag 咗 structure_change

      // reward.type 變咗（例如 cash_rebate 變咗 miles）——呢個係結構性錯誤
      if (oldRule.reward.type !== newRule.reward.type) {
        addReason(
          'structure_change',
          `rule "${ruleId}" 嘅 reward.type 由 "${oldRule.reward.type}" 變咗 "${newRule.reward.type}"`,
        );
        continue; // type 都變咗，下面嘅數值比較冇意思
      }

      // rate_jump
      const oldValue = effectiveRateValue(oldRule.reward);
      const newValue = effectiveRateValue(newRule.reward);
      if (oldValue !== null && oldValue !== 0 && newValue !== null) {
        const ratio = newValue / oldValue;
        if (ratio > RATE_JUMP_UPPER || ratio < RATE_JUMP_LOWER) {
          addReason(
            'rate_jump',
            `rule "${ruleId}" 嘅有效回贈率變化 ${ratio.toFixed(2)}x（超出 ${RATE_JUMP_LOWER.toFixed(2)}–${RATE_JUMP_UPPER} 嘅合理範圍）`,
          );
        }
      }

      // confidence_upgraded
      //
      // 升做 official 係一個「主張加強」——由「我唔肯定」變成「官方確認」。呢個
      // 應該同改數值一樣受審查，但因為數值可以完全冇變，其他 GateReason 一條都
      // 唔會中，PR 表面睇落全綠。
      //
      // 真實個案（PR #66）：hsbc_everymile_general 由 unconfirmed 升做 official，
      // gate 全過、冇 label，但佢個 evidence_excerpt 自己寫住「呢個係推算值⋯⋯故
      // confidence 定 unconfirmed」，而個數值本身亦係錯（label 講「一般合資格簽賬」
      // 但官方比率表嗰個類別係 HK$5 = 1 里，唔係 HK$12.5）。
      if (oldRule.provenance.confidence !== 'official' && newRule.provenance.confidence === 'official') {
        addReason(
          'confidence_upgraded',
          `rule "${ruleId}" 嘅 confidence 由 "${oldRule.provenance.confidence}" 升做 "official"——主張加強咗，要人手確認個出處真係撐得住`,
        );
      }

      // cap_unit_changed / cap_drop
      if (oldRule.cap !== null && newRule.cap !== null) {
        if (oldRule.cap.unit !== newRule.cap.unit) {
          addReason(
            'cap_unit_changed',
            `rule "${ruleId}" 嘅 cap.unit 由 "${oldRule.cap.unit}" 變咗 "${newRule.cap.unit}"`,
          );
        } else if (oldRule.cap.value !== 0) {
          const capRatio = newRule.cap.value / oldRule.cap.value;
          if (capRatio < CAP_DROP_THRESHOLD) {
            addReason(
              'cap_drop',
              `rule "${ruleId}" 嘅 cap.value 由 ${oldRule.cap.value} 跌咗去 ${newRule.cap.value}（${(capRatio * 100).toFixed(0)}%）`,
            );
          }
        }
      }

      // official_conflict：content_hash 冇變，但 confidence 仍係 official 嘅數值變咗
      if (
        oldRule.provenance.content_hash !== null &&
        oldRule.provenance.content_hash === newRule.provenance.content_hash &&
        newRule.provenance.confidence === 'official' &&
        JSON.stringify(oldRule.reward) !== JSON.stringify(newRule.reward)
      ) {
        addReason(
          'official_conflict',
          `rule "${ruleId}" 嘅 content_hash 冇變，但 confidence 仍係 official 嘅 reward 數值變咗——嚟源內容冇變過，數值理應唔會變`,
        );
      }

      // rule 層面 source_url host 變咗
      const oldRuleHost = hostOf(oldRule.provenance.source_url);
      const newRuleHost = hostOf(newRule.provenance.source_url);
      if (oldRuleHost !== newRuleHost) {
        addReason(
          'source_moved',
          `rule "${ruleId}" 嘅 source_url host 由 "${oldRuleHost}" 變咗 "${newRuleHost}"`,
        );
      }
    }
  }

  return {
    passed: reasons.size === 0,
    reasons: [...reasons],
    details,
  };
}
