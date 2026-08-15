import { MemoryError, ErrorCodes } from "../errors.ts";

export interface PageFilterOptions {
  sourceId?: string;
  schemaType?: string;
  excludeSchemaTypes?: string[];
  excludeSidecars?: boolean;
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

  return { clauses, params, nextIndex: i };
}
