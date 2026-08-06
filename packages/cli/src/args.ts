import { MemoryError, ErrorCodes } from "@df-memory/core";

export interface ArgSpec {
  name: string;
  alias?: string;
  type: "boolean" | "string" | "string[]";
  default?: unknown;
  help?: string;
}

export interface ParsedArgs {
  _: string[];
  [key: string]: unknown;
}

/**
 * 轻量 CLI 参数解析：
 * - `--flag` 布尔；`--opt value` / `--opt=value` 取值；`--tag a --tag b` 收集数组
 * - 短别名 `-x`；`--` 之后的均视为位置参数
 */
export function parseArgs(argv: string[], specs: ArgSpec[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  const byName = new Map<string, ArgSpec>();
  const byAlias = new Map<string, ArgSpec>();
  for (const s of specs) {
    byName.set(s.name, s);
    if (s.alias) byAlias.set(s.alias, s);
    if (s.default !== undefined) out[s.name] = s.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const spec = byName.get(name);
      if (!spec) {
        throw new MemoryError(ErrorCodes.USAGE, `未知参数: --${name}`);
      }
      if (spec.type === "boolean") {
        out[spec.name] = true;
        continue;
      }
      const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
      const value = inline ?? argv[++i];
      if (value === undefined) {
        throw new MemoryError(ErrorCodes.USAGE, `参数 --${name} 需要值`);
      }
      if (spec.type === "string[]") {
        const arr = (out[spec.name] as string[]) ?? [];
        arr.push(value);
        out[spec.name] = arr;
      } else {
        out[spec.name] = value;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const spec = byAlias.get(a.slice(1));
      if (!spec) {
        throw new MemoryError(ErrorCodes.USAGE, `未知参数: ${a}`);
      }
      if (spec.type === "boolean") {
        out[spec.name] = true;
      } else {
        const value = argv[++i];
        if (value === undefined) {
          throw new MemoryError(ErrorCodes.USAGE, `参数 ${a} 需要值`);
        }
        out[spec.name] = value;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
