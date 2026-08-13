import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 写临时文件再 rename，避免半截 JSON（P6.2）。 */
export async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.tmp`;
  await mkdirp(dirname(abs));
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}
