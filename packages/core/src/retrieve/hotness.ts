export function hotnessBoost(updatedAt: string | undefined, halfLifeDays: number, now = Date.now()): number {
  if (!updatedAt) return 0.5;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  const hl = Math.max(1, halfLifeDays);
  return Math.exp((-Math.LN2 * ageDays) / hl);
}

export const DEFAULT_HOTNESS_ALPHA = 0.15;

/** P11.2：n=0 → 1（冷启动与现网同分）；n>0 → sigmoid(log1p(n))∈(0,1) */
export function freqFromHitCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return 1 / (1 + Math.exp(-Math.log1p(n)));
}

export function applyHotness<T extends { path: string; score: number }>(
  hits: T[],
  updatedAt: Map<string, string>,
  halfLifeDays: number,
  alpha = DEFAULT_HOTNESS_ALPHA,
  opts?: { counts?: Record<string, number>; freq?: boolean },
): T[] {
  const a = Number.isFinite(alpha) ? alpha : DEFAULT_HOTNESS_ALPHA;
  const freqOn = opts?.freq !== false;
  return hits
    .map((h) => {
      const recency = hotnessBoost(updatedAt.get(h.path), halfLifeDays);
      const n = freqOn ? (opts?.counts?.[h.path.replace(/\\/g, "/")] ?? 0) : 0;
      const freq = freqFromHitCount(n);
      return {
        ...h,
        score: h.score * (1 + a * freq * recency),
      };
    })
    .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
}
