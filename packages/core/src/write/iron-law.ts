import { join } from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { createEntityRegistry } from "../entity/registry.ts";
import { linkifyBody } from "../compile/linkify.ts";
import { isSlug } from "../util/slug.ts";
import type { FileMutationExecutor } from "./executor.ts";
import type { Fact, Link } from "./types.ts";

const SOURCE_TAG = "[Source:";
const BACKLINK_TYPES = new Set(["mentioned_in", "backlink"]);

export interface ApplyIronLawOptions {
  brainId?: string;
}

function entitySlugFromLinkTo(to: string, brainId: string): string | null {
  const norm = to.replace(/\\/g, "/").trim();
  const entMatch = norm.match(/(?:^|\/)entities\/([a-z0-9][a-z0-9_-]{0,127})\.md$/i);
  if (entMatch) return entMatch[1]!.toLowerCase();
  const brainPrefix = `brains/${brainId}/entities/`;
  if (norm.startsWith(brainPrefix)) {
    const rest = norm.slice(brainPrefix.length);
    const slug = rest.replace(/\.md$/i, "");
    return isSlug(slug) ? slug : null;
  }
  if (!norm.includes("/") && isSlug(norm)) return norm;
  return null;
}

function hasBacklink(links: Link[], nodeRel: string): boolean {
  return links.some((l) => l.to === nodeRel && BACKLINK_TYPES.has(l.type));
}

function appendSourceSuffix(text: string, label: string): string {
  if (text.includes(SOURCE_TAG)) return text;
  return `${text} [Source: ${label}]`;
}

function applySourceSuffixToFacts(facts: Fact[], label: string): { facts: Fact[]; changed: boolean } {
  let changed = false;
  const out = facts.map((f) => {
    const next = appendSourceSuffix(f.text, label);
    if (next !== f.text) {
      changed = true;
      return { ...f, text: next };
    }
    return f;
  });
  return { facts: out, changed };
}

async function collectEntitySlugs(
  repoRoot: string,
  brainId: string,
  data: Record<string, unknown>,
  body: string,
): Promise<string[]> {
  const slugs = new Set<string>();
  const links = Array.isArray(data.links) ? (data.links as Link[]) : [];
  for (const l of links) {
    const slug = entitySlugFromLinkTo(String(l.to ?? ""), brainId);
    if (slug) slugs.add(slug);
  }
  try {
    const reg = createEntityRegistry(repoRoot, brainId);
    const entities = await reg.list({ includeMerged: false });
    const linked = linkifyBody(body, entities);
    for (const l of linked.links) {
      if (isSlug(l.to)) slugs.add(l.to);
    }
  } catch {
    /* fail-open */
  }
  return [...slugs];
}

async function appendEntityBacklink(
  repoRoot: string,
  brainId: string,
  slug: string,
  nodeRel: string,
): Promise<void> {
  const entityRel = `brains/${brainId}/entities/${slug}.md`;
  const abs = join(repoRoot, entityRel);
  if (!existsSync(abs)) return;

  const raw = await fs.readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  if (data.status === "merged") return;

  const links: Link[] = Array.isArray(data.links) ? [...(data.links as Link[])] : [];
  if (hasBacklink(links, nodeRel)) return;

  links.push({ to: nodeRel, type: "mentioned_in", source: "path" });
  data.links = links;
  await fs.writeFile(abs, serializeFrontmatter(data, body), "utf8");
}

/**
 * P9.7 Iron Law：实体 back-link + facts `[Source:]` 后缀。
 * fail-open：任何子步骤失败不抛、不回滚主节点。
 */
export async function applyIronLaw(
  repoRoot: string,
  nodeRel: string,
  _queue: FileMutationExecutor,
  opts: ApplyIronLawOptions = {},
): Promise<void> {
  try {
    const cfg = await loadRepoConfig(repoRoot);
    const brainId = opts.brainId ?? cfg.brain_id;
    if (!cfg.iron_law.backlink && !cfg.iron_law.source_suffix) return;

    const abs = join(repoRoot, nodeRel);
    if (!existsSync(abs)) return;

    const raw = await fs.readFile(abs, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const sourceLabel = nodeRel;

    if (cfg.iron_law.source_suffix) {
      const facts = Array.isArray(data.facts) ? (data.facts as Fact[]) : [];
      if (facts.length > 0) {
        const { facts: updated, changed } = applySourceSuffixToFacts(facts, sourceLabel);
        if (changed) {
          data.facts = updated;
          await fs.writeFile(abs, serializeFrontmatter(data, body), "utf8");
        }
      }
    }

    if (!cfg.iron_law.backlink) return;

    const slugs = await collectEntitySlugs(repoRoot, brainId, data, body);
    for (const slug of slugs) {
      try {
        await appendEntityBacklink(repoRoot, brainId, slug, nodeRel);
      } catch {
        /* fail-open per entity */
      }
    }
  } catch {
    /* fail-open */
  }
}
