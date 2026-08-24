import type { Card, RewardRule } from '@zavemate/schema';

/**
 * 將新舊 Card 之間嘅分別，翻譯做人睇得明嘅變動列表——直接放入 PR body（§9 必須做 3）
 * 同埋做 §7.2 change events 嘅原始材料（build 步驟會再加 commit/detected_at/pr）。
 */
export type ChangeType =
  | 'card_added'
  | 'card_deactivated'
  | 'card_reactivated'
  | 'rule_added'
  | 'rule_removed'
  | 'rate_changed'
  | 'cap_added'
  | 'cap_removed'
  | 'cap_changed'
  | 'effective_date_changed'
  | 'confidence_changed' // provenance.confidence 變咗（official ↔ unconfirmed ↔ crowdsourced）
  | 'field_changed'; // catch-all：annual_fee、fx_fee_rate、card_name、eligibility、match 等

export interface FieldChange {
  card_id: string;
  rule_id: string | null; // null = card 層面嘅改動
  type: ChangeType;
  field: string;
  old: unknown;
  new: unknown;
  /** 得返數值型嘅改動（例如 rate、cap.value）先有；其他一律 null。 */
  pct_change: number | null;
}

function pctChange(oldValue: number, newValue: number): number | null {
  if (oldValue === 0) return null;
  return (newValue - oldValue) / oldValue;
}

function rewardValue(rule: RewardRule): number | null {
  switch (rule.reward.type) {
    case 'cash_rebate':
      return rule.reward.rate;
    case 'points':
      return rule.reward.points_per_hkd;
    case 'miles':
      return rule.reward.hkd_per_mile;
  }
}

function ruleMap(rules: readonly RewardRule[]): Map<string, RewardRule> {
  return new Map(rules.map((rule) => [rule.rule_id, rule]));
}

/** 淺層欄位逐個比較，deep-equal 靠 JSON.stringify（呢啲欄位入面冇 function/Date，safe）。 */
function fieldChanged(oldValue: unknown, newValue: unknown): boolean {
  return JSON.stringify(oldValue) !== JSON.stringify(newValue);
}

function diffRule(cardId: string, oldRule: RewardRule, newRule: RewardRule): FieldChange[] {
  const changes: FieldChange[] = [];
  const ruleId = newRule.rule_id;

  // confidence 變咗係實質資訊，唔係 metadata 雜訊。
  //
  // 「我哋由肯定變成唔肯定」對用戶嚟講同數值改咗一樣重要——佢要知幾時唔應該
  // 再信呢個數。冇呢個 event，一條 rule 由 official 跌做 unconfirmed 會靜靜哋
  // 發生，只有睇 git log 先知。
  if (oldRule.provenance.confidence !== newRule.provenance.confidence) {
    changes.push({
      card_id: cardId,
      rule_id: newRule.rule_id,
      type: 'confidence_changed',
      field: 'provenance.confidence',
      old: oldRule.provenance.confidence,
      new: newRule.provenance.confidence,
      pct_change: null,
    });
  }

  if (oldRule.reward.type !== newRule.reward.type || fieldChanged(oldRule.reward, newRule.reward)) {
    const oldValue = rewardValue(oldRule);
    const newValue = rewardValue(newRule);
    changes.push({
      card_id: cardId,
      rule_id: ruleId,
      type: 'rate_changed',
      field: 'reward',
      old: oldRule.reward,
      new: newRule.reward,
      pct_change: oldValue !== null && newValue !== null ? pctChange(oldValue, newValue) : null,
    });
  }

  if (oldRule.cap === null && newRule.cap !== null) {
    changes.push({
      card_id: cardId,
      rule_id: ruleId,
      type: 'cap_added',
      field: 'cap',
      old: null,
      new: newRule.cap,
      pct_change: null,
    });
  } else if (oldRule.cap !== null && newRule.cap === null) {
    changes.push({
      card_id: cardId,
      rule_id: ruleId,
      type: 'cap_removed',
      field: 'cap',
      old: oldRule.cap,
      new: null,
      pct_change: null,
    });
  } else if (oldRule.cap !== null && newRule.cap !== null && fieldChanged(oldRule.cap, newRule.cap)) {
    changes.push({
      card_id: cardId,
      rule_id: ruleId,
      type: 'cap_changed',
      field: 'cap.value',
      old: oldRule.cap,
      new: newRule.cap,
      pct_change:
        oldRule.cap.unit === newRule.cap.unit ? pctChange(oldRule.cap.value, newRule.cap.value) : null,
    });
  }

  if (oldRule.effective_from !== newRule.effective_from || oldRule.effective_to !== newRule.effective_to) {
    changes.push({
      card_id: cardId,
      rule_id: ruleId,
      type: 'effective_date_changed',
      field: 'effective_from/effective_to',
      old: { effective_from: oldRule.effective_from, effective_to: oldRule.effective_to },
      new: { effective_from: newRule.effective_from, effective_to: newRule.effective_to },
      pct_change: null,
    });
  }

  const otherFields: Array<keyof RewardRule> = ['label', 'match', 'tier', 'requires_registration', 'registration_url'];
  for (const field of otherFields) {
    if (fieldChanged(oldRule[field], newRule[field])) {
      changes.push({
        card_id: cardId,
        rule_id: ruleId,
        type: 'field_changed',
        field,
        old: oldRule[field],
        new: newRule[field],
        pct_change: null,
      });
    }
  }

  return changes;
}

export function diffCards(oldCard: Card | null, newCard: Card): FieldChange[] {
  if (oldCard === null) {
    return [
      {
        card_id: newCard.card_id,
        rule_id: null,
        type: 'card_added',
        field: 'card',
        old: null,
        new: newCard.card_id,
        pct_change: null,
      },
    ];
  }

  const changes: FieldChange[] = [];

  if (oldCard.active && !newCard.active) {
    changes.push({
      card_id: newCard.card_id,
      rule_id: null,
      type: 'card_deactivated',
      field: 'active',
      old: true,
      new: false,
      pct_change: null,
    });
  } else if (!oldCard.active && newCard.active) {
    changes.push({
      card_id: newCard.card_id,
      rule_id: null,
      type: 'card_reactivated',
      field: 'active',
      old: false,
      new: true,
      pct_change: null,
    });
  }

  const cardLevelFields: Array<keyof Card> = [
    'card_name',
    'card_name_zh',
    'issuer',
    'network',
    'annual_fee',
    'annual_fee_waiver_note',
    'fx_fee_rate',
    'eligibility',
  ];
  for (const field of cardLevelFields) {
    if (fieldChanged(oldCard[field], newCard[field])) {
      changes.push({
        card_id: newCard.card_id,
        rule_id: null,
        type: 'field_changed',
        field,
        old: oldCard[field],
        new: newCard[field],
        pct_change:
          field === 'annual_fee' || field === 'fx_fee_rate'
            ? pctChange(Number(oldCard[field]), Number(newCard[field]))
            : null,
      });
    }
  }

  const oldRules = ruleMap(oldCard.rewards);
  const newRules = ruleMap(newCard.rewards);

  for (const [ruleId, newRule] of newRules) {
    const oldRule = oldRules.get(ruleId);
    if (!oldRule) {
      changes.push({
        card_id: newCard.card_id,
        rule_id: ruleId,
        type: 'rule_added',
        field: 'rewards',
        old: null,
        new: newRule,
        pct_change: null,
      });
      continue;
    }
    changes.push(...diffRule(newCard.card_id, oldRule, newRule));
  }

  for (const [ruleId, oldRule] of oldRules) {
    if (!newRules.has(ruleId)) {
      changes.push({
        card_id: newCard.card_id,
        rule_id: ruleId,
        type: 'rule_removed',
        field: 'rewards',
        old: oldRule,
        new: null,
        pct_change: null,
      });
    }
  }

  return changes;
}

/** 人睇嘅一行描述，直接放入 PR body。 */
export function describeChange(change: FieldChange): string {
  const target = change.rule_id ? `${change.card_id}/${change.rule_id}` : change.card_id;
  const pct = change.pct_change !== null ? `（${(change.pct_change * 100).toFixed(1)}%）` : '';

  switch (change.type) {
    case 'card_added':
      return `新增卡 ${change.card_id}`;
    case 'card_deactivated':
      return `${target}：active true → false`;
    case 'card_reactivated':
      return `${target}：active false → true`;
    case 'rule_added':
      return `${target}：新增 rule`;
    case 'rule_removed':
      return `${target}：刪走 rule`;
    case 'rate_changed':
      return `${target}：reward 由 ${JSON.stringify(change.old)} 變 ${JSON.stringify(change.new)}${pct}`;
    case 'cap_added':
      return `${target}：新增 cap = ${JSON.stringify(change.new)}`;
    case 'cap_removed':
      return `${target}：移除 cap（原本 ${JSON.stringify(change.old)}）`;
    case 'cap_changed':
      return `${target}：cap 由 ${JSON.stringify(change.old)} 變 ${JSON.stringify(change.new)}${pct}`;
    case 'effective_date_changed':
      return `${target}：生效日期由 ${JSON.stringify(change.old)} 變 ${JSON.stringify(change.new)}`;
    case 'confidence_changed':
      return `${target}：confidence 由 ${change.old} 變 ${change.new}`;
    case 'field_changed':
      return `${target}：${change.field} 由 ${JSON.stringify(change.old)} 變 ${JSON.stringify(change.new)}`;
  }
}
