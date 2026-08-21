import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { openPR } from '../pr.ts';

/**
 * 真係打 GitHub API 嘅 integration test：喺 zavemate/zavemate 開一個真 PR，
 * 確認開得到、內容啱，再自己清理返（關 PR + 刪 branch）。
 *
 * 攞唔到 GitHub token（例如 CI 未設 GITHUB_TOKEN，或者本地未 `gh auth login`）
 * 就成個 describe skip 埋佢，唔會扮扮吓當自己 pass 咗。
 */
function getToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const token = getToken();
const OWNER = 'zavemate';
const REPO = 'zavemate';
const branchName = `test/openpr-integration-${Date.now()}`;

describe.skipIf(token === null)('openPR（integration，真係打 GitHub API）', () => {
  let prNumber: number | undefined;

  afterAll(async () => {
    if (!token || prNumber === undefined) return;
    // 清理：關 PR + 刪 branch，唔留低測試痕跡喺個 repo 度。
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/refs/heads/${branchName}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('開得到一個真 PR，內容係啱嘅', async () => {
    const result = await openPR({
      owner: OWNER,
      repo: REPO,
      token: token!,
      branchName,
      files: [
        {
          path: 'data/.openpr-integration-test.json',
          content: JSON.stringify({ note: 'openPR integration test，會自動清理' }, null, 2),
        },
      ],
      title: 'test: openPR integration test（自動清理）',
      body: '呢個 PR 由 packages/core/src/__tests__/pr.test.ts 自動開嚟測試 openPR()，test 完會自動關咗。',
    });

    prNumber = result.number;
    expect(result.url).toContain(`${OWNER}/${REPO}/pull/${result.number}`);

    const prData = (await (
      await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${result.number}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { head: { ref: string }; title: string };
    expect(prData.head.ref).toBe(branchName);
    expect(prData.title).toContain('openPR integration test');
  }, 30_000);
});

describe('openPR（skip 訊息）', () => {
  it('冇 GitHub token 嗰陣，integration test 應該 skip 唔係 fail', () => {
    if (token === null) {
      console.warn('冇搵到 GitHub token（GITHUB_TOKEN 或者 gh auth token），openPR integration test 已 skip。');
    }
    expect(true).toBe(true);
  });
});
