import { mkdir } from "node:fs/promises";

export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
