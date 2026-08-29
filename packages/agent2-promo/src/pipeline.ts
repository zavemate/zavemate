import { assessExtraction, extractMainContent, FetchError, fetchSource, sha256 } from '@zavemate/core';
import type { Source } from '@zavemate/schema';
import { buildPromoSystemPrompt, type ExistingPromotion, PromoExtractionResult } from './extraction.ts';
import { feedPageUrl, parseFeedItems, selectFeedWork } from './feed.ts';

/**
 * §6.1 共用流程，同 Agent 1 一樣：
 * fetch → extractMainContent → 抽取薄唔薄 → sha256 → hash 短路 → callLLM → 驗證。
 *
 * 分別喺 hash 短路嘅意義：Agent 1 短路 = 「呢條 rule 冇變」；Agent 2 短路 =
 * 「呢版冇新優惠出現，亦冇舊優惠改過」。後者慳嘅唔止 token——優惠頁通常好長，
 * 唔短路嘅話每次跑都要餵成版嘢。
 */
export interface PromoLLMProvider {
  name: string;
  extractJson(input: { systemPrompt: string; userContent: string }): Promise<{
    data: unknown;
    usage: { tokensIn: number; tokensOut: number; costUsd: number; model: string };
  }>;
}

/**
 * 一次抽取：餵咗咩落 LLM，同埋佢交返咩。
 *
 * 要孭住 `sourceText` 係因為 apply 嗰邊要驗發卡行——`evidence_excerpt` 係
 * LLM 自己揀嗰一兩句，成日啱好冇提發卡行（實測「SC Pay 每月免手續費套現」
 * 就係噉被誤擋）。整篇原文先係完整嘅 haystack。
 *
 * 一定要**逐篇**孭，唔可以成個 feed 夾埋一嚿：feed 入面有滙豐嘅文，夾埋之後
 * 任何一條 promotion 都搵到「滙豐」，個 guard 就等於冇。
 */
export interface ExtractionBatch {
  sourceText: string;
  promotions: PromoExtractionResult['promotions'];
}

export type PromoPipelineOutcome =
  | { kind: 'fetch_failed'; error: FetchError }
  | { kind: 'extraction_too_thin'; reason: string }
  | { kind: 'unchanged'; contentHash: string }
  | {
      kind: 'extracted';
      contentHash: string;
      /** 逐篇分開——每個 batch 記住自己嗰篇原文。 */
      batches: ExtractionBatch[];
      usage: Array<{ tokensIn: number; tokensOut: number; costUsd: number; model: string }>;
      /**
       * Feed 專用：剪剩 feed 而家仲有嗰批 guid 嘅 hash map，直接寫返落
       * `sources.json`。唔喺度嘅 guid（抽取太薄、今次跑唔切）特登唔寫，
       * 下次會再試——寫咗就等於話「呢篇睇過」，但其實冇。
       */
      itemHashes?: Record<string, string>;
      /** Feed 專用：逐篇嘅處理結果，原封不動擺落 PR body。 */
      itemNotes?: string[];
    };

export interface PromoPipelineInput {
  source: Source;
  /** 淨係測試用——唔提供就打真網絡。 */
  fetchFn?: typeof fetchSource;
  cards: Array<{ card_id: string; card_name: string; issuer: string }>;
  existing: ExistingPromotion[];
  today: string;
  provider: PromoLLMProvider;
}

export async function runPromoPipeline(input: PromoPipelineInput): Promise<PromoPipelineOutcome> {
  let fetched;
  try {
    fetched = await (input.fetchFn ?? fetchSource)(input.source.url, input.source.render_mode);
  } catch (error) {
    if (error instanceof FetchError) return { kind: 'fetch_failed', error };
    throw error;
  }

  if (input.source.feed_format === 'rss') {
    return runFeedPipeline(input, fetched.content);
  }

  const content = extractMainContent(fetched.content);

  // 擺喺 hash 短路之前：穩定嘅抽取失敗（例如圖片型 PDF 每次都俾同樣嗰幾十字）
  // 會 hash 對得上、判 unchanged，然後我哋就當「呢版冇新優惠」——實情係我哋
  // 由頭到尾未讀過佢。
  const assessment = assessExtraction(content);
  if (assessment.tooThin) return { kind: 'extraction_too_thin', reason: assessment.reason! };

  const contentHash = sha256(content);
  if (input.source.content_hash !== null && contentHash === input.source.content_hash) {
    return { kind: 'unchanged', contentHash };
  }

  const systemPrompt = buildPromoSystemPrompt({
    sourceLabel: input.source.label,
    sourceType: input.source.source_type,
    cards: input.cards,
    existing: input.existing,
    today: input.today,
  });

  const llm = await input.provider.extractJson({ systemPrompt, userContent: content });
  const parsed = PromoExtractionResult.safeParse(llm.data);
  if (!parsed.success) {
    // 唔重試升級 provider（Agent 1 嗰套）——Agent 2 抽唔到就係抽唔到，
    // 一版優惠頁冇嘢比一版優惠頁有錯嘢好。
    throw new Error(`LLM 回覆唔符合 schema：${parsed.error.message}`);
  }

  return {
    kind: 'extracted',
    contentHash,
    batches: [{ sourceText: content, promotions: parsed.data.promotions }],
    usage: [llm.usage],
  };
}

/**
 * Feed 版流程：一頁一頁揭 → 逐篇 hash 短路 → 逐篇抽取。
 *
 * **特登冇「成個 feed hash 冇變就收工」呢個快速閘。**加咗嘅話會出一個死角：
 * 第一次跑撞正 `feed_max_pages` 上限收咗手，之後就算我哋提高個上限，只要第一頁
 * 一個字冇改過就永遠唔會再揭落去——啲舊文由頭到尾冇人讀過，而 sources.json
 * 望落好正常。慳返嘅只係一兩個 HTTP request，換一個永遠唔會浮上水面嘅漏洞，
 * 唔抵。
 *
 * 短路完全交俾逐篇嘅 `item_hashes`：揭到一整頁都係睇過而且冇改過就停。Feed
 * 按時間倒序，所以再深嘅只會更舊。穩定狀態通常揭兩頁。
 */
async function runFeedPipeline(input: PromoPipelineInput, firstPageXml: string): Promise<PromoPipelineOutcome> {
  const firstPageText = extractMainContent(firstPageXml);

  const assessment = assessExtraction(firstPageText);
  if (assessment.tooThin) return { kind: 'extraction_too_thin', reason: assessment.reason! };

  if (parseFeedItems(firstPageXml).length === 0) {
    // 聲明咗係 rss 但拆唔出 item = 我哋讀緊嘅根本唔係嗰個 feed（改版、錯誤頁、
    // WAF 攔截頁）。當抽取失敗好過當「今期冇優惠」。
    return {
      kind: 'extraction_too_thin',
      reason: `聲明咗 feed_format: rss，但拆唔出任何 <item>（${firstPageText.length} 個字元）`,
    };
  }

  const itemHashes: Record<string, string> = {};
  const itemNotes: string[] = [];
  let walkComplete = true;
  const batches: ExtractionBatch[] = [];
  const usage: Array<{ tokensIn: number; tokensOut: number; costUsd: number; model: string }> = [];

  for (let page = 1; page <= input.source.feed_max_pages; page += 1) {
    let xml = firstPageXml;
    if (page > 1) {
      try {
        xml = (await (input.fetchFn ?? fetchSource)(feedPageUrl(input.source.url, page), input.source.render_mode)).content;
      } catch (error) {
        if (!(error instanceof FetchError)) throw error;
        // 第一頁讀到就唔算 fetch_failed——已經抽到嘅嘢照入，淨係唔再揭落去。
        itemNotes.push(`⚠️ 第 ${page} 頁讀唔到（${error.message}），停咗喺呢度`);
        walkComplete = false;
        break;
      }
    }

    const items = parseFeedItems(xml);
    if (items.length === 0) break; // 揭到冇嘢，即係到底

    const work = selectFeedWork(items, input.source.item_hashes);
    Object.assign(itemHashes, work.carried);
    itemNotes.push(`── 第 ${page} 頁：${work.notes[0]}`);
    itemNotes.push(...work.notes.slice(1));

    for (const { item, text, hash } of work.toProcess) {
      const systemPrompt = buildPromoSystemPrompt({
        sourceLabel: `${input.source.label}／${item.title}`,
        sourceType: input.source.source_type,
        cards: input.cards,
        existing: input.existing,
        today: input.today,
      });

      const llm = await input.provider.extractJson({ systemPrompt, userContent: text });
      const parsed = PromoExtractionResult.safeParse(llm.data);
      if (!parsed.success) {
        throw new Error(`LLM 回覆唔符合 schema（${item.guid}）：${parsed.error.message}`);
      }

      usage.push(llm.usage);
      batches.push({ sourceText: text, promotions: parsed.data.promotions });
      // 抽取成功先寫 hash。中途 throw 嘅話成個 run 都冇 PR，下次由頭嚟過。
      itemHashes[item.guid] = hash;
      itemNotes.push(`📄 ${item.title}：抽到 ${parsed.data.promotions.length} 個優惠`);
    }

    if (work.allKnown) {
      if (page < input.source.feed_max_pages) itemNotes.push(`第 ${page} 頁全部睇過，唔再揭落去`);
      break;
    }
  }

  // 有一頁讀唔到就一條 hash 都唔好寫。
  //
  // 2026-08-27 撞到：第 2 頁 fetch 超時，第 1 頁 12 篇正常讀晒。如果照寫第 1 頁
  // 嘅 hash，下次跑第 1 頁全部命中 → allKnown → 停——**第 2 頁永遠唔會再揭**，
  // 而佢從來未成功讀過。sources.json 望落一切正常，但有一頁由頭到尾冇人讀過。
  //
  // 代價係下次要重讀第 1 頁（約 $0.012）。同「一頁優惠靜靜哋唔存在」比，抵。
  // 抽到嘅優惠照入——嗰啲係真嘢，唔關 hash 記帳事。
  if (!walkComplete) {
    itemNotes.push('⚠️ 今次揭唔完，所以一條 item hash 都冇寫——下次由第一頁重新讀');
  }
  return {
    kind: 'extracted',
    contentHash: sha256(firstPageText),
    batches,
    usage,
    itemHashes: walkComplete ? itemHashes : undefined,
    itemNotes,
  };
}
