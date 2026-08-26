import { MemoryError, ErrorCodes } from "../errors.ts";

export interface PageFilterOptions {
  sourceId?: string;
  schemaType?: string;
  excludeSchemaTypes?: string[];
  excludeSidecars?: boolean;
  /** P11.1：路径须含子串，如 `/experiences/` */
  pathPrefix?: string;
  /** P11.1：路径须含子串，如 `/issues/` */
  pathContains?: string;
}

export function assertExclusiveSchemaFilters(opts: {
  schemaType?: string;
  excludeSchemaTypes?: string[];
}): void {
  if (opts.schemaType && opts.excludeSchemaTypes && opts.excludeSchemaTypes.length > 0) {
    throw new MemoryError(ErrorCodes.USAGE, "schemaType 与 excludeSchemaTypes 不能同时指定");
  }
}

/** 追加 pages 表过滤条件；columnPrefix 如 `p.` 用于 JOIN 查询。 */
export function appendPageFilters(
  opts: PageFilterOptions,
  paramIndex: number,
  columnPrefix = "",
): { clauses: string[]; params: unknown[]; nextIndex: number } {
  const p = columnPrefix;
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = paramIndex;

  if (opts.sourceId) {
    clauses.push(`${p}source_id = $${i}`);
    params.push(opts.sourceId);
    i++;
  }
  if (opts.schemaType) {
    clauses.push(`${p}schema_type = $${i}`);
    params.push(opts.schemaType);
    i++;
  }
  if (opts.excludeSchemaTypes?.length) {
    const placeholders = opts.excludeSchemaTypes.map((_, j) => `$${i + j}`).join(", ");
    clauses.push(`${p}schema_type NOT IN (${placeholders})`);
    params.push(...opts.excludeSchemaTypes);
    i += opts.excludeSchemaTypes.length;
  }
  if (opts.excludeSidecars) {
    clauses.push(`${p}path NOT LIKE '%.overview.md'`);
    clauses.push(`${p}path NOT LIKE '%.abstract.md'`);
  }
  const prefixNeedle = pathIncludeNeedle(opts.pathPrefix);
  if (prefixNeedle) {
    clauses.push(`position($${i} in ${p}path) > 0`);
    params.push(prefixNeedle);
    i++;
  }
  if (opts.pathContains) {
    clauses.push(`position($${i} in ${p}path) > 0`);
    params.push(opts.pathContains);
    i++;
  }

  return { clauses, params, nextIndex: i };
}

function pathIncludeNeedle(prefix?: string): string | undefined {
  if (!prefix) return undefined;
  const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return undefined;
  return `/${trimmed}/`;
}
