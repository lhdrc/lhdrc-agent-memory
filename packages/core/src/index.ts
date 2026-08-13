export { MemoryError, ErrorCodes, isUserError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

export { initMemoryRepo, memoryYml, brainYml, sourceMarker } from "./repo/init.ts";
export type { InitOptions } from "./repo/init.ts";
export { findRepoRoot, loadRepoConfig, resolveEnvDefaults } from "./repo/config.ts";
export type { RepoConfig, WriteConfig, LayersConfig } from "./repo/config.ts";
export { loadBrainConfig, resolveSourceId, createBrain, listBrains, hasSharedSkillsMount } from "./repo/brain.ts";
export type { BrainConfig, BrainMount, CreateBrainOptions } from "./repo/brain.ts";
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
export { enrichAfterWrite } from "./write/enrich.ts";
export type { EnrichResult, EnrichOptions } from "./write/enrich.ts";
export { heuristicExtractFacts, validateFactsForAppend } from "./write/extract.ts";
export { checkDedupe } from "./write/dedupe.ts";
export type { DedupeResult } from "./write/dedupe.ts";
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
  NormalizedExperienceWrite,
  ExperienceValidationResult,
} from "./write/types.ts";

export {
  validateExperienceWrite,
  generateExperienceId,
  type ExperienceWriteInput,
} from "./write/experience-validator.ts";
export { writeExperience, patchExperienceStatus } from "./write/experience.ts";

export { createLLMProvider, isDistillEnabled, NoopLLMProvider } from "./llm/index.ts";
export type {
  LLMProvider,
  LLMConfig,
  LLMProviderId,
  DistillDecision,
  ExperienceContext,
  ExperienceResult,
} from "./llm/index.ts";

export { refineSource, mapDistillDecision, heuristicAbstract } from "./distill/refine.ts";
export type { RefineSourceOptions, RefineResult } from "./distill/refine.ts";
export { mergeExperienceFields } from "./write/experience.ts";
export { appendMemoryDiff, listMemoryDiffs, findMemoryDiff, memoryDiffRel } from "./distill/memory-diff.ts";
export type { MemoryDiffEntry, MemoryDiffOp } from "./distill/memory-diff.ts";
export { revertMemoryDiff } from "./distill/revert.ts";
export type { RevertResult } from "./distill/revert.ts";

export { readNode, parseMemoryLayer } from "./node/read.ts";
export type { ReadResult, MemoryLayer } from "./node/read.ts";
export { listTree, renderTree } from "./node/tree.ts";
export type { TreeNode } from "./node/tree.ts";
export { resolveNodeRelPath } from "./node/paths.ts";

export {
  refreshLayers,
  maybeAutoAbstract,
} from "./layers/refresh.ts";
export type { RefreshLayersOptions, RefreshLayersResult, LayerUpdate } from "./layers/refresh.ts";
export {
  heuristicOverview,
  isDerivedLayerFile,
  overviewSidecarRel,
  DIR_OVERVIEW_NAME,
} from "./layers/generate.ts";

export { openPglite, ensureSchema, clearBrainIndex } from "./index/engine.ts";
export type { IndexConnection } from "./index/engine.ts";
export { syncPage, syncEntity, syncAll, chunkText } from "./index/sync.ts";
export type { SyncOptions } from "./index/sync.ts";
export { rebuildIndex } from "./index/rebuild.ts";
export type { RebuildIndexOptions } from "./index/rebuild.ts";
export { pgliteIndexHooks } from "./index/hooks.ts";
export { readIndexMeta, writeIndexMeta, metaPath, readEmbeddingMeta, writeEmbeddingMeta, embeddingMetaPath } from "./index/meta.ts";
export type { IndexMeta, EmbeddingMeta } from "./index/meta.ts";
export { bm25Query, makeSnippet } from "./retrieve/query.ts";
export type { QueryOptions, QueryHit } from "./retrieve/query.ts";
export { semanticArm } from "./retrieve/semantic.ts";
export type { SemanticArmOptions } from "./retrieve/semantic.ts";
export { hybridQuery, hybridQueryDetailed } from "./retrieve/hybrid.ts";
export type { HybridQueryOptions, HybridQueryResult, QueryExplain } from "./retrieve/hybrid.ts";
export { bigrams } from "./retrieve/ngrams.ts";
export {
  fuseHybridArms,
  armRrfScores,
  titlePathBoostNorm,
  resolveFusionWeights,
  weightsKey,
  RRF_K,
  WEIGHTS_BALANCED_GRAPH,
  WEIGHTS_RELATION,
  WEIGHTS_PERSON,
  WEIGHTS_EXPERIENCE,
  WEIGHTS_NO_SEMANTIC,
} from "./retrieve/rrf.ts";
export type {
  RankedHit,
  FusedHit,
  SearchMode,
  FuseOptions,
  FusionWeights,
  IntentForWeights,
} from "./retrieve/rrf.ts";
export { classifyIntent } from "./retrieve/intent.ts";
export type { QueryIntent } from "./retrieve/intent.ts";
export { graphArm, parseRelationalQuery } from "./retrieve/graph.ts";
export type { RelationalParse, GraphArmOptions } from "./retrieve/graph.ts";
export {
  applyGraphSignals,
  applyGraphSignalsPure,
  SIGNAL_HUB,
  SIGNAL_CROSS_SOURCE,
  SIGNAL_DIVERSIFY,
} from "./retrieve/signals.ts";
export type { SignalExplain, ApplySignalsResult } from "./retrieve/signals.ts";
export { knobsHash, cacheKey, getSearchCache, setSearchCache, invalidateSearchCache } from "./retrieve/cache.ts";
export type { SearchKnobs } from "./retrieve/cache.ts";
export { extractEntityRefs, stripCodeBlocks, inferLinkType } from "./graph/link-extraction.ts";
export type { ExtractedLink, LinkSource } from "./graph/link-extraction.ts";
export { syncLinksForPage, deleteLinksForPath, linkRowId } from "./index/sync-links.ts";

export {
  writeSkill,
  patchSkill,
  activateSkill,
  applySkillOutcome,
  applyExperienceOutcome,
  listSkills,
  skillRelPath,
  validateSkillWrite,
  isMatureExperience,
  MATURITY_ETA_MIN,
  MATURITY_SUPPORT_MIN,
  SKILL_NAME_RE,
} from "./write/skill.ts";
export type { SkillWriteInput, SkillStatus } from "./write/skill.ts";
export { crystallizeExperiences } from "./crystallize/crystallize.ts";
export type { CrystallizeOptions, CrystallizeResult } from "./crystallize/crystallize.ts";
export { runDream } from "./dream/runner.ts";
export type { DreamOptions, DreamResult, DreamPhase, DreamPhaseResult } from "./dream/runner.ts";
export {
  appendCostEntry,
  readCostConfig,
  readCostLog,
  withCostAccounting,
  sumTokensToday,
  wouldExceedCap,
} from "./cost/logger.ts";
export type { CostConfig, CostEntry } from "./cost/logger.ts";
export { collectObserverStats, recordQueryStat } from "./observer/stats.ts";
export type { ObserverStats } from "./observer/stats.ts";

export {
  authorize,
  assertBrainScope,
  assertSourceScope,
  assertPathScope,
  issueToken,
  sha256Token,
  parseAuthConfig,
  responseContainsSecret,
} from "./auth/access-control.ts";
export type {
  AuthConfig,
  AuthContext,
  AuthRole,
  AuthChannel,
  AuthUser,
  AuthToken,
  AuthedRequest,
  BrainGrant,
} from "./auth/types.ts";
export { EMPTY_AUTH_CONFIG } from "./auth/types.ts";
export {
  filterSharedSkillsHits,
  listVisibleSharedSkills,
  isSharedSkillsPath,
  listSharedSkillNames,
} from "./auth/shared-skills.ts";

export {
  createEmbeddingProvider,
  cosineSimilarity,
  float32ToBytes,
  bytesToFloat32,
  NoopEmbedding,
  OnnxLocalEmbedding,
  OpenAIEmbedding,
} from "./embed/index.ts";
export type { EmbeddingProvider, EmbeddingConfig, EmbeddingProviderId, SearchConfig } from "./embed/index.ts";

export { parseFrontmatter, serializeFrontmatter, hasValidFrontmatter } from "./frontmatter.ts";
export type { ParsedMd } from "./frontmatter.ts";
export { sha256Hex } from "./util/hash.ts";
export { isSlug, titleToSlug } from "./util/slug.ts";
