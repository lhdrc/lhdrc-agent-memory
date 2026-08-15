import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryError, ErrorCodes } from "../errors.ts";

/** 当前模块所在目录（Node：`import.meta.url` 转路径后取 dirname）。 */
export function hereDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/** 从模块向上找到最近的 package.json 目录（workspace src 与打包 dist 都能落到包根）。 */
export function packageRootFrom(metaUrl: string): string {
  let dir = hereDir(metaUrl);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return hereDir(metaUrl);
    dir = parent;
  }
}

/**
 * 读与模块同目录、或包根上的运行时资源。
 * 覆盖：src 旁文件、bun build 后的 dist/、发布包根。
 */
export async function readPackageText(metaUrl: string, relativePath: string): Promise<string> {
  const root = packageRootFrom(metaUrl);
  const candidates = [
    join(hereDir(metaUrl), relativePath),
    join(root, relativePath),
    join(root, "src", relativePath),
    join(root, "src/index", relativePath),
    join(root, "dist", relativePath),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFile(p, "utf8");
  }
  throw new MemoryError(ErrorCodes.INDEX, `运行时资源缺失: ${relativePath}`);
}

/** PGLite DDL：开发时在 src/index/，打包后在 dist/ 或包根。 */
export async function readSchemaSql(metaUrl: string = import.meta.url): Promise<string> {
  return readPackageText(metaUrl, "schema.sql");
}
