import {
  MemoryError,
  ErrorCodes,
  buildConfigRows,
  buildDoctorReport,
  formatConfigRows,
  formatDoctorReport,
  setRepoConfigKey,
  parseSetAssignment,
  findRepoRoot,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

const HELP = `memory config [list|get|set|doctor]
    [--json]

查看或安全改写 memory.yml（不写密钥）。无子命令 = list。

  list              生效配置表（含 effect / needs / ready）
  get <dotted.key>  单键
  set <k>=<v>       白名单写回 yml
  doctor            检查 key / 门闩；缺 key 退出 2；不出网
`;

export async function configCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "json", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const json = Boolean(o.json);
  const [sub, ...rest] = o._.map(String);
  const action = !sub || sub === "list" ? "list" : sub;

  if (action === "list") {
    const ctx = await loadContext(json);
    const rows = await buildConfigRows(ctx.repoRoot);
    if (json) {
      console.log(JSON.stringify({ ok: true, result: { rows }, rows }));
    } else {
      console.log(formatConfigRows(rows));
    }
    return 0;
  }

  if (action === "get") {
    const key = rest[0];
    if (!key) throw new MemoryError(ErrorCodes.USAGE, "config get 需要 dotted.key");
    const ctx = await loadContext(json);
    const rows = await buildConfigRows(ctx.repoRoot);
    const row = rows.find((r) => r.key === key);
    if (!row) {
      throw new MemoryError(ErrorCodes.USAGE, `未知配置键: ${key}`);
    }
    if (json) {
      console.log(JSON.stringify({ ok: true, result: row, key: row.key, value: row.value }));
    } else {
      console.log(row.value);
    }
    return 0;
  }

  if (action === "set") {
    const raw = rest.join(" ").trim();
    if (!raw) throw new MemoryError(ErrorCodes.USAGE, "config set 需要 dotted.key=value");
    const { key, value } = parseSetAssignment(raw.includes("=") ? raw : `${rest[0]}=${rest.slice(1).join(" ")}`);
    const repoRoot = findRepoRoot();
    const result = await setRepoConfigKey(repoRoot, key, value);
    for (const w of result.warnings) console.error(w);
    if (json) {
      console.log(JSON.stringify({ ok: true, result, key: result.key, value: result.value }));
    } else {
      console.log(`${result.key}=${result.value}`);
    }
    return 0;
  }

  if (action === "doctor") {
    const ctx = await loadContext(json);
    const report = await buildDoctorReport(ctx.repoRoot);
    if (json) {
      console.log(
        JSON.stringify({
          ok: report.ok,
          result: report,
          rows: report.rows,
          issues: report.issues,
          hints: report.hints,
        }),
      );
    } else {
      console.log(formatDoctorReport(report));
    }
    return report.ok ? 0 : 2;
  }

  if (action === "path") {
    const repoRoot = findRepoRoot();
    const { join } = await import("node:path");
    const p = join(repoRoot, "memory.yml");
    if (json) console.log(JSON.stringify({ ok: true, path: p }));
    else console.log(p);
    return 0;
  }

  throw new MemoryError(ErrorCodes.USAGE, `未知 config 子命令: ${action}（list|get|set|doctor）`);
}
