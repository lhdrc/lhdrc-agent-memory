import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheDir } from "./lib/paths.ts";
import { parseJsonl } from "./lib/jsonl.ts";

/** 全量 LoCoMo pin（仅 --allow-net）。fixture 子集不走此 URL。 */
export const LOCOMO_FULL_URL =
  process.env.DF_EVAL_LOCOMO_URL?.trim() ||
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

const GMB_REPO =
  process.env.DF_EVAL_GMB_BASE?.trim() ||
  "https://raw.githubusercontent.com/UCSB-NLP-Chang/GroupMemBench/main";

const ORGMEM_SMALL =
  process.env.DF_EVAL_ORGMEM_BASE?.trim() ||
  "https://raw.githubusercontent.com/JackCGardner/OrgMemBench/main/datasets/helix/small";

const KNOWN = ["locomo", "groupmembench", "orgmembench"] as const;

async function download(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchLocomo(): Promise<{ path: string; url: string }> {
  const dir = cacheDir("locomo");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, "data.json");
  const text = await download(LOCOMO_FULL_URL);
  JSON.parse(text);
  await writeFile(dest, text, "utf8");
  return { path: dest, url: LOCOMO_FULL_URL };
}

async function fetchGroupMem(): Promise<{ path: string; url: string }> {
  const domain = process.env.DF_EVAL_GMB_DOMAIN?.trim() || "Technology";
  const qtype = process.env.DF_EVAL_GMB_QTYPE?.trim() || "knowledge_update";
  const dir = join(cacheDir("groupmembench"), domain);
  await mkdir(dir, { recursive: true });
  const channelsUrl = `${GMB_REPO}/data/final/${domain}/synthetic_domain_channels_rolevariants_${domain}.json`;
  const questionsUrl = `${GMB_REPO}/questions/${domain}/${qtype}.jsonl`;
  const channels = await download(channelsUrl);
  JSON.parse(channels);
  const questions = await download(questionsUrl);
  parseJsonl(questions);
  const dest = join(dir, "channels.json");
  await writeFile(dest, channels, "utf8");
  await writeFile(join(dir, `${qtype}.jsonl`), questions, "utf8");
  return { path: dest, url: channelsUrl };
}

async function fetchOrgMem(): Promise<{ path: string; url: string }> {
  const dir = cacheDir("orgmembench");
  await mkdir(dir, { recursive: true });
  const benchUrl = `${ORGMEM_SMALL}/benchmark_v0.0.jsonl`;
  const indexUrl = `${ORGMEM_SMALL}/corpus_index.jsonl`;
  const bench = await download(benchUrl);
  const indexText = await download(indexUrl);
  parseJsonl(bench);
  const index = parseJsonl(indexText) as Array<{ path?: string }>;
  await writeFile(join(dir, "benchmark_v0.0.jsonl"), bench, "utf8");
  await writeFile(join(dir, "corpus_index.jsonl"), indexText, "utf8");
  for (const row of index) {
    const rel = String(row.path ?? "").replace(/\\/g, "/");
    if (!rel) continue;
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    const body = await download(`${ORGMEM_SMALL}/${rel}`);
    await writeFile(abs, body, "utf8");
  }
  return { path: dir, url: ORGMEM_SMALL };
}

export async function runFetch(opts: { adapter?: string; allowNet?: boolean }): Promise<number> {
  const id = opts.adapter;
  if (!id) {
    console.error("fetch 需要 --adapter <id>。示例: fetch --adapter groupmembench --allow-net");
    return 1;
  }
  if (!KNOWN.includes(id as (typeof KNOWN)[number])) {
    console.error(`未知 adapter: ${id}。已支持 ${KNOWN.join(", ")}。仓内样例请用 --fixture，全量请 fetch --allow-net`);
    return 1;
  }
  if (!opts.allowNet) {
    console.error("fetch 需要 --allow-net（默认不联网）。无网请用 --fixture。");
    return 1;
  }
  try {
    const result =
      id === "locomo" ? await fetchLocomo() : id === "groupmembench" ? await fetchGroupMem() : await fetchOrgMem();
    console.log(JSON.stringify({ ok: true, adapter: id, path: result.path, url: result.url }));
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`fetch ${id} 失败: ${msg}。可改用 --fixture 跑仓内样例，或检查 fetch --allow-net。`);
    return 1;
  }
}
