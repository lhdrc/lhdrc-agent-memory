import { MemoryError, ErrorCodes, type IngestAdapter, type IngestRecord } from "@df-memory/core";

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function messageBody(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    return str(m.text ?? m.content ?? m.body ?? m.message);
  }
  return "";
}

function messageRole(message: unknown): string {
  if (message && typeof message === "object") {
    return str((message as Record<string, unknown>).role) || "user";
  }
  return "user";
}

/**
 * df-app 导出夹具（非真实 df-app 进程）。
 * 映射：session → source；message → body。
 * 真 df-app 字段若改名，以本 README 为准，不在 core 硬编码。
 */
export const dfAppAdapter: IngestAdapter = {
  id: "df-app",
  map(raw: unknown, ctx: { line: number }): IngestRecord {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MemoryError(ErrorCodes.VALIDATION, `df-app 第 ${ctx.line} 行必须是对象`);
    }
    const o = raw as Record<string, unknown>;
    const sourceId = str(o.session ?? o.session_id).trim() || undefined;
    const body = messageBody(o.message ?? o.payload);
    const role = messageRole(o.message ?? o.payload);
    const title =
      str(o.title).trim() ||
      str(o.topic).trim() ||
      (body.trim() ? body.trim().split(/\n/)[0]!.slice(0, 80) : "") ||
      `df-app ${role}`;
    return {
      title,
      body,
      schemaType: "note",
      sourceId,
    };
  },
};

export default dfAppAdapter;
