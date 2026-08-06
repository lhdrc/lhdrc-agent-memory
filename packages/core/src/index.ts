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
export { setSchemaPack } from "./schema/setPack.ts";

export { EntityRegistryImpl, createEntityRegistry, monthDir } from "./entity/registry.ts";
export type { EntityRegistry } from "./entity/registry.ts";
export type { Entity, EntityCreateInput, EntityMergeInput, EntityListOptions } from "./entity/types.ts";
export { entityToFile, fileToEntity } from "./entity/files.ts";

export { directGitExecutor } from "./write/executor.ts";
export type { FileMutationExecutor } from "./write/executor.ts";
export { WriteQueue, flushRepoLedger } from "./write/queue.ts";
export type { WriteJob } from "./write/queue.ts";
export { FileLock } from "./write/lock.ts";
export type { LockInfo } from "./write/lock.ts";
export { noopIndexHooks, invokeIndexHooks } from "./write/hooks.ts";
export type { IndexSyncHooks } from "./write/hooks.ts";
export { flushDirtyLedger } from "./write/flush.ts";
export type { FlushResult } from "./write/flush.ts";
export type { ExecuteOptions, FlushReason, GitMode } from "./write/flush-policy.ts";
export { shouldForceCommit, shouldBatchFlush } from "./write/flush-policy.ts";
export { readDirtyState, addDirtyPaths, clearDirtyState, writeDirtyState } from "./write/dirty.ts";
export type { DirtyState } from "./write/dirty.ts";
export { WriteValidator, todayUtc } from "./write/validator.ts";
export { captureNode, buildMarkdownBody } from "./write/capture.ts";
export type { CaptureOptions } from "./write/capture.ts";
export { forgetNode } from "./write/forget.ts";
export { importNode, importPath } from "./write/import.ts";
export type { ImportOptions, ImportedFile } from "./write/import.ts";
export type {
  CreateNodeRequest,
  NormalizedWrite,
  ValidationResult,
  ValidationError,
  NodeStatus,
  Link,
  Fact,
} from "./write/types.ts";

export { readNode } from "./node/read.ts";
export type { ReadResult } from "./node/read.ts";
export { listTree, renderTree } from "./node/tree.ts";
export type { TreeNode } from "./node/tree.ts";
export { resolveNodeRelPath } from "./node/paths.ts";

export { openPglite, ensureSchema } from "./index/engine.ts";
export type { IndexConnection } from "./index/engine.ts";
export { syncPage, syncEntity, syncAll, chunkText } from "./index/sync.ts";
export { rebuildIndex } from "./index/rebuild.ts";
export { pgliteIndexHooks } from "./index/hooks.ts";
export { readIndexMeta, writeIndexMeta, metaPath } from "./index/meta.ts";
export type { IndexMeta } from "./index/meta.ts";
export { bm25Query, makeSnippet } from "./retrieve/query.ts";
export type { QueryOptions, QueryHit } from "./retrieve/query.ts";
export { bigrams } from "./retrieve/ngrams.ts";

export { parseFrontmatter, serializeFrontmatter, hasValidFrontmatter } from "./frontmatter.ts";
export type { ParsedMd } from "./frontmatter.ts";
export { sha256Hex } from "./util/hash.ts";
export { isSlug, titleToSlug } from "./util/slug.ts";
