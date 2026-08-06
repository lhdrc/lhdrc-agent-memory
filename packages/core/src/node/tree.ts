import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export async function listTree(
  repoRoot: string,
  brainId: string,
  relDir: string = `brains/${brainId}`,
  depth = 3,
): Promise<TreeNode[]> {
  const baseAbs = join(repoRoot, relDir);
  if (!existsSync(baseAbs)) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `目录不存在: ${relDir}`);
  }

  const walk = async (abs: string, rel: string, d: number): Promise<TreeNode[]> => {
    const entries = await readdir(abs);
    entries.sort((a, b) => a.localeCompare(b));
    const out: TreeNode[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await stat(childAbs);
      if (st.isDirectory()) {
        const node: TreeNode = { name, path: childRel, type: "dir" };
        if (d < depth) node.children = await walk(childAbs, childRel, d + 1);
        out.push(node);
      } else {
        out.push({ name, path: childRel, type: "file" });
      }
    }
    return out;
  };
  return walk(baseAbs, relDir, 0);
}

export function renderTree(nodes: TreeNode[], prefix = ""): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${prefix}${node.type === "dir" ? node.name + "/" : node.name}`);
    if (node.children?.length) {
      lines.push(...renderTree(node.children, prefix + "  "));
    }
  }
  return lines;
}
