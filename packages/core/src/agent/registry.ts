import { join, dirname } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { isSlug } from "../util/slug.ts";
import type { AuthContext } from "../auth/types.ts";
import type { FileMutationExecutor } from "../write/executor.ts";

export interface AgentRecord {
  id: string;
  sources: string[];
  createdAt: string;
}

export function agentRel(brainId: string, id: string): string {
  return `brains/${brainId}/agents/${id}.yml`;
}

export async function loadAgent(
  repoRoot: string,
  brainId: string,
  id: string,
): Promise<AgentRecord> {
  const abs = join(repoRoot, agentRel(brainId, id));
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `agent 未登记: ${id}`);
  }
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(data.sources) ? data.sources.map(String).filter(Boolean) : [];
  return {
    id: String(data.id ?? id),
    sources,
    createdAt: String(data.created_at ?? ""),
  };
}

export async function listAgents(repoRoot: string, brainId: string): Promise<AgentRecord[]> {
  const dir = join(repoRoot, "brains", brainId, "agents");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yml")).sort();
  const out: AgentRecord[] = [];
  for (const f of files) {
    const id = f.replace(/\.yml$/, "");
    try {
      out.push(await loadAgent(repoRoot, brainId, id));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export async function registerAgent(
  repoRoot: string,
  brainId: string,
  input: { id: string; sources: string[] },
  queue?: FileMutationExecutor,
): Promise<AgentRecord> {
  const id = input.id.trim();
  if (!isSlug(id)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `非法 agent id: ${id}`, { field: "id" });
  }
  const sources = [...new Set(input.sources.map((s) => s.trim()).filter(Boolean))];
  if (sources.length === 0) {
    throw new MemoryError(ErrorCodes.USAGE, "agent register 需要至少一个 --source");
  }
  for (const s of sources) {
    if (!isSlug(s)) {
      throw new MemoryError(ErrorCodes.VALIDATION, `非法 source id: ${s}`, { field: "source" });
    }
  }
  const rel = agentRel(brainId, id);
  const abs = join(repoRoot, rel);
  if (existsSync(abs)) {
    throw new MemoryError(ErrorCodes.CONFLICT, `agent 已存在: ${id}`);
  }
  const record: AgentRecord = {
    id,
    sources,
    createdAt: new Date().toISOString(),
  };
  const yaml = stringifyYaml({
    id: record.id,
    sources: record.sources,
    created_at: record.createdAt,
  });
  const write = async () => {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, yaml, "utf8");
    return [rel];
  };
  if (queue) await queue.execute(write, `agent register ${id}`);
  else await write();
  return record;
}

/** 将 token/trusted grant 与 agent 登记 source 求交（fail-closed）。 */
export function applyAgentScope(auth: AuthContext, agent: AgentRecord): AuthContext {
  const next = auth.allowedSources.includes("*")
    ? [...agent.sources]
    : auth.allowedSources.filter((s) => agent.sources.includes(s));
  if (next.length === 0) {
    throw new MemoryError(ErrorCodes.FORBIDDEN, `agent ${agent.id} 无权访问当前 brain 的任何 source`);
  }
  return { ...auth, allowedSources: next, agentId: agent.id };
}

export async function applyAgentScopeFromId(
  repoRoot: string,
  brainId: string,
  auth: AuthContext,
  agentId: string,
): Promise<AuthContext> {
  const agent = await loadAgent(repoRoot, brainId, agentId);
  return applyAgentScope(auth, agent);
}
