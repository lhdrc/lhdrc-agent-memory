import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./lib/paths.ts";

/** 全量 LoCoMo pin（仅 --allow-net）。fixture 子集不走此 URL。 */
export const LOCOMO_FULL_URL =
  process.env.DF_EVAL_LOCOMO_URL?.trim() ||
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

/** HaluMem-Medium pin（仅 --allow-net）。 */
export const HALUMEM_MEDIUM_URL =
  process.env.DF_EVAL_HALUMEM_URL?.trim() ||
  "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/main/HaluMem-Medium.jsonl";

export async function runFetch(opts: { adapter?: string; allowNet?: boolean }): Promise<number> {
  const id = opts.adapter;
  if (!id) {
    console.error("fetch 需要 --adapter <id>。示例: fetch --adapter halumem --allow-net");
    return 1;
  }
  if (!opts.allowNet) {
    console.error("fetch 需要 --allow-net（默认不联网）。无网请用 --fixture。");
    return 1;
  }

  if (id === "locomo") {
    const dir = cacheDir("locomo");
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "data.json");
    try {
      const res = await fetch(LOCOMO_FULL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      JSON.parse(text);
      await writeFile(dest, text, "utf8");
      console.log(JSON.stringify({ ok: true, adapter: "locomo", path: dest, url: LOCOMO_FULL_URL }));
      return 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `fetch locomo 失败: ${msg}。可改用 --fixture 跑仓内样例，或检查 fetch --allow-net 与 ${LOCOMO_FULL_URL}`,
      );
      return 1;
    }
  }

  if (id === "halumem") {
    const dir = cacheDir("halumem");
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "HaluMem-Medium.jsonl");
    try {
      const res = await fetch(HALUMEM_MEDIUM_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      const first = text.split("\n").find((l) => l.trim());
      if (!first) throw new Error("empty jsonl");
      JSON.parse(first);
      await writeFile(dest, text, "utf8");
      console.log(JSON.stringify({ ok: true, adapter: "halumem", path: dest, url: HALUMEM_MEDIUM_URL }));
      return 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`fetch halumem 失败: ${msg}。可改用 --fixture 或检查 ${HALUMEM_MEDIUM_URL}`);
      return 1;
    }
  }

  console.error(`未知 adapter: ${id}。已支持: locomo, halumem。仓内样例请用 --fixture`);
  return 1;
}
