export class RateLimiter {
  #nextAt = 0;

  constructor(intervalMs) {
    this.intervalMs = intervalMs;
  }

  async wait() {
    const now = Date.now();
    const delay = Math.max(0, this.#nextAt - now);
    this.#nextAt = Math.max(now, this.#nextAt) + this.intervalMs;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 250, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}
