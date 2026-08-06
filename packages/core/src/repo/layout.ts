import { join, resolve, isAbsolute, sep } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";

export function brainsRoot(repoRoot: string): string {
  return join(repoRoot, "brains");
}

export function resolveBrainRoot(repoRoot: string, brainId: string): string {
  return join(brainsRoot(repoRoot), brainId);
}

export function resolveSourceRoot(repoRoot: string, brainId: string, sourceId: string): string {
  return join(repoRoot, "brains", brainId, "sources", sourceId);
}

export function brainPrefix(repoRoot: string, brainId: string): string {
  return resolve(join(repoRoot, "brains", brainId));
}

export function assertUnderPrefix(fullPath: string, prefix: string): void {
  const resolved = resolve(fullPath);
  const resolvedPrefix = resolve(prefix);
  if (resolved !== resolvedPrefix && !resolved.startsWith(resolvedPrefix + sep)) {
    throw new MemoryError(
      ErrorCodes.PATH_ESCAPE,
      `路径越界: ${resolved} 不在允许前缀 ${resolvedPrefix} 内`,
    );
  }
}

export interface NormalizedRepoPath {
  /** 相对 repo 根的 POSIX 路径，如 brains/default/sources/default/issues/general/decisions/1-x.md */
  rel: string;
  /** 解析后的绝对路径 */
  abs: string;
}

/**
 * 将用户提供的相对 path（相对 brain 根）规范为仓内相对 POSIX path。
 * 禁止 `..`、绝对路径；结果必须落在 brains/{brainId}/ 之下。
 */
export function normalizeRepoPath(repoRoot: string, brainId: string, candidate: string): NormalizedRepoPath {
  if (isAbsolute(candidate)) {
    throw new MemoryError(ErrorCodes.PATH_ESCAPE, `绝对路径不允许: ${candidate}`);
  }
  const posix = candidate.replace(/\\/g, "/");
  const parts = posix.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new MemoryError(ErrorCodes.PATH_ESCAPE, `路径含 .. 越界: ${candidate}`);
  }
  const rel = ["brains", brainId, ...parts].join("/");
  const abs = resolve(repoRoot, "brains", brainId, ...parts);
  assertUnderPrefix(abs, brainPrefix(repoRoot, brainId));
  return { rel, abs };
}
