# Design: 向量路优化（不对称修复 + HNSW + reranker）

- 日期：2026-09-07
- 基线：P9.2 embedding 四档（openai/onnx/local/off）、P9.3 融合（RRF+floor+cosine+hotness）、P12.1 热路径（Float32/缓存/重试）、`tokenmax.rerank` 开关默认 `off`
- 对应文件：`packages/core/src/index/sync.ts`、`retrieve/semantic.ts`、`retrieve/hybrid.ts`、`retrieve/rerank.ts`、`embed/types.ts`、`index/schema.sql`
- 关联：`2026-09-07-mixed-zh-en-tokenize-design.md`（文本处理）

## 1. 现状（人话版）

- 切块：按段落、≤800 字、无重叠，切的是原文；语义臂：全量向量捞内存暴力 cosine，每篇只留最好一块（max-pool）；重排：启发式 local + 模型插槽（`rerankFn`，生产没接真模型）；双塔链路 done，真模型只在 openai 档，无 Key 跑哈希。

## 2. 文本不对称修复（零风险，先做）

- 问题：`sync.ts:150` 切的是 `indexBody` 原文，查询嵌的是干净短问题——长文档 vs 短问题，cosine 先天亏；`cleanForIndex` 的 `semantic` 轻清洗档 chunk 没用。
- 做法：chunk 切 semantic 清洗后文本；doc 拼标题（`title + chunk` 一起嵌）；E5 式 `query:/passage:` 前缀可选。零依赖，不动表。

## 3. HNSW（已实测，PGlite 直连可用）

- 实测环境：本仓 PGlite 0.3.16（PG17.5 + pgvector 0.8.0，自带 `vector` 扩展包，开库加 `extensions: { vector }`）。
- 验证过：`CREATE EXTENSION vector` ✅；`USING hnsw (v vector_cosine_ops) WITH (m=16, ef_construction=64)` ✅；`ORDER BY v <=> $1::vector LIMIT n` 返回正确最近邻 ✅；`EXPLAIN` 走 `Index Scan using t_v_idx` ✅。
- 坑：SQL 参数必须 `$1::vector` 显式转型，否则语法错——模板里写死。
- 实施面：`chunks` 加 `vector(dims)` 列（现 BYTEA 保留当回退），建 HNSW 索引；`semanticArm` 先走索引，失败回退暴力 cosine（fail-open）；换 provider 致 dims 变沿用 `embeddingMetaMismatch → rebuild`；postgres 侧装 pgvector 扩展，同一套 SQL 双引擎。结论：不用 IVF（要训中心、运维重），HNSW 免训练、增删友好，正配 `syncPage` 语义。

## 4. reranker（收益/负担结论）

- 开关已有：`tokenmax.rerank: off/local/model`，默认 `off`，`model` 仅 tokenmax 模式生效——默认链路零影响。
- 顺序：local 加强（邻近度/多证据加权，本周级）> 本地 cross-encoder（抄 P9.2 三档 `model/local/off` + 缺权重 `E_DISABLED` 降级）> API/LLM（有 Key 才开的增强档）。
- 纯查询时模块，不碰表不重建，`--explain` 已有 `rerank:` 状态位可复用；效果用 `eval:mini` A/B 度量。

## 5. Chunk（已决策：简单版，按 ragent TextSplitter 思路）

- 参考：`ragent/blockaware/TextSplitter`（normalize：URL 断行修复、CJK 软换行合并、去 `\r`）+ 边界回溯（换行→中文句末→英文句末，回溯距离 ≤ overlap）+ overlap + Packer 尾巴合并（< minChars 并回上一块）。
- 适配：纯 TS 无依赖；加围栏 guard（跟踪 ` ``` ` 状态，不从代码围栏中间切）；`maxChars` 保持 800 不变，`overlap=100`，`minChars=200`，`eval:mini` A/B 后再调。
- 调用点唯一（`sync.ts:150`），下游逻辑一行不动（chunks 按 `${path}#${i}` 全删全插，`semanticArm`/RRF/cosine 全在篇级）。
- 存量不管：md 未变则 `content_hash` 一致直接 early-return，老块原样保留，生效靠一次全量 `rebuild-index`（`chunker` 版本进 `EmbeddingMeta`、触发已有 mismatch 流程为暂定方案）。
- 结构化升级（标题分节/表格/图片块、父子回跳）后移到 chunk 二期。

## 6. 顺序

不对称修复 → chunk 新方案 → HNSW → 查询改写/量化（万篇规模再说）。
