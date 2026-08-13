function parentDir(path: string): string {
  const posix = path.replace(/\\/g, "/");
  const i = posix.lastIndexOf("/");
  return i < 0 ? posix : posix.slice(0, i);
}

export interface DirectoryPrefilterExplain {
  dirs: Array<{ dir: string; score: number }>;
  applied: true;
}

/**
 * 按父目录聚合分，高分目录的命中提前（软预筛，不丢结果）。
 */
export function applyDirectoryPrefilter<T extends { path: string; score: number }>(
  hits: T[],
): { hits: T[]; explain: DirectoryPrefilterExplain } {
  const dirScore = new Map<string, number>();
  for (const h of hits) {
    const d = parentDir(h.path);
    dirScore.set(d, (dirScore.get(d) ?? 0) + h.score);
  }
  const dirs = [...dirScore.entries()]
    .map(([dir, score]) => ({ dir, score }))
    .sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  const rank = new Map(dirs.map((d, i) => [d.dir, i]));
  const next = [...hits].sort((a, b) => {
    const ra = rank.get(parentDir(a.path)) ?? 99;
    const rb = rank.get(parentDir(b.path)) ?? 99;
    if (ra !== rb) return ra - rb;
    return b.score - a.score || a.path.localeCompare(b.path);
  });
  return { hits: next, explain: { dirs: dirs.slice(0, 8), applied: true } };
}
