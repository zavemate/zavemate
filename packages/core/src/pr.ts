/**
 * BUILD_SPEC §6.1 步驟 7：`openPR()`。
 *
 * 直接用 GitHub REST API（fetch 包一層，冇裝 octokit——跟「唔好裝重型
 * framework」嘅精神）。用 Contents API 逐個檔 PUT 落新 branch，等 GitHub
 * 自己幫手開 commit，唔使自己砌 tree/blob/commit 呢層 git data API。
 *
 * Agent 永遠唔可以直接寫 main（§2 已定決策 3）：呢個函數淨係開 branch + PR，
 * 唔會、亦冇能力 merge——merge 靠 branch protection + CI + 人手 review。
 */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface PRFile {
  /** repo 入面嘅相對路徑，例如 data/cards/hsbc_red.json。 */
  path: string;
  /** 新內容（純文字，唔使自己 base64）。 */
  content: string;
}

export interface OpenPROptions {
  owner: string;
  repo: string;
  token: string;
  /** 預設 'main'。 */
  baseBranch?: string;
  branchName: string;
  files: PRFile[];
  title: string;
  body: string;
  labels?: string[];
}

export interface OpenPRResult {
  number: number;
  url: string;
  branchName: string;
}

const GITHUB_API = 'https://api.github.com';

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new GitHubApiError(
      `GitHub API ${init.method ?? 'GET'} ${path} 失敗：HTTP ${response.status} ${bodyText}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** GET 咗 404 就當「未存在」，其他錯照 throw。 */
async function tryGet<T>(path: string, token: string): Promise<T | null> {
  try {
    return await githubRequest<T>(path, token);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function openPR(options: OpenPROptions): Promise<OpenPRResult> {
  const baseBranch = options.baseBranch ?? 'main';
  const { owner, repo, token, branchName, files, title, body, labels } = options;

  // 1. 攞 base branch 最新 commit sha
  const baseRef = await githubRequest<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
    token,
  );
  const baseSha = baseRef.object.sha;

  // 2. 開新 branch（已經存在就跳過，等呢個函數可以安全重試）
  const existingBranch = await tryGet(`/repos/${owner}/${repo}/git/ref/heads/${branchName}`, token);
  if (existingBranch === null) {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, token, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
  }

  // 3. 逐個檔 PUT 落新 branch（Contents API 自動開 commit）
  for (const file of files) {
    const existingFile = await tryGet<{ sha: string }>(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}?ref=${branchName}`,
      token,
    );

    await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `data: 更新 ${file.path}`,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch: branchName,
        ...(existingFile ? { sha: existingFile.sha } : {}),
      }),
    });
  }

  // 4. 開 PR
  const pr = await githubRequest<{ number: number; html_url: string }>(`/repos/${owner}/${repo}/pulls`, token, {
    method: 'POST',
    body: JSON.stringify({ title, body, head: branchName, base: baseBranch }),
  });

  // 5. 加 label（唔存在嘅 label 加唔到係 GitHub 本身行為，唔好因為呢步失敗累個 PR 開唔成）
  if (labels && labels.length > 0) {
    try {
      await githubRequest(`/repos/${owner}/${repo}/issues/${pr.number}/labels`, token, {
        method: 'POST',
        body: JSON.stringify({ labels }),
      });
    } catch {
      // label 可能未喺 repo 度建立過，唔阻住個 PR 本身。
    }
  }

  return { number: pr.number, url: pr.html_url, branchName };
}
