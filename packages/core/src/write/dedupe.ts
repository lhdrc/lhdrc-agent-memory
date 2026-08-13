import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.ts";
import { createEmbeddingProvider, cosineSimilarity } from "../embed/index.ts";
import type { EmbeddingProvider } from "../embed/types.ts";
import type { RepoConfig } from "../repo/config.ts";
import { resolveBrainRoot } from "../repo/layout.ts";

export interface DedupeResult {
  duplicate: boolean;
  matchedPath?: string;
  skipped_reason?: string;
}

interface ScoredFile {
  rel: string;
  mtimeMs: number;
  text: string;
}

function buildDedupeText(data: Record<string, unknown>, body: string): string {
  const title = String(data.title ?? "");
  const facts = Array.isArray(data.facts)
    ? (data.facts as Array<{ text?: string }>).map((f) => f.text ?? "").join("\n")
    : "";
  return [title, facts, body].filter(Boolean).join("\n").slice(0, 4000);
}

async function walkSourcesMd(
  dirAbs: string,
  baseRel: string,
  excludeRel: string,
  out: ScoredFile[],
): Promise<void> {
  if (!existsSync(dirAbs)) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`.replace(/\\/g, "/");
    if (e.isDirectory()) {
      await walkSourcesMd(childAbs, childRel, excludeRel, out);
    } else if (e.isFile() && e.name.endsWith(".md") && childRel !== excludeRel) {
      const st = await stat(childAbs);
      const raw = await readFile(childAbs, "utf8");
      const { data, body } = parseFrontmatter(raw);
      out.push({
        rel: childRel,
        mtimeMs: st.mtimeMs,
        text: buildDedupeText(data, body),
      });
    }
  }
}

/**
 * P5.1 余弦快路径：与近期 sources 正文比较相似度。
 * embedding.provider=off 或 dedupe_cosine≤0 时返回 duplicate=false（由 caller 处理 skipped_reason）。
 */
export async function checkDedupe(
  repoRoot: string,
  brainId: string,
  currentPath: string,
  text: string,
  cfg: RepoConfig,
  embedder?: EmbeddingProvider,
): Promise<DedupeResult> {
  const threshold = cfg.write.dedupe_cosine;
  const window = cfg.write.dedupe_window;

  if (threshold <= 0) {
    return { duplicate: false };
  }

  if (cfg.embedding.provider === "off") {
    return { duplicate: false, skipped_reason: "embedding_off" };
  }

  const candidates: ScoredFile[] = [];
  const sourcesRoot = join(resolveBrainRoot(repoRoot, brainId), "sources");
  const excludeRel = currentPath.replace(/\\/g, "/");
  await walkSourcesMd(sourcesRoot, `brains/${brainId}/sources`, excludeRel, candidates);

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recent = candidates.slice(0, window);
  if (recent.length === 0) {
    return { duplicate: false };
  }

  const provider = embedder ?? createEmbeddingProvider(cfg.embedding);
  const queryText = text.slice(0, 4000);
  const texts = [queryText, ...recent.map((c) => c.text)];
  const vectors = await provider.embed(texts);
  const queryVec = vectors[0]!;

  let bestSim = 0;
  let bestPath: string | undefined;
  for (let i = 0; i < recent.length; i++) {
    const sim = cosineSimilarity(queryVec, vectors[i + 1]!);
    if (sim > bestSim) {
      bestSim = sim;
      bestPath = recent[i]!.rel;
    }
  }

  if (bestSim >= threshold && bestPath) {
    return { duplicate: true, matchedPath: bestPath };
  }
  return { duplicate: false };
}
