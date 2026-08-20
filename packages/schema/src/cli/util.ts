import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodError } from 'zod';

/** <root>/packages/schema/src/cli/util.ts → <root> */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const dataDir = join(repoRoot, 'data');
export const schemasDir = join(repoRoot, 'schemas');

export function rel(path: string): string {
  return relative(repoRoot, path);
}

/** 遞迴列出一個資料夾入面所有 .json，排好序，令輸出 deterministic。 */
export function listJson(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => join(dir, entry));
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${path}: ${issue.message}`;
  });
}

export function parseMode(argv: string[]): 'check' | 'write' {
  if (argv.includes('--write')) return 'write';
  if (argv.includes('--check')) return 'check';
  throw new Error('要指定 --check 或者 --write');
}
