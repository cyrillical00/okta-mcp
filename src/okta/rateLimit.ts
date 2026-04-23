import logger from '../logger.js';

const MAX_CONCURRENT = 8;
let _active = 0;
const _queue: Array<() => void> = [];

function acquire(): Promise<void> {
  return new Promise(resolve => {
    if (_active < MAX_CONCURRENT) {
      _active++;
      resolve();
    } else {
      _queue.push(() => { _active++; resolve(); });
    }
  });
}

function release(): void {
  _active--;
  const next = _queue.shift();
  if (next) next();
}

export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function extractRetryAfter(err: unknown): number | undefined {
  const e = err as { headers?: Record<string, string>; status?: number };
  if (e.status !== 429) return undefined;
  const header = e.headers?.['x-rate-limit-reset'] ?? e.headers?.['retry-after'];
  if (!header) return 60;
  const resetEpoch = parseInt(header, 10);
  if (isNaN(resetEpoch)) return 60;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(1, resetEpoch - now);
}

export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withRateLimit(fn);
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 429 && attempt < maxAttempts) {
        const retryAfter = extractRetryAfter(err) ?? 60;
        logger.warn({ attempt, retryAfter }, 'Rate limited, backing off');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
