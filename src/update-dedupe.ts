/**
 * Sliding-window in-memory dedupe shared by event handlers.
 *
 * Paperclip's core can emit duplicate `issue.updated` plugin events for a
 * single PATCH (the route's logActivity plus side-effects from heartbeat
 * reconciliation), so handlers must dedupe to avoid sending the same
 * Telegram message twice.
 */
export function makeUpdateDedupe(windowMs = 5_000, maxEntries = 500) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(key, now);
    if (seen.size > maxEntries) {
      const cutoff = now - windowMs;
      for (const [k, ts] of seen) {
        if (ts < cutoff) seen.delete(k);
      }
    }
    return true;
  };
}
