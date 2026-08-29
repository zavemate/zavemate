/**
 * Agent PR body 嘅拼裝。
 *
 * 兩個 agent 本來各有一份幾乎一樣嘅字串拼裝，inline 喺自己個 orchestrator
 * 入面（agent1 ~40 行、agent2 ~20 行）。兩份已經開始飄——同一個「⚠️ 需要
 * 人手覆核」段落，一份喺成本前面、一份喺後面；空段落嘅處理都各寫一次。
 *
 * PR body 唔係裝飾品。零改動嘅 PR 會自動 merge，所以**呢段字係人唯一會睇到
 * 嘅嘢**——「查過冇嘢」同「冇查過」要喺度分得出。所以佢值得有自己一個
 * 有 test 嘅模組，唔係喺 orchestrator 尾巴順手 join 幾個 array。
 */

export interface ReportSection {
  /** 例如「改動」「⚠️ 需要人手覆核」。 */
  heading: string;
  /** 標題下面、清單上面嗰段解釋。冇就唔出。 */
  intro?: string;
  /** 每項自動加 `- ` 前綴。空 array = 成個段落唔出。 */
  items: string[];
}

export interface PRBodyInput {
  /** 最頂嗰行，例如「自動核實」。會自動加粗同接上日期。 */
  title: string;
  /** 香港日期 yyyy-mm-dd。 */
  date: string;
  sections: ReportSection[];
  /** 總 LLM 成本。BUILD_SPEC 要求每次跑都要寫入 PR body。 */
  totalCostUsd: number;
}

/**
 * 空段落一律唔出。
 *
 * 例外係成本——就算 $0 都要寫，因為「$0」本身係一個結果（全部 hash 短路），
 * 唔係「冇資料」。呢個分別喺 acceptance 入面明文要求驗。
 */
export function buildPRBody(input: PRBodyInput): string {
  const lines: string[] = [`**${input.title} —— ${input.date}**`];

  for (const section of input.sections) {
    if (section.items.length === 0) continue;
    lines.push('', `### ${section.heading}`);
    if (section.intro) lines.push(section.intro);
    lines.push(...section.items.map((item) => `- ${item}`));
  }

  lines.push('', '### 成本', `- 總 LLM cost：$${input.totalCostUsd.toFixed(4)}`);
  return lines.join('\n');
}
