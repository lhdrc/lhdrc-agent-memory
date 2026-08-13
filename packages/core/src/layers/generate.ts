import { heuristicAbstract } from "../distill/d17-map.ts";

export const DIR_OVERVIEW_NAME = "_overview.md";
export const OVERVIEW_SIDECAR_SUFFIX = ".overview.md";

/** P5.2：派生层文件（目录摘要 / overview sidecar），豁免 L0 ADD-only。 */
export function isDerivedLayerFile(rel: string): boolean {
  const posix = rel.replace(/\\/g, "/");
  const base = posix.split("/").pop() ?? "";
  return base === DIR_OVERVIEW_NAME || base.endsWith(OVERVIEW_SIDECAR_SUFFIX);
}

export function overviewSidecarRel(nodeRel: string): string {
  const posix = nodeRel.replace(/\\/g, "/");
  return posix.replace(/\.md$/i, OVERVIEW_SIDECAR_SUFFIX);
}

/** L1 overview：保留换行，截断到 maxChars。 */
export function heuristicOverview(content: string, maxChars = 4000): string {
  const trimmed = content.replace(/\r\n/g, "\n").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

export { heuristicAbstract };
