import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeepSeekProvider } from '../deepseek.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(): () => Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse(String((init as RequestInit).body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"rules":[]}' } }],
        model: 'deepseek-chat',
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      { status: 200 },
    );
  });
  return () => captured;
}

describe('createDeepSeekProvider', () => {
  it('一定要送 temperature: 0——條款抽取唔係創作，同一份 T&C 要永遠得同一個答案', async () => {
    const body = stubFetch();
    await createDeepSeekProvider('fake-key').extractJson({ systemPrompt: 'sys', userContent: 'doc' });
    expect(body().temperature).toBe(0);
  });

  it('送 json_object response_format', async () => {
    const body = stubFetch();
    await createDeepSeekProvider('fake-key').extractJson({ systemPrompt: 'sys', userContent: 'doc' });
    expect(body().response_format).toEqual({ type: 'json_object' });
  });
});
