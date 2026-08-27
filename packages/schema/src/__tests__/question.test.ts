import { describe, expect, it } from 'vitest';
import { Question, questionId } from '../question.ts';

function question(overrides: Record<string, unknown> = {}) {
  return {
    question_id: 'demo_card_online_value_conflict',
    card_id: 'demo_card',
    rule_id: 'demo_card_online',
    kind: 'value_conflict',
    status: 'open',
    question: '官方寫 3.8% 但我哋記錄 4%，邊個啱？',
    evidence: 'you earn 3.8% CashBack on online spending',
    source_url: 'https://www.example-bank.com.hk/cards/demo',
    raised_at: '2026-08-27T04:00:00.000Z',
    raised_by: 'evidence_repair',
    answer: null,
    answered_at: null,
    ...overrides,
  };
}

describe('Question', () => {
  it('接受一條 open question', () => {
    expect(Question.parse(question()).status).toBe('open');
  });

  it('status 有 default（open）', () => {
    const { status: _s, ...noStatus } = question();
    expect(Question.parse(noStatus).status).toBe('open');
  });

  it('question 要係一句可以答嘅嘢，唔可以係空', () => {
    expect(() => Question.parse(question({ question: '' }))).toThrow();
  });

  it('未知 kind 唔收（四種跟進方法唔同，唔可以亂加）', () => {
    expect(() => Question.parse(question({ kind: '有啲問題' }))).toThrow();
  });

  it('多咗欄位唔收', () => {
    expect(() => Question.parse({ ...question(), extra: 1 })).toThrow();
  });
});

describe('questionId', () => {
  it('{rule_id}_{kind}——決定性，所以同一條 rule 同一種問題唔會開兩次', () => {
    expect(questionId('sc_smart_designated', 'expressiveness')).toBe('sc_smart_designated_expressiveness');
  });

  it('同一輸入永遠同一 id', () => {
    expect(questionId('a', 'value_conflict')).toBe(questionId('a', 'value_conflict'));
  });

  it('唔同 kind 唔同 id（同一條 rule 可以有幾種唔同問題）', () => {
    expect(questionId('a', 'value_conflict')).not.toBe(questionId('a', 'source_unreadable'));
  });
});
