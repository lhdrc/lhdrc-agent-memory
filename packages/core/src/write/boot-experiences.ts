import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { parseFrontmatter } from "../frontmatter.ts";

export type BootExperienceItem = {
  path: string;
  title: string;
  snippet: string;
};

function buildSnippet(title: string, trigger: string, body: string): string {
  const t = trigger.trim();
  const b = body.trim();
  if (t && b) return `${title} — ${t}`;
  if (t) return `${title} — ${t}`;
  if (b) return `${title} — ${b.slice(0, 240)}`;
  return title;
}

/** P9.6：启动注入用 active 经验 top-k（eta_score ↓ support ↓）。 */
export async function listBootExperiences(
  repoRoot: string,
  brainId: string,
  topK = 3,
): Promise<BootExperienceItem[]> {
  const dir = join(repoRoot, "brains", brainId, "experiences");
  if (!existsSync(dir)) return [];

  const names = await readdir(dir);
  const items: Array<BootExperienceItem & { eta: number; support: number }> = [];

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const rel = `brains/${brainId}/experiences/${name}`;
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    if (String(data.status ?? "active") !== "active") continue;
    items.push({
      path: rel,
      title: String(data.title ?? name.replace(/\.md$/, "")),
      snippet: buildSnippet(String(data.title ?? ""), String(data.trigger ?? ""), body),
      eta: Number(data.eta_score ?? 0.5),
      support: Number(data.support ?? 0),
    });
  }

  items.sort((a, b) => b.eta - a.eta || b.support - a.support);
  return items.slice(0, Math.max(0, topK)).map(({ path, title, snippet }) => ({ path, title, snippet }));
}
