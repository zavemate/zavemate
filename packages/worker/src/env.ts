/// <reference types="@cloudflare/workers-types" />

export interface Env {
  /** R2 bucket，存住 v/{sha}/* 同 changes/{year}.jsonl。 */
  SNAPSHOTS: R2Bucket;
  /** KV，存住 latest_version = {sha}。 */
  STATE: KVNamespace;
}

export const LATEST_VERSION_KEY = 'latest_version';
