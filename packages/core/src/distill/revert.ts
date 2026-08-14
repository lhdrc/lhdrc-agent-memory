import type { WriteQueue } from "../write/queue.ts";
import { patchExperienceStatus, restoreExperienceSnapshot } from "../write/experience.ts";
import { patchSkill } from "../write/skill.ts";
import { findMemoryDiff, appendMemoryDiff } from "./memory-diff.ts";

export interface RevertResult {
  ok: boolean;
  reason?: string;
  path?: string;
  op?: string;
}

const SUPPORTED_OPS = "experience_create|experience_supersede|experience_merge|skill_create|noop";

/** 按 diffId 回滚经验/技能层（P2.2 + P7.5）。 */
export async function revertMemoryDiff(
  repoRoot: string,
  brainId: string,
  diffId: string,
  queue: WriteQueue,
  by = "cli:revert",
): Promise<RevertResult> {
  const entry = await findMemoryDiff(repoRoot, brainId, diffId);
  if (!entry) return { ok: false, reason: "not_found" };

  if (entry.op === "noop") {
    return { ok: true, reason: "already_noop", op: "noop" };
  }

  if (entry.op === "experience_create" && entry.revert?.action === "archive_path") {
    const path = entry.revert.path ?? entry.paths_written[0];
    if (!path) return { ok: false, reason: "unsupported_op", op: entry.op };
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
    return { ok: true, path, op: entry.op };
  }

  if (entry.op === "experience_supersede" && entry.paths_written.length > 0) {
    const path = entry.paths_written[0]!;
    await patchExperienceStatus(repoRoot, path, queue, "active");
    return { ok: true, path, op: entry.op };
  }

  if (entry.op === "experience_merge") {
    if (entry.revert?.action !== "restore_snapshot" || !entry.revert.snapshot) {
      return { ok: false, reason: "unsupported_op", op: entry.op };
    }
    const path = entry.revert.path ?? entry.paths_written[0];
    if (!path) return { ok: false, reason: "unsupported_op", op: entry.op };
    await restoreExperienceSnapshot(repoRoot, path, queue, entry.revert.snapshot);
    await appendMemoryDiff(repoRoot, brainId, {
      op: "experience_merge",
      paths_written: [path],
      paths_readonly_refs: entry.paths_readonly_refs,
      decision: { revert_of: diffId },
    });
    return { ok: true, path, op: entry.op };
  }

  if (entry.op === "skill_create" && entry.revert?.action === "archive_path") {
    const path = entry.revert.path ?? entry.paths_written[0];
    if (!path) return { ok: false, reason: "unsupported_op", op: entry.op };
    await patchSkill(repoRoot, path, queue, { status: "archived" });
    await appendMemoryDiff(repoRoot, brainId, {
      op: "skill_archive",
      paths_written: [path],
      paths_readonly_refs: entry.paths_readonly_refs,
      decision: { revert_of: diffId },
    });
    return { ok: true, path, op: entry.op };
  }

  return { ok: false, reason: "unsupported_op", op: entry.op };
}

export function revertUnsupportedMessage(op?: string): string {
  return `无法回滚${op ? `（op=${op}）` : ""}：支持 ${SUPPORTED_OPS}`;
}
