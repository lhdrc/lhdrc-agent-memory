export function hotnessBoost(updatedAt: string | undefined, halfLifeDays: number, now = Date.now()): number {
  if (!updatedAt) return 0.5;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  const hl = Math.max(1, halfLifeDays);
  return Math.exp((-Math.LN2 * ageDays) / hl);
}

export const HOTNESS_WEIGHT = 0.45;

export function applyHotness<T extends { path: string; score: number }>(
  hits: T[],
  updatedAt: Map<string, string>,
  halfLifeDays: number,
): T[] {
  return hits
    .map((h) => ({
      ...h,
      score: h.score + HOTNESS_WEIGHT * hotnessBoost(updatedAt.get(h.path), halfLifeDays),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
