import type { WriteQueue } from "../write/queue.ts";
import { patchExperienceStatus } from "../write/experience.ts";
import { findMemoryDiff, appendMemoryDiff } from "./memory-diff.ts";

export interface RevertResult {
  ok: boolean;
  reason?: string;
  path?: string;
}

/** 按 diffId 回滚经验层：experience_create → archive。 */
export async function revertMemoryDiff(
  repoRoot: string,
  brainId: string,
  diffId: string,
  queue: WriteQueue,
  by = "cli:revert",
): Promise<RevertResult> {
  const entry = await findMemoryDiff(repoRoot, brainId, diffId);
  if (!entry) return { ok: false, reason: "not_found" };

  if (entry.op === "experience_create" && entry.revert?.action === "archive_path") {
    const path = entry.revert.path;
    await patchExperienceStatus(repoRoot, path, queue, "archived", {
      archived_at: new Date().toISOString(),
      archived_by: by,
    });
    await appendMemoryDiff(repoRoot, brainId, {
      op: "experience_supersede",
      paths_written: [path],
      paths_readonly_refs: entry.paths_readonly_refs,
      decision: { revert_of: diffId },
    });
    return { ok: true, path };
  }

  if (entry.op === "experience_supersede" && entry.paths_written.length > 0) {
    const path = entry.paths_written[0]!;
    await patchExperienceStatus(repoRoot, path, queue, "active");
    return { ok: true, path };
  }

  return { ok: false, reason: "unsupported_op" };
}
