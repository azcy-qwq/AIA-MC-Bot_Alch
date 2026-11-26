export const DISTRIBUTION_LEAD_MS = 4000;

// Estimates are based on measured progress, never a fixed percentage cutoff.
export function estimateWorkRemainingMs({ elapsedMs, remaining, gained, mined, maxBlocks, deadlineRemainingMs }) {
  const estimates = [Math.max(0, deadlineRemainingMs)];
  if (remaining <= 0) return 0;
  if (elapsedMs > 0 && gained > 0) estimates.push(elapsedMs * remaining / gained);
  if (elapsedMs > 0 && mined > 0) estimates.push(elapsedMs * Math.max(0, maxBlocks - mined) / mined);
  return Math.min(...estimates);
}

export function workRemainingMs(progress, now = Date.now()) {
  if (!Number.isFinite(progress?.estimatedRemainingMs) || !Number.isFinite(progress?.estimatedAt)) return null;
  return Math.max(0, progress.estimatedRemainingMs - Math.max(0, now - progress.estimatedAt));
}
