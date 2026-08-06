import { MemoryError, ErrorCodes } from "../errors.ts";
import { normalizeRepoPath } from "../repo/layout.ts";

/**
 * 把用户输入的 path 规范为仓内相对 POSIX path：
 * - 以 `brains/` 开头 → 按仓内路径处理（brain 必须匹配）
 * - 否则视为相对 brain 根
 */
export function resolveNodeRelPath(repoRoot: string, brainId: string, input: string): string {
  const candidate = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (candidate.startsWith("brains/")) {
    const parts = candidate.split("/");
    if (parts.length < 2) throw new MemoryError(ErrorCodes.PATH_ESCAPE, `路径无效: ${input}`);
    const inputBrain = parts[1]!;
    if (inputBrain !== brainId) {
      throw new MemoryError(ErrorCodes.USAGE, `路径指向其他 brain: ${inputBrain}`);
    }
    const rest = parts.slice(2).join("/");
    const n = normalizeRepoPath(repoRoot, brainId, rest);
    return n.rel;
  }
  const n = normalizeRepoPath(repoRoot, brainId, candidate);
  return n.rel;
}
