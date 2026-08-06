export type EntityStatus = "active" | "merged";

export interface Entity {
  slug: string;
  title: string;
  aliases: string[];
  externalIds: string[];
  status: EntityStatus;
  redirect?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedBy?: string;
}

export interface EntityCreateInput {
  slug: string;
  title: string;
  aliases?: string[];
  externalIds?: string[];
  createdBy: string;
}

export interface EntityMergeInput {
  entityIds: string[];
  canonical: string;
  confirm: boolean;
  mergedBy: string;
}

export interface EntityListOptions {
  includeMerged?: boolean;
}
