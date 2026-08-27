/// <reference types="@cloudflare/workers-types" />

export interface Env {
  /**
   * R2 public bucket 嘅 origin（例如 https://data.zavemate.com）。
   *
   * 設咗嘅話，/v1/latest 會叫 agent 直接去嗰度拉大檔——唔經 Worker、egress
   * 免費、唔食 Worker request 額度。我哋成個架構本來就係 snapshot distribution
   * 唔係 query serving（§7.1），呢條先係設計原意嗰條路。
   *
   * 冇設就 fallback 返經 Worker 出，功能一樣，只係貴啲。
   */
  DATA_ORIGIN?: string;
  /** R2 bucket，存住 v/{sha}/* 同 changes/{year}.jsonl。 */
  SNAPSHOTS: R2Bucket;
  /** KV，存住 latest_version = {sha}。 */
  STATE: KVNamespace;
}

export const LATEST_VERSION_KEY = 'latest_version';
