/** P12.1：openai-compatible embeddings 429/5xx 重试。 */

export const EMBED_RETRY_MAX_ATTEMPTS = 4;
export const EMBED_RETRY_BASE_MS = 200;

export function isRetryableEmbedHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function embedRetryDelayMs(failedAttemptIndex: number): number {
  return EMBED_RETRY_BASE_MS * 2 ** failedAttemptIndex;
}

export async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export type EmbedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchEmbedWithRetry(opts: {
  url: string;
  init: RequestInit;
  fetch?: EmbedFetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const max = opts.maxAttempts ?? EMBED_RETRY_MAX_ATTEMPTS;
  let last: Response | undefined;
  for (let i = 0; i < max; i++) {
    last = await doFetch(opts.url, opts.init);
    if (last.ok) return last;
    if (!isRetryableEmbedHttpStatus(last.status) || i === max - 1) return last;
    await sleep(embedRetryDelayMs(i));
  }
  return last!;
}
