import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { serializeFrontmatter, parseFrontmatter } from "../frontmatter.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "./executor.ts";
import {
  validateExperienceWrite,
  type ExperienceWriteInput,
} from "./experience-validator.ts";
import type { NormalizedExperienceWrite } from "./types.ts";

export type { ExperienceWriteInput } from "./experience-validator.ts";
export { generateExperienceId, validateExperienceWrite } from "./experience-validator.ts";

export type MergeOp = "immutable" | "append" | "patch";

/** P9.9：蒸馏 experience_merge 读取 pack.merge_op.experience（fallback lesson → append）。 */
export function resolveExperienceMergeOp(pack: { merge_op?: Record<string, string> }): MergeOp {
  const raw = pack.merge_op?.experience ?? pack.merge_op?.lesson ?? "append";
  if (raw === "immutable" || raw === "append" || raw === "patch") return raw;
  console.warn(`[P9.9] unknown merge_op.experience "${raw}", treating as append`);
  return "append";
}

/** 校验并写入 experience md（经 WriteQueue，路径 experiences/）。 */
export async function writeExperience(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  input: ExperienceWriteInput,
): Promise<string> {
  const result = validateExperienceWrite(repoRoot, pack, input);
  if (!result.ok) {
    throw new MemoryError(result.code!, result.errors!.map((e) => `${e.field}: ${e.message}`).join("; "), {
      errors: result.errors,
    });
  }
  const n = result.normalized!;
  await queue.execute(
    async () => {
      const abs = join(repoRoot, n.path);
      if (existsSync(abs)) {
        throw new MemoryError(ErrorCodes.CONFLICT, `路径已存在（TOCTOU 复查）: ${n.path}`);
      }
      await mkdirp(dirname(abs));
      await writeFile(abs, serializeFrontmatter(n.frontmatter, n.body), "utf8");
      return [n.path];
    },
    `experience create ${n.pathFromBrain}`,
  );
  return n.path;
}

/** 更新已有 experience 的 status（如 supersede）。 */
export async function patchExperienceStatus(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  status: "active" | "superseded" | "archived",
  extra?: Record<string, unknown>,
): Promise<string> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `experience 不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  if (extra) Object.assign(data, extra);
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    return [relPath];
  }, `experience ${status} ${relPath}`);
  return relPath;
}

/** 字段级 merge（procedure/boundary/trigger/body）；默认 append，patch 覆盖非空字段。 */
export async function mergeExperienceFields(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  patch: {
    procedure?: string;
    boundary?: string;
    trigger?: string;
    bodyAppend?: string;
    supersedes?: string[];
  },
  opts?: { mode?: "append" | "patch" },
): Promise<string> {
  const mode = opts?.mode ?? "append";
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `experience 不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  if (patch.procedure) {
    if (mode === "patch") {
      data.procedure = patch.procedure;
    } else {
      const prev = String(data.procedure ?? "");
      data.procedure = prev ? `${prev}\n\n${patch.procedure}` : patch.procedure;
    }
  }
  if (patch.boundary) {
    if (mode === "patch") {
      data.boundary = patch.boundary;
    } else {
      const prev = String(data.boundary ?? "");
      data.boundary = prev ? `${prev}\n\n${patch.boundary}` : patch.boundary;
    }
  }
  if (patch.trigger) {
    if (mode === "patch") {
      data.trigger = patch.trigger;
    } else {
      const prev = String(data.trigger ?? "");
      data.trigger = prev ? `${prev}\n\n${patch.trigger}` : patch.trigger;
    }
  }
  if (patch.supersedes?.length) {
    const prev = Array.isArray(data.supersedes) ? (data.supersedes as string[]) : [];
    data.supersedes = [...new Set([...prev, ...patch.supersedes])];
  }
  const version = Number(data.version ?? 1) + 1;
  data.version = version;
  const newBody =
    patch.bodyAppend != null && patch.bodyAppend !== ""
      ? mode === "patch"
        ? patch.bodyAppend
        : `${body}\n\n${patch.bodyAppend}`
      : body;
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, newBody), "utf8");
    return [relPath];
  }, `experience merge ${relPath}`);
  return relPath;
}

/** P7.5：按 merge 前快照覆写 procedure/boundary/body/status。 */
export async function restoreExperienceSnapshot(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  snapshot: { procedure?: string; boundary?: string; body?: string; status?: string },
): Promise<string> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `experience 不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  if (snapshot.procedure != null) data.procedure = snapshot.procedure;
  if (snapshot.boundary != null) data.boundary = snapshot.boundary;
  if (snapshot.status != null) data.status = snapshot.status;
  const nextBody = snapshot.body != null ? snapshot.body : body;
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, nextBody), "utf8");
    return [relPath];
  }, `experience restore ${relPath}`);
  return relPath;
}

export function experienceFromNormalized(n: NormalizedExperienceWrite): ExperienceWriteInput {
  return {
    brainId: n.brainId,
    title: n.title,
    trigger: String(n.frontmatter.trigger),
    procedure: String(n.frontmatter.procedure),
    boundary: String(n.frontmatter.boundary),
    sourcePaths: n.frontmatter.source_paths as string[],
    body: n.body,
    status: n.status,
    id: n.id,
  };
}
