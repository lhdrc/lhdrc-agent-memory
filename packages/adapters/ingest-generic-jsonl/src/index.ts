import { MemoryError, ErrorCodes, type IngestAdapter, type IngestRecord } from "@lhdrc/core";

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** 通用 JSONL：`{ title, body, type?, source? }` */
export const genericJsonlAdapter: IngestAdapter = {
  id: "generic-jsonl",
  map(raw: unknown, ctx: { line: number }): IngestRecord {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MemoryError(ErrorCodes.VALIDATION, `generic-jsonl 第 ${ctx.line} 行必须是对象`);
    }
    const o = raw as Record<string, unknown>;
    const title = str(o.title).trim();
    const body = str(o.body ?? o.content ?? o.text);
    const schemaType = str(o.type ?? o.schema_type).trim() || "note";
    const sourceId = str(o.source ?? o.source_id).trim() || undefined;
    const tags = Array.isArray(o.tags) ? o.tags.map(str).filter(Boolean) : undefined;
    return { title, body, schemaType, sourceId, tags };
  },
};

export default genericJsonlAdapter;
