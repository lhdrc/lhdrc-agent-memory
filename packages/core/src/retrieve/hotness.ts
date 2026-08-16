export function hotnessBoost(updatedAt: string | undefined, halfLifeDays: number, now = Date.now()): number {
  if (!updatedAt) return 0.5;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  const hl = Math.max(1, halfLifeDays);
  return Math.exp((-Math.LN2 * ageDays) / hl);
}

export const DEFAULT_HOTNESS_ALPHA = 0.15;

export function applyHotness<T extends { path: string; score: number }>(
  hits: T[],
  updatedAt: Map<string, string>,
  halfLifeDays: number,
  alpha = DEFAULT_HOTNESS_ALPHA,
): T[] {
  const a = Number.isFinite(alpha) ? alpha : DEFAULT_HOTNESS_ALPHA;
  return hits
    .map((h) => ({
      ...h,
      score: h.score * (1 + a * hotnessBoost(updatedAt.get(h.path), halfLifeDays)),
    }))
    .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
}
