import { evidenceSupportedBy } from '@zavemate/core';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LLMProvider } from './llm.ts';

/**
 * 修復模式——同監察唔同。
 *
 * 監察問嘅係「呢個數字有冇變」；修復問嘅係「呢個數字究竟有冇原文撐住」。
 * 需要修復嘅係一批已經喺 repo 入面、但 evidence_excerpt 對唔上出處嘅 rule：
 * 好多時個數值本身啱，只係當初嗰段引文被改寫過、或者由表格壓平成文字。
 *
 * ⚠️ 呢度最重要嘅一件事：LLM 提出嘅引文會被**機器驗證**。
 *
 * 佢話「原文寫住 X」，我哋即刻 check X 係咪真係逐字出現喺原文。驗唔過就唔算
 * 提議——所以佢作唔到假。呢個係成個修復流程可以信得過嘅唯一理由：人只需要
 * 判斷「呢句原文撐唔撐得住呢個數字」，唔使再自己去搵句嘢。
 */
export const EvidenceProposal = z.strictObject({
  /**
   * supported   原文有句嘢直接撐住呢個數值
   * unsupported 原文講嘅嘢同呢個數值唔一致
   * absent      原文根本冇提過呢件事
   */
  verdict: z.enum(['supported', 'unsupported', 'absent']),
  /** verdict = supported 嗰陣：由原文一字不改抄返出嚟嘅句子。 */
  excerpt: z.string().max(500).nullable(),
  /** verdict = unsupported 嗰陣：原文實際講緊咩（一樣要一字不改）。 */
  contradicting_excerpt: z.string().max(500).nullable(),
  /** 一兩句人話，解釋你點解咁判斷。 */
  reasoning: z.string().max(400),
});
export type EvidenceProposal = z.infer<typeof EvidenceProposal>;

export interface RepairInput {
  ruleId: string;
  label: string;
  /** 人睇嘅數值描述，例如「HK$6 = 1 里」或者「1.5%」。 */
  valueDescription: string;
  currentEvidence: string | null;
  sourceText: string;
  provider: LLMProvider;
}

export interface RepairResult {
  ruleId: string;
  proposal: EvidenceProposal;
  /** 佢提出嘅引文係咪真係逐字喺原文入面。false = 佢作嘅，唔可以信。 */
  excerptVerified: boolean;
  usage: { tokensIn: number; tokensOut: number; costUsd: number; model: string };
}

export function buildRepairPrompt(
  input: Omit<RepairInput, 'provider' | 'sourceText'> & { rejected?: string | null },
): string {
  return `你係一個信用卡條款核實員。以下係一份官方條款文件嘅內容。

我哋記錄咗一條回贈規則：
- 描述：${input.label}
- 我哋記錄嘅數值：${input.valueDescription}
- 我哋記錄嘅出處引文（⚠️ 呢段係**錯**嘅）：${input.currentEvidence ?? '（冇）'}

嗰段引文喺呢份文件入面**逐字搵唔返**——可能係當初抄嗰陣改寫咗、或者由一個表格壓平成文字。
所以**唔好將佢抄返俾我**。抄返佢等於冇答過。你要自己喺下面份文件搵。${input.rejected ? `

你上次答咗呢段，但佢一樣喺文件入面搵唔返，所以都唔啱——唔好再交同一段或者近似嘅嘢：
${input.rejected}` : ''}

你要做嘅係：喺呢份文件入面，搵返**真正撐住呢個數值**嘅原文。

規則：

1. excerpt 一定要**一字不改**由文件抄返出嚟。你抄完之後我哋會用程式逐字比對——
   對唔上就當你冇提議過。所以唔好整理、唔好翻譯、唔好加標點、唔好將表格砌成句子。
2. 如果嗰個數值散落喺一個表格入面，冇任何一句連續文字撐得住佢，verdict 填
   "absent"，excerpt 填 null，然後喺 reasoning 講明「數值喺表格入面，冇連續原文」。
   **唔好夾硬拼一句出嚟。**
3. 如果文件講嘅數值同我哋記錄嘅唔一致，verdict 填 "unsupported"，喺
   contradicting_excerpt 一字不改抄返文件實際講嗰句。
4. 唔肯定就揀 "absent"。講唔到唔係失敗——作一句假嘢先係。

用 JSON 回覆，一定要符合以下 JSON Schema：
${JSON.stringify(zodToJsonSchema(EvidenceProposal), null, 2)}`;
}

export async function proposeEvidence(input: RepairInput): Promise<RepairResult> {
  const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0, model: '' };
  let rejected: string | null = null;
  let last: { proposal: EvidenceProposal; verified: boolean } | null = null;

  // 最多試兩次。第一次驗唔過通常係因為佢將我哋嗰段錯引文抄返——第二次會明確
  // 話返俾佢知嗰段唔啱。仲係驗唔過就唔再試：作嘢作兩次唔會變真。
  for (let attempt = 0; attempt < 2; attempt++) {
    const systemPrompt = buildRepairPrompt({ ...input, rejected });
    const llm = await input.provider.extractJson({ systemPrompt, userContent: input.sourceText });
    usage.tokensIn += llm.usage.tokensIn;
    usage.tokensOut += llm.usage.tokensOut;
    usage.costUsd += llm.usage.costUsd;
    usage.model = llm.usage.model;

    const proposal = EvidenceProposal.parse(llm.data);
    // 機器驗證：佢話原文有呢句，就真係去原文搵。呢步係成件事可以信嘅原因。
    const claimed = proposal.verdict === 'unsupported' ? proposal.contradicting_excerpt : proposal.excerpt;
    const verified = claimed === null ? false : evidenceSupportedBy(input.sourceText, claimed);

    last = { proposal, verified };
    // absent 係一個合法答案（數值散喺表格入面），冇引文要驗，唔使重試。
    if (verified || proposal.verdict === 'absent') break;
    rejected = claimed;
  }

  return { ruleId: input.ruleId, proposal: last!.proposal, excerptVerified: last!.verified, usage };
}
