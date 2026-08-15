import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { serializeFrontmatter, parseFrontmatter } from "../frontmatter.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "./executor.ts";
import {
  validateSkillWrite,
  type SkillWriteInput,
  type SkillStatus,
  clampEta,
  OUTCOME_SUCCESS_DELTA,
  OUTCOME_FAIL_DELTA,
} from "./skill-validator.ts";

export type { SkillWriteInput, SkillStatus } from "./skill-validator.ts";
export {
  validateSkillWrite,
  isMatureExperience,
  MATURITY_ETA_MIN,
  MATURITY_SUPPORT_MIN,
  SKILL_NAME_RE,
} from "./skill-validator.ts";

export function skillRelPath(brainId: string, name: string): string {
  return `brains/${brainId}/skills/${name}/SKILL.md`;
}

export async function writeSkill(
  repoRoot: string,
  pack: SchemaPack,
  queue: FileMutationExecutor,
  input: SkillWriteInput,
): Promise<string> {
  const result = validateSkillWrite(repoRoot, pack, input);
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
    `skill create ${n.pathFromBrain}`,
  );
  return n.path;
}

export async function patchSkill(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  patch: Record<string, unknown>,
): Promise<string> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `skill 不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  Object.assign(data, patch);
  // 08 eta 别名
  if ("eta" in patch && patch.eta != null && data.eta_score == null) {
    data.eta_score = patch.eta;
  }
  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    return [relPath];
  }, `skill patch ${relPath}`);
  return relPath;
}

export async function activateSkill(
  repoRoot: string,
  brainId: string,
  name: string,
  queue: FileMutationExecutor,
): Promise<string> {
  const rel = skillRelPath(brainId, name);
  return patchSkill(repoRoot, rel, queue, { status: "active" as SkillStatus });
}

export async function applySkillOutcome(
  repoRoot: string,
  brainId: string,
  name: string,
  queue: FileMutationExecutor,
  opts: { success: boolean; note?: string },
): Promise<{ path: string; eta_score: number; support: number; status: string }> {
  const rel = skillRelPath(brainId, name);
  const abs = join(repoRoot, rel);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `skill 不存在: ${rel}`);
  }
  const { data, body } = parseFrontmatter(raw);
  let eta = Number(data.eta_score ?? data.eta ?? 0.5);
  let support = Number(data.support ?? 0);
  const counters = Array.isArray(data.counter_examples)
    ? [...(data.counter_examples as string[])]
    : [];
  let status = String(data.status ?? "candidate");

  if (opts.success) {
    eta = clampEta(eta + OUTCOME_SUCCESS_DELTA);
    support += 1;
  } else {
    eta = clampEta(eta + OUTCOME_FAIL_DELTA);
    if (opts.note?.trim()) counters.push(opts.note.trim());
    else counters.push(`fail@${new Date().toISOString()}`);
    if (counters.length > 0 && eta < 0.4) status = "archived";
  }

  data.eta_score = eta;
  data.support = support;
  data.counter_examples = counters;
  data.status = status;

  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    return [rel];
  }, `skill outcome ${name}`);

  return { path: rel, eta_score: eta, support, status };
}

export async function applyExperienceOutcome(
  repoRoot: string,
  relPath: string,
  queue: FileMutationExecutor,
  opts: { success: boolean; note?: string },
): Promise<{ path: string; eta_score: number; support: number }> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `experience 不存在: ${relPath}`);
  }
  const { data, body } = parseFrontmatter(raw);
  let eta = Number(data.eta_score ?? 0.5);
  let support = Number(data.support ?? 0);
  const counters = Array.isArray(data.counter_examples)
    ? [...(data.counter_examples as string[])]
    : [];

  if (opts.success) {
    eta = clampEta(eta + OUTCOME_SUCCESS_DELTA);
    support += 1;
  } else {
    eta = clampEta(eta + OUTCOME_FAIL_DELTA);
    if (opts.note?.trim()) counters.push(opts.note.trim());
    else counters.push(`fail@${new Date().toISOString()}`);
  }

  data.eta_score = eta;
  data.support = support;
  data.counter_examples = counters;

  await queue.execute(async () => {
    await writeFile(abs, serializeFrontmatter(data, body), "utf8");
    return [relPath];
  }, `experience outcome ${relPath}`);

  return { path: relPath, eta_score: eta, support };
}

export type SkillListItem = {
  name: string;
  path: string;
  status: string;
  title: string;
  trigger: string;
  eta_score: number;
  support: number;
};

function skillItemFromFrontmatter(
  name: string,
  rel: string,
  data: Record<string, unknown>,
): SkillListItem {
  return {
    name,
    path: rel,
    status: String(data.status ?? "candidate"),
    title: String(data.title ?? name),
    trigger: String(data.trigger ?? ""),
    eta_score: Number(data.eta_score ?? data.eta ?? 0.5),
    support: Number(data.support ?? 0),
  };
}

function filterByStatus(items: SkillListItem[], status?: SkillStatus | "any"): SkillListItem[] {
  if (!status || status === "any") return items;
  return items.filter((s) => s.status === status);
}

async function loadSkillEntries(
  repoRoot: string,
  brainId: string,
): Promise<Array<{ item: SkillListItem; procedure: string }>> {
  const dir = join(repoRoot, "brains", brainId, "skills");
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: Array<{ item: SkillListItem; procedure: string }> = [];
  for (const name of names) {
    const rel = skillRelPath(brainId, name);
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const { data } = parseFrontmatter(await readFile(abs, "utf8"));
    out.push({
      item: skillItemFromFrontmatter(name, rel, data),
      procedure: String(data.procedure ?? ""),
    });
  }
  return out;
}

export async function listSkills(
  repoRoot: string,
  brainId: string,
  statusFilter?: SkillStatus,
): Promise<SkillListItem[]> {
  const entries = await loadSkillEntries(repoRoot, brainId);
  return filterByStatus(
    entries.map((e) => e.item),
    statusFilter,
  ).sort((a, b) => a.name.localeCompare(b.name));
}

export async function findSkills(
  repoRoot: string,
  brainId: string,
  query: string,
  opts?: { status?: SkillStatus | "any"; limit?: number },
): Promise<SkillListItem[]> {
  const status = opts?.status ?? "any";
  const entries = await loadSkillEntries(repoRoot, brainId);
  let items = filterByStatus(
    entries.map((e) => e.item),
    status,
  );

  const q = query.trim();
  if (q) {
    const needle = q.toLowerCase();
    items = entries
      .filter(({ item, procedure }) => {
        if (status !== "any" && item.status !== status) return false;
        if (item.title.toLowerCase().includes(needle)) return true;
        if (item.trigger.toLowerCase().includes(needle)) return true;
        if (item.name.toLowerCase().includes(needle)) return true;
        if (procedure.toLowerCase().includes(needle)) return true;
        return false;
      })
      .map((e) => e.item);
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  if (opts?.limit != null && opts.limit >= 0) {
    items = items.slice(0, opts.limit);
  }
  return items;
}
