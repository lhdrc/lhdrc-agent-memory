/**
 * shared/skills 可见性：仅当 brain.yml mounts 声明 shared_skills。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parseFrontmatter } from "../frontmatter.ts";
import { hasSharedSkillsMount, type BrainConfig } from "../repo/brain.ts";
import type { QueryHit } from "../retrieve/query.ts";

export function isSharedSkillsPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return p.startsWith("shared/skills/") || p.includes("/shared/skills/");
}

/** 过滤检索结果：未 mount 时剔除 shared/skills。 */
export function filterSharedSkillsHits(hits: QueryHit[], brain: BrainConfig): QueryHit[] {
  if (hasSharedSkillsMount(brain)) return hits;
  return hits.filter((h) => !isSharedSkillsPath(h.path));
}

export async function listSharedSkillNames(repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, "shared", "skills");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skill = join(dir, e.name, "SKILL.md");
    if (existsSync(skill)) names.push(e.name);
  }
  return names.sort();
}

/** 未 mount 时返回空；已 mount 则读 shared skills 元数据。 */
export async function listVisibleSharedSkills(
  repoRoot: string,
  brain: BrainConfig,
): Promise<Array<{ name: string; title: string; path: string }>> {
  if (!hasSharedSkillsMount(brain)) return [];
  const names = await listSharedSkillNames(repoRoot);
  const out: Array<{ name: string; title: string; path: string }> = [];
  for (const name of names) {
    const rel = `shared/skills/${name}/SKILL.md`;
    const abs = join(repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const { data } = parseFrontmatter(raw);
    out.push({ name, title: String(data.title ?? name), path: rel });
  }
  return out;
}
