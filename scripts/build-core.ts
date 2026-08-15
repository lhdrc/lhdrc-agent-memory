/**
 * 把 @lhdrc/core 打成 Node 可 import 的 ESM（P4.2）。
 * 本仓 CLI/测试仍直接跑 src/*.ts，不依赖这次构建。
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const coreRoot = join(repoRoot, "packages", "core");
const entry = join(coreRoot, "src", "index.ts");
const distDir = join(coreRoot, "dist");
const schemaSrc = join(coreRoot, "src", "index", "schema.sql");

await mkdir(distDir, { recursive: true });

const proc = Bun.spawn({
  cmd: ["bun", "build", entry, "--outdir", distDir, "--target", "node", "--format", "esm", "--packages", "external"],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) {
  throw new Error(`bun build core failed: exit ${code}`);
}
await copyFile(schemaSrc, join(distDir, "schema.sql"));
console.log("built packages/core/dist (schema.sql copied)");
