export function createRateLimitedFetch(fetchFn: typeof fetch, intervalMs = 300) {
  let nextAvailable = 0;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const now = Date.now();
    const delay = Math.max(0, nextAvailable - now);
    nextAvailable = now + delay + intervalMs;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return fetchFn(input, init);
  };
}
