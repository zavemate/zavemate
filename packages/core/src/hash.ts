import { createHash } from 'node:crypto';

/**
 * 內容 sha256（hex）。用嚟同 provenance.content_hash 比對，一樣就唔使餵 LLM（§6.1 步驟 4）。
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
