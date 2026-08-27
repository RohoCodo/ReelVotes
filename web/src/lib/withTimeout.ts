// Small resilience helper — ported from the old site's app.js. Firestore
// reads and callable invocations can hang indefinitely on a flaky or
// unreachable connection (no built-in timeout), so anything on the critical
// render path races against a timeout and falls back to a safe default
// instead of leaving the UI stuck on a loading state forever.
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T, label = "async task"): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[reelvotes] ${label} timed out after ${timeoutMs}ms; using fallback.`);
      resolve(fallbackValue);
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        console.warn(`[reelvotes] ${label} failed; using fallback.`, error);
        resolve(fallbackValue);
      });
  });
}
