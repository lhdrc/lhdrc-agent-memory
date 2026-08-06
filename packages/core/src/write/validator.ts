import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { isSlug, titleToSlug } from "../util/slug.ts";
import { normalizeRepoPath, resolveSourceRoot, assertUnderPrefix } from "../repo/layout.ts";
import type { CreateNodeRequest, NormalizedWrite, NodeStatus, ValidationError, ValidationResult } from "./types.ts";

const MAX_BODY_CHARS = 200_000;
const ALLOWED_LINK_TYPES = new Set([
  "belongs_to",
  "references",
  "mentions",
  "decided",
  "produced_by",
  "works_on",
]);
const STATUSES = new Set(["active", "archived", "stale"]);

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

function replaceVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export class WriteValidator {
  private readonly maxBodyChars: number;

  constructor(
    private readonly repoRoot: string,
    private readonly pack: SchemaPack,
    opts?: { maxBodyChars?: number },
  ) {
    this.maxBodyChars = opts?.maxBodyChars ?? MAX_BODY_CHARS;
  }

  async validate(req: CreateNodeRequest): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const title = (req.title ?? "").trim();
    if (!title) errors.push({ field: "title", message: "title 必填" });
    else if (title.length > 200) errors.push({ field: "title", message: `title 超过 200 字符` });

    if (!req.schemaType || !this.pack.schema_types.includes(req.schemaType)) {
      errors.push({ field: "schema_type", message: `schema_type 不在 pack(${this.pack.id}) 中: ${req.schemaType}` });
    }
    if (!isSlug(req.sourceId)) errors.push({ field: "source", message: `非法 source: ${req.sourceId}` });
    if (!req.createdBy || req.createdBy.length > 128) {
      errors.push({ field: "created_by", message: "created_by 必填且 ≤128" });
    }
    const status = req.status ?? "active";
    if (!STATUSES.has(status)) errors.push({ field: "status", message: `非法 status: ${status}` });
    if (req.body.length > this.maxBodyChars) {
      errors.push({ field: "body", message: `body 超过 ${this.maxBodyChars} 字符` });
    }
    for (const f of req.facts ?? []) {
      if (!f.text?.trim() || f.text.length > 2000) {
        errors.push({ field: "facts", message: "facts[].text 非空且 ≤2000" });
      }
    }
    for (const l of req.links ?? []) {
      if (!l.to?.trim()) errors.push({ field: "links", message: "links[].to 非空" });
      if (!ALLOWED_LINK_TYPES.has(l.type)) {
        errors.push({ field: "links.type", message: `links[].type 不允许: ${l.type}` });
      }
    }
    if (errors.length > 0) {
      return { ok: false, code: "E_VALIDATION", errors };
    }

    let pathFromBrain: string;
    try {
      pathFromBrain = await this.buildPathFromBrain(req, title);
      const normalized = normalizeRepoPath(this.repoRoot, req.brainId, pathFromBrain);
      const sourcePrefix = resolve(resolveSourceRoot(this.repoRoot, req.brainId, req.sourceId));
      assertUnderPrefix(normalized.abs, sourcePrefix);
      if (existsSync(normalized.abs)) {
        return { ok: false, code: "E_CONFLICT", errors: [{ field: "path", message: `路径已存在（ADD-only）: ${normalized.rel}` }] };
      }
      const normalizedWrite = this.buildNormalized(req, title, pathFromBrain, normalized.rel, status);
      return { ok: true, normalized: normalizedWrite };
    } catch (e) {
      if (e instanceof MemoryError) {
        return {
          ok: false,
          code: e.code as "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT",
          errors: [{ field: "path", message: e.message }],
        };
      }
      throw e;
    }
  }

  private buildNormalized(
    req: CreateNodeRequest,
    title: string,
    pathFromBrain: string,
    rel: string,
    status: NodeStatus,
  ): NormalizedWrite {
    const createdAt = new Date().toISOString();
    const frontmatter: Record<string, unknown> = {
      title,
      schema_type: req.schemaType,
      source: req.sourceId,
      path: pathFromBrain,
      version: 1,
      status,
      created_by: req.createdBy,
      created_at: createdAt,
      tags: req.tags ?? [],
      aliases: req.aliases ?? [],
      links: req.links ?? [],
      facts: req.facts ?? [],
    };
    return {
      brainId: req.brainId,
      sourceId: req.sourceId,
      schemaType: req.schemaType,
      title,
      path: rel,
      pathFromBrain,
      body: req.body,
      frontmatter,
      createdBy: req.createdBy,
      createdAt,
      status,
    };
  }

  /** 生成相对 brain 根的路径（含 sources/{sourceId}/ 前缀）。 */
  private async buildPathFromBrain(req: CreateNodeRequest, title: string): Promise<string> {
    if (req.relativePath) {
      return `sources/${req.sourceId}/${stripSlashes(req.relativePath)}`;
    }
    const tmpl = this.pack.filename_templates[req.schemaType];
    if (!tmpl) {
      throw new MemoryError(ErrorCodes.INTERNAL, `pack 缺少 filename_templates[${req.schemaType}]`);
    }
    const vars: Record<string, string> = {
      slug: titleToSlug(title),
      date: todayUtc(),
      ...(req.templateVars ?? {}),
    };
    if (!vars.issue) vars.issue = "general";
    const n = await this.nextSequence(req, tmpl);
    return `sources/${req.sourceId}/${replaceVars(tmpl, { ...vars, n: String(n) })}`;
  }

  private async nextSequence(req: CreateNodeRequest, tmpl: string): Promise<number> {
    if (!tmpl.includes("{n}")) return 0;
    const segments = tmpl.split("/");
    const dirSegments = segments.slice(0, segments.length - 1).map((s) =>
      replaceVars(s, { slug: titleToSlug(req.title), date: todayUtc(), ...(req.templateVars ?? {}), issue: req.templateVars?.issue ?? "general" }),
    );
    const sourceRoot = resolveSourceRoot(this.repoRoot, req.brainId, req.sourceId);
    const dirAbs = join(sourceRoot, ...dirSegments);
    let count = 0;
    if (existsSync(dirAbs)) {
      try {
        const entries = await readdir(dirAbs);
        count = entries.filter((f) => f.endsWith(".md")).length;
      } catch {
        count = 0;
      }
    }
    const nStart = this.pack.n_start ?? 1;
    return count + nStart;
  }
}
