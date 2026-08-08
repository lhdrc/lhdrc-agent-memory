export interface Link {
  to: string;
  type: string;
  source: "wikilink" | "markdown" | "mention" | "verb" | "path" | "frontmatter";
}

export interface Fact {
  text: string;
  event_type: string;
  attributed_to: string;
  at: string;
}

export type NodeStatus = "active" | "archived" | "stale";

export interface CreateNodeRequest {
  brainId: string;
  sourceId: string;
  schemaType: string;
  title: string;
  /** 相对 source 根的路径；可空则由 pack 模板生成 */
  relativePath?: string;
  /** 模板变量，如 {issue}（problem-tree 默认 general） */
  templateVars?: Record<string, string>;
  body: string;
  tags?: string[];
  aliases?: string[];
  links?: Link[];
  facts?: Fact[];
  createdBy: string;
  status?: NodeStatus;
}

export interface NormalizedWrite {
  brainId: string;
  sourceId: string;
  schemaType: string;
  title: string;
  /** 相对 repo 根的 POSIX path，如 brains/default/sources/default/issues/general/decisions/1-retry.md */
  path: string;
  /** 相对 brain 根的 path，写入 frontmatter path 字段 */
  pathFromBrain: string;
  body: string;
  frontmatter: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  status: NodeStatus;
}

export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; normalized: NormalizedWrite }
  | {
      ok: false;
      code: "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT";
      errors: ValidationError[];
    };

export interface ExperienceValidationResult {
  ok: boolean;
  code?: "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT";
  errors?: ValidationError[];
  normalized?: NormalizedExperienceWrite;
}

export interface NormalizedExperienceWrite {
  brainId: string;
  id: string;
  path: string;
  pathFromBrain: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  createdAt: string;
  status: "active" | "superseded" | "archived";
}
