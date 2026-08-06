export { MemoryError, ErrorCodes, isUserError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

export { initMemoryRepo, memoryYml, brainYml, sourceMarker } from "./repo/init.ts";
export type { InitOptions } from "./repo/init.ts";
export { findRepoRoot, loadRepoConfig, resolveEnvDefaults } from "./repo/config.ts";
export type { RepoConfig } from "./repo/config.ts";
export { loadBrainConfig, resolveSourceId } from "./repo/brain.ts";
export type { BrainConfig } from "./repo/brain.ts";
export {
  resolveBrainRoot,
  resolveSourceRoot,
  assertUnderPrefix,
  normalizeRepoPath,
  brainPrefix,
  brainsRoot,
} from "./repo/layout.ts";
export type { NormalizedRepoPath } from "./repo/layout.ts";
export { gitAdd, gitCommit, gitAddAll, gitInit, gitLog, gitIsRepo, runGit } from "./repo/git.ts";

export { loadPack, stripYamlFence, DEFAULT_PACK, PACKS_DIR } from "./schema/loadPack.ts";
export type { SchemaPack } from "./schema/loadPack.ts";

export { EntityRegistryImpl, createEntityRegistry, monthDir } from "./entity/registry.ts";
export type { EntityRegistry } from "./entity/registry.ts";
export type { Entity, EntityCreateInput, EntityMergeInput, EntityListOptions } from "./entity/types.ts";
export { entityToFile, fileToEntity } from "./entity/files.ts";

export { directGitExecutor } from "./write/executor.ts";
export type { FileMutationExecutor } from "./write/executor.ts";

export { parseFrontmatter, serializeFrontmatter, hasValidFrontmatter } from "./frontmatter.ts";
export type { ParsedMd } from "./frontmatter.ts";
export { sha256Hex } from "./util/hash.ts";
export { isSlug, titleToSlug } from "./util/slug.ts";
