import { createHash } from "node:crypto";

export interface CrossFileFinding {
  pathA: string;
  factIndexA: number;
  pathB: string;
  factIndexB: number;
  cosine?: string;
}

const LINE_RE =
  /- (?:duplicate|contradiction supersede) cosine=(\S+)\s+`([^`]+)`\s+facts\[(\d+)\]\s*(?:↔|→)\s*`([^`]+)`\s+facts\[(\d+)\]/g;

export function pairIdOf(f: CrossFileFinding): string {
  const key = `${f.pathA.replace(/\\/g, "/")}#${f.factIndexA}|${f.pathB.replace(/\\/g, "/")}#${f.factIndexB}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

export function parseCrossFileFindings(md: string): CrossFileFinding[] {
  const heading = md.search(/^##\s+cross-file\s*$/m);
  if (heading < 0) return [];
  let section = md.slice(heading);
  const next = section.slice(1).search(/\n##\s+/);
  if (next >= 0) section = section.slice(0, next + 1);
  const out: CrossFileFinding[] = [];
  const re = new RegExp(LINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) && out.length < 100) {
    out.push({
      cosine: m[1],
      pathA: m[2]!.replace(/\\/g, "/").trim(),
      factIndexA: Number.parseInt(m[3]!, 10),
      pathB: m[4]!.replace(/\\/g, "/").trim(),
      factIndexB: Number.parseInt(m[5]!, 10),
    });
  }
  return out;
}
