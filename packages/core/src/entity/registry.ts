import { join, dirname } from "node:path";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { isSlug } from "../util/slug.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { directGitExecutor } from "../write/executor.ts";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { newLedgerEvent, writeLedgerLine } from "../events/ledger.ts";
import { entityToFile, fileToEntity } from "./files.ts";
import type {
  Entity,
  EntityCreateInput,
  EntityMergeInput,
  EntityListOptions,
  EntityLinkFactsInput,
} from "./types.ts";

export interface EntityRegistry {
  create(input: EntityCreateInput): Promise<Entity>;
  resolve(aliasOrSlug: string): Promise<Entity>;
  list(opts?: EntityListOptions): Promise<Entity[]>;
  merge(input: EntityMergeInput): Promise<Entity>;
  linkFacts(input: EntityLinkFactsInput): Promise<Entity>;
}

const REDIRECT_DEPTH_LIMIT = 2;

export function monthDir(iso: string): string {
  return iso.slice(0, 7);
}

export class EntityRegistryImpl implements EntityRegistry {
  readonly repoRoot: string;
  readonly brainId: string;
  private readonly executor: FileMutationExecutor;

  constructor(repoRoot: string, brainId: string, executor?: FileMutationExecutor) {
    this.repoRoot = repoRoot;
    this.brainId = brainId;
    this.executor = executor ?? directGitExecutor(repoRoot);
  }

  brainRoot(): string {
    return resolveBrainRoot(this.repoRoot, this.brainId);
  }

  entitiesDir(): string {
    return join(this.brainRoot(), "entities");
  }

  private entityRel(slug: string): string {
    return `brains/${this.brainId}/entities/${slug}.md`;
  }

  private entityAbs(slug: string): string {
    return join(this.entitiesDir(), `${slug}.md`);
  }

  private async readEntityFile(slug: string): Promise<Entity | null> {
    const abs = this.entityAbs(slug);
    if (!existsSync(abs)) return null;
    const raw = await readFile(abs, "utf8");
    return fileToEntity(raw);
  }

  private async writeEntityFile(entity: Entity): Promise<string> {
    const abs = this.entityAbs(entity.slug);
    let body: string | undefined;
    if (existsSync(abs) && entity.status !== "merged") {
      body = parseFrontmatter(await readFile(abs, "utf8")).body;
    }
    await writeFile(abs, entityToFile(entity, body));
    return this.entityRel(entity.slug);
  }

  async create(input: EntityCreateInput): Promise<Entity> {
    let created: Entity | undefined;
    await this.executor.execute(async () => {
      const r = await this.writeCreateUnlocked(input);
      created = r.entity;
      return [r.path];
    }, `entity create ${input.slug}`);
    return created!;
  }

  /** 已在 queue.execute 内：写新 entity 文件，不再持锁（P7.4 compile 同 job）。 */
  async writeCreateUnlocked(input: EntityCreateInput): Promise<{ entity: Entity; path: string }> {
    if (!isSlug(input.slug)) {
      throw new MemoryError(ErrorCodes.VALIDATION, `非法 slug: ${input.slug}`, { field: "slug" });
    }
    if (!input.title || !input.title.trim()) {
      throw new MemoryError(ErrorCodes.VALIDATION, "title 必填", { field: "title" });
    }
    if (existsSync(this.entityAbs(input.slug))) {
      throw new MemoryError(ErrorCodes.CONFLICT, `实体已存在: ${input.slug}`, { field: "path" });
    }
    const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))];
    const externalIds = [...new Set(input.externalIds ?? [])];
    for (const a of aliases) {
      if (a === input.slug) continue;
      const conflict = await this.resolveInternal(a, 0);
      if (conflict) {
        throw new MemoryError(ErrorCodes.CONFLICT, `别名冲突: "${a}" 已被 ${conflict.slug} 占用`, {
          field: "aliases",
        });
      }
    }
    const now = new Date().toISOString();
    const entity: Entity = {
      slug: input.slug,
      title: input.title.trim(),
      aliases,
      externalIds,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const path = await this.writeEntityFile(entity);
    return { entity, path };
  }

  /** 已在 queue.execute 内：已有 slug 只 append aliases，不覆写 title。 */
  async appendAliasesUnlocked(
    slug: string,
    aliases: string[],
  ): Promise<{ entity: Entity; path: string; skipped: string[] } | null> {
    const entity = await this.readEntityFile(slug);
    if (!entity || entity.status === "merged") return null;
    const skipped: string[] = [];
    const extra: string[] = [];
    for (const raw of aliases) {
      const a = raw.trim();
      if (!a || a === entity.slug || entity.aliases.includes(a)) continue;
      const conflict = await this.resolveInternal(a, 0);
      if (conflict && conflict.slug !== entity.slug) {
        skipped.push(a);
        continue;
      }
      extra.push(a);
    }
    if (extra.length === 0) {
      return skipped.length ? { entity, path: this.entityRel(slug), skipped } : null;
    }
    const updated: Entity = {
      ...entity,
      aliases: [...entity.aliases, ...extra],
      updatedAt: new Date().toISOString(),
    };
    const path = await this.writeEntityFile(updated);
    return { entity: updated, path, skipped };
  }

  async resolve(aliasOrSlug: string): Promise<Entity> {
    // M3 §5.4：先查 entity_registry，miss / 索引不可用再扫文件
    const fromIndex = await this.lookupCanonicalInIndex(aliasOrSlug);
    if (fromIndex) {
      const e = await this.readEntityFile(fromIndex);
      if (e) {
        if (e.status === "merged") {
          if (!e.redirect) {
            throw new MemoryError(ErrorCodes.INTERNAL, `实体 ${fromIndex} 为 merged 但缺少 redirect`);
          }
          return this.resolve(e.redirect);
        }
        return e;
      }
    }
    const e = await this.resolveInternal(aliasOrSlug, 0);
    if (!e) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, `实体不存在: ${aliasOrSlug}`);
    }
    return e;
  }

  /** 索引命中则返回 canonical_slug；无索引目录 / 失败返回 null（fallback 文件，M1 兼容）。 */
  private async lookupCanonicalInIndex(name: string): Promise<string | null> {
    try {
      const { loadRepoConfig } = await import("../repo/config.ts");
      const cfg = await loadRepoConfig(this.repoRoot);
      const dataDir = join(this.repoRoot, cfg.index.path);
      // 未建过索引时不主动 openPglite（避免 M1 纯文件路径被拖慢）
      if (!existsSync(dataDir)) return null;

      const { openPglite, ensureSchema } = await import("../index/engine.ts");
      const conn = await openPglite(this.repoRoot);
      try {
        await ensureSchema(conn.db);
        const bySlug = await conn.db.query<{ canonical_slug: string }>(
          `SELECT canonical_slug FROM entity_registry WHERE brain_id = $1 AND slug = $2 LIMIT 1`,
          [this.brainId, name],
        );
        if (bySlug.rows[0]?.canonical_slug) return bySlug.rows[0].canonical_slug;

        // aliases_json 为 JSON 字符串数组；jsonb ? 检查顶层数组元素
        const byAlias = await conn.db.query<{ canonical_slug: string }>(
          `SELECT canonical_slug FROM entity_registry
           WHERE brain_id = $1 AND aliases_json::jsonb ? $2 LIMIT 1`,
          [this.brainId, name],
        );
        if (byAlias.rows[0]?.canonical_slug) return byAlias.rows[0].canonical_slug;
        return null;
      } finally {
        await conn.close();
      }
    } catch {
      return null;
    }
  }

  private async resolveInternal(name: string, depth: number): Promise<Entity | null> {
    if (depth > REDIRECT_DEPTH_LIMIT) {
      throw new MemoryError(ErrorCodes.INTERNAL, "实体 redirect 链超过深度上限");
    }
    const direct = await this.readEntityFile(name);
    if (direct) {
      if (direct.status === "merged") {
        if (!direct.redirect) {
          throw new MemoryError(ErrorCodes.INTERNAL, `实体 ${name} 为 merged 但缺少 redirect`);
        }
        return this.resolveInternal(direct.redirect, depth + 1);
      }
      return direct;
    }
    for (const e of await this.list()) {
      if (e.slug !== name && e.aliases.includes(name)) return e;
    }
    return null;
  }

  async list(opts?: EntityListOptions): Promise<Entity[]> {
    if (!existsSync(this.entitiesDir())) return [];
    const entries = await readdir(this.entitiesDir());
    const slugs = entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    const out: Entity[] = [];
    for (const s of slugs) {
      const e = await this.readEntityFile(s);
      if (!e) continue;
      if (!opts?.includeMerged && e.status === "merged") continue;
      out.push(e);
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    return out;
  }

  async merge(input: EntityMergeInput): Promise<Entity> {
    if (!input.confirm) {
      throw new MemoryError(ErrorCodes.CONFLICT, "merge 需要 --confirm 确认", { need: "confirm" });
    }
    if (!Array.isArray(input.entityIds) || input.entityIds.length < 2) {
      throw new MemoryError(ErrorCodes.USAGE, "merge 至少需要两个实体");
    }
    if (!input.entityIds.includes(input.canonical)) {
      throw new MemoryError(ErrorCodes.USAGE, "canonical 必须是 entityIds 之一");
    }

    const canonical = await this.resolve(input.canonical);
    const canonicalSlug = canonical.slug;

    const losers: Entity[] = [];
    for (const id of input.entityIds) {
      if (id === canonicalSlug) continue;
      const e = await this.resolve(id);
      if (e.slug === canonicalSlug) continue;
      if (!losers.some((l) => l.slug === e.slug)) losers.push(e);
    }
    if (losers.length === 0) {
      throw new MemoryError(ErrorCodes.USAGE, "没有可合并的 loser 实体");
    }

    const now = new Date().toISOString();
    const newAliases = [
      ...new Set([...canonical.aliases, ...losers.flatMap((l) => l.aliases)].filter((a) => a !== canonicalSlug)),
    ];
    const newExternalIds = [...new Set([...canonical.externalIds, ...losers.flatMap((l) => l.externalIds)])];
    const mergedFacts = [...(canonical.facts ?? []), ...losers.flatMap((l) => l.facts ?? [])];
    const updated: Entity = {
      ...canonical,
      aliases: newAliases,
      externalIds: newExternalIds,
      updatedAt: now,
      facts: mergedFacts.length ? mergedFacts : undefined,
    };

    await this.executor.execute(async () => {
      const changed: string[] = [await this.writeEntityFile(updated)];
      for (const loser of losers) {
        const stub: Entity = {
          ...loser,
          status: "merged",
          redirect: canonicalSlug,
          mergedAt: now,
          mergedBy: input.mergedBy,
          updatedAt: now,
        };
        changed.push(await this.writeEntityFile(stub));
      }
      const ledgerRel = `brains/${this.brainId}/events/${monthDir(now)}/ledger.jsonl`;
      const ledgerAbs = join(this.repoRoot, ledgerRel);
      await mkdir(dirname(ledgerAbs), { recursive: true });
      const line = JSON.stringify({
        type: "entity_merged",
        from: losers.map((l) => l.slug),
        to: canonicalSlug,
        by: input.mergedBy,
        at: now,
      });
      await appendFile(ledgerAbs, line + "\n");
      changed.push(ledgerRel);
      return changed;
    }, `entity merge ${losers.map((l) => l.slug).join(" ")} -> ${canonicalSlug}`, {
      forceCommit: true,
      kind: "entity_merge",
    });

    return updated;
  }

  async linkFacts(input: EntityLinkFactsInput): Promise<Entity> {
    const text = input.fact.trim();
    if (!text) {
      throw new MemoryError(ErrorCodes.VALIDATION, "fact 必填", { field: "fact" });
    }
    if (text.length > 2000) {
      throw new MemoryError(ErrorCodes.VALIDATION, "facts[].text ≤2000", { field: "fact" });
    }
    const entity = await this.resolve(input.slug);
    const abs = this.entityAbs(entity.slug);
    const raw = await readFile(abs, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const now = new Date().toISOString();
    const fact = {
      text,
      event_type: "fact_linked",
      attributed_to: input.by,
      at: now,
      ...(input.path ? { path: input.path } : {}),
    };
    const facts = Array.isArray(data.facts) ? [...(data.facts as unknown[])] : [];
    facts.push(fact);
    data.facts = facts;
    data.updated_at = now;
    await this.executor.execute(async () => {
      await writeFile(abs, serializeFrontmatter(data, body), "utf8");
      const evt = newLedgerEvent({
        type: "fact_linked",
        by: input.by,
        from: entity.slug,
        payload: { slug: entity.slug, fact: text, path: input.path },
      });
      const ledgerRel = await writeLedgerLine(this.repoRoot, this.brainId, evt);
      return [this.entityRel(entity.slug), ledgerRel];
    }, `entity link-facts ${entity.slug}`);
    return fileToEntity(serializeFrontmatter(data, body));
  }
}

export function createEntityRegistry(repoRoot: string, brainId: string, executor?: FileMutationExecutor): EntityRegistry {
  return new EntityRegistryImpl(repoRoot, brainId, executor);
}
