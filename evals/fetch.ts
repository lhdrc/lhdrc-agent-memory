import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./lib/paths.ts";

/** 全量 LoCoMo pin（仅 --allow-net）。fixture 子集不走此 URL。 */
export const LOCOMO_FULL_URL =
  process.env.DF_EVAL_LOCOMO_URL?.trim() ||
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export async function runFetch(opts: { adapter?: string; allowNet?: boolean }): Promise<number> {
  const id = opts.adapter;
  if (!id) {
    console.error("fetch 需要 --adapter <id>。示例: fetch --adapter locomo --allow-net");
    return 1;
  }
  if (id !== "locomo") {
    console.error(`未知 adapter: ${id}。已支持 locomo。仓内样例请用 --fixture，全量请 fetch --allow-net`);
    return 1;
  }
  if (!opts.allowNet) {
    console.error("fetch 需要 --allow-net（默认不联网）。无网请用 --fixture。");
    return 1;
  }
  const dir = cacheDir("locomo");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, "data.json");
  try {
    const res = await fetch(LOCOMO_FULL_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
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
