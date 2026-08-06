import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import type { Entity } from "./types.ts";

const EMPTY_BODY = `## 摘要

## 正文
`;

export function entityToFile(entity: Entity): string {
  const data: Record<string, unknown> = {
    title: entity.title,
    schema_type: "entity",
    slug: entity.slug,
    status: entity.status,
    aliases: entity.aliases,
    external_ids: entity.externalIds,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
  };
  if (entity.status === "merged") {
    if (entity.redirect) data.redirect = entity.redirect;
    if (entity.mergedAt) data.merged_at = entity.mergedAt;
    if (entity.mergedBy) data.merged_by = entity.mergedBy;
    return serializeFrontmatter(data, "");
  }
  return serializeFrontmatter(data, EMPTY_BODY);
}

export function fileToEntity(raw: string): Entity {
  const { data, body } = parseFrontmatter(raw);
  const status = (data.status as string) === "merged" ? "merged" : "active";
  const aliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
  const externalIds = Array.isArray(data.external_ids) ? (data.external_ids as string[]) : [];
  const entity: Entity = {
    slug: (data.slug as string) ?? "",
    title: (data.title as string) ?? "",
    aliases,
    externalIds,
    status,
    createdAt: (data.created_at as string) ?? "",
    updatedAt: (data.updated_at as string) ?? "",
  };
  if (status === "merged") {
    entity.redirect = data.redirect as string | undefined;
    entity.mergedAt = data.merged_at as string | undefined;
    entity.mergedBy = data.merged_by as string | undefined;
  }
  return entity;
}
