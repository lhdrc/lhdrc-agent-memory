export interface JsonlRow {
  line: number;
  raw: unknown;
}

export interface JsonlParseError {
  line: number;
  message: string;
}

export function parseJsonl(text: string): { rows: JsonlRow[]; errors: JsonlParseError[] } {
  const rows: JsonlRow[] = [];
  const errors: JsonlParseError[] = [];
  const trimmed = text.replace(/^\uFEFF/, "");
  const first = trimmed.trimStart()[0];
  if (first === "[") {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(arr)) {
        errors.push({ line: 1, message: "JSON 根必须是数组或 JSONL" });
        return { rows, errors };
      }
      arr.forEach((raw, i) => rows.push({ line: i + 1, raw }));
    } catch (e) {
      errors.push({ line: 1, message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` });
    }
    return { rows, errors };
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim();
    if (!s) continue;
    try {
      rows.push({ line: i + 1, raw: JSON.parse(s) });
    } catch (e) {
      errors.push({
        line: i + 1,
        message: `非法 JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { rows, errors };
}
