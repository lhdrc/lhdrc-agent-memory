export type EntityStatus = "active" | "merged";

export interface EntityFact {
  text: string;
  event_type?: string;
  attributed_to?: string;
  at: string;
  path?: string;
}

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
  facts?: EntityFact[];
}

export interface EntityLinkFactsInput {
  slug: string;
  fact: string;
  path?: string;
  by: string;
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
