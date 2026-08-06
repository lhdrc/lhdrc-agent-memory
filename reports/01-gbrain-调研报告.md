# GBrain 深度调研报告

> 调研对象：`D:\memory_projects\gbrain`（[garrytan/gbrain](https://github.com/garrytan/gbrain)）
> 调研日期：2026-08-02 ｜ 语言：中文
> 报告定位：分析 GBrain 的优点、特点、实现亮点、技术栈与缺点，辅以项目公开的数据支撑（均标注出处）。

---

## 一、项目概述

**定位**：GBrain 自称是 AI Agent 缺失的"大脑层"（brain layer）——**Search 给你原始页面，GBrain 给你答案**，将"综合回答（synthesis）+ 图谱遍历（graph traversal）+ 差距分析（gap analysis）"三者合一放进一个盒子（`README.md:3`）。它既可作为独立运行的自主 Agent daemon，也可用一条命令作为 Claude Code / Codex 的超强检索层接入。

- **作者与背景**：Garry Tan（Y Combinator 总裁兼 CEO），为运行自己的 AI Agent 而构建，是其 OpenClaw 与 Hermes 部署背后的"生产大脑"（`README.md:5`）。
- **生产规模宣称**：146,646 页面 / 24,585 人 / 5,339 家公司 / 66 个 cron 任务自主运行；Agent 在作者睡眠时摄入会议、邮件、推文、语音、原创想法，自动富化每个人/公司，修正自己的引用，夜间合并记忆（`README.md:5`）。
- **许可证**：MIT（`README.md:466`）。
- **语言与工具链**：Bun / TypeScript，Postgres 原生（`package.json`）。两个引擎：**PGLite**（WASM 内嵌 Postgres，零配置、默认）与 **Postgres + pgvector**（Supabase / 自托管），二者由同一 `BrainEngine` 契约驱动。
- **两种接入形态**：
  1. 全自主 agent（autopilot/daemon，24/7 dream cycle 自动富化）；
  2. 作为 Claude Code / Codex 的记忆层：`gbrain init --pglite` + `claude mcp add gbrain -- gbrain serve`，或远程 `gbrain connect ... --install`（`README.md:98-116`）。
- **分发注意**：GBrain 不在 npm 分发，npm 上的 `gbrain` 是同名无关包，官方有醒目警告（`README.md:66-77`）。安装仅通过 `bun install -g github:garrytan/gbrain` 或 git clone + `bun install && bun link`。
- **生态**：43~60+ 个 markdown 技能（`skills/`）、MCP server（30+ 工具）、公司级团队部署（company-brain 教程）、第三方 skillpack 可插拔摄取源。

---

## 二、核心理念与理论

GBrain 的起源（`docs/ethos/ORIGIN.md`）源于作者自用 agent 的记忆痛点：

1. **跨会话遗忘**——每周介绍过的人，下周一名字就没了；
2. **重复工作**——同一公司的两个信号变成两个 person 页，与同一人的三次会面变成三条不相关 timeline 条目，信噪比实时恶化。

作者明确主张：**贡献不是某个单一新点子，而是"把一整套工程做法打包在一起"**（`ORIGIN.md`）：

- 写页面时自动建链（auto-link），让图"免费增长"；
- 带类型的边（typed edges），让"谁在 Acme 工作"真的能被答出来；
- 混合检索（vector 单独不够）；
- 其上再加 reranker（混合检索局部最优、全局次优）；
- 夜间 cron 做去重/富化/修引用/暴露矛盾；
- 一个 Agent 读一次 `skills/RESOLVER.md` 就知道该做什么。

三个反直觉的工程选择（`ORIGIN.md:13-25`）：**Postgres+pgvector 跑在 WASM 上（无服务器）；skills 是 markdown 而非代码；由小文本文件路由而非 router LLM**。

**North Star**（`CLAUDE.md:10-19`）：做"下一个 Postgres for memory"，目标是公司级脑库与个人 AI，主张**全系统最优**（跨检索/长会话/校准等多基准全谱系），并明确禁止"证明 gbrain 打败某算法"式的 off-mission 研究对比。

贯穿全项目的工程哲学：

- **零 LLM 也能跑**：大量关键路径是确定性纯函数/正则（链接类型推断、意图分类、关系查询解析、矛盾分类的 cosine 快路径），LLM 只用于富化与综合；且每个 LLM 调用点都讲究 fail-open / 可降级。
- **契约优先**：`src/core/operations.ts` 是 ~90 个共享 operation 的唯一来源，CLI 与 MCP server 都由它生成；HTTP dispatch 在 handler 执行前强制 scope/localOnly（`CLAUDE.md:41-44,87-89`）。
- **"大脑即数据库、skill 即 markdown、路由即文本文件"**——一切可审计、可版本化、无隐藏状态。

---

## 三、架构

### 3.1 双轴心智模型（关键）

- **Brain = 哪个数据库**：个人 brain 是 `host`，可 mount 额外 brain（团队发布，各自 DB 与访问策略）。
- **Source = 数据库里的哪个仓库**：一个 brain 可装多个 source（wiki/gstack/openclaw/essays），slug 按 source 唯一（复合主键 `(source_id, slug)`）。

Source 解析链 7 层（`src/core/source-resolver.ts`），从 `--source` flag 一路降级到字面 `'default'`，避免单 source brain 的静默错路由（`skills/conventions/brain-routing.md:49-70`）。

### 3.2 引擎层

- `BrainEngine` 抽象契约定义于 `src/core/engine.ts`，两个实现：**PGLiteEngine** 与 **PostgresEngine**。
- **Engine parity 铁律**（`CLAUDE.md:83-86`）：两引擎必须锁步，新方法/SQL 必须同时落地两边，由 `test/e2e/engine-parity.test.ts` 钉住——防止 PGLite 隐藏 Postgres 某些 bug（如 JSONB 参数拼写）。
- 部署拓扑：单 brain / 跨机 thin client / split-engine（`docs/architecture/topologies.md`）。
- 迁移：全部 schema DDL 在 `src/core/migrate.ts` 的 `MIGRATIONS` 数组，版本已到 v100+。

### 3.3 表面层

- **CLI + MCP 同源**：~90 个 operation 定义在 `src/core/operations.ts`，带 `scope: read|write|admin` + 可选 `localOnly`；MCP 工具从 operations 生成。
- **信任边界（critical）**：`OperationContext.remote` 区分可信本地 CLI 调用者（`remote=false`）与不可信 agent 端（`remote=true`）。安全敏感操作（如 file_upload）在 remote 时收紧文件系统限制，**fail-closed**（不严格为 false 即视为 remote）（`AGENTS.md` Trust boundary 节）。
- **Source 隔离铁律**：所有读侧 op 走 `sourceScopeOpts(ctx)`，优先级 federated allowedSources > scalar sourceId > nothing，禁止手写 source 过滤——漏一线即跨 source 数据泄漏。

### 3.4 技能系统

- 60+ 技能，`skills/RESOLVER.md` 是调度器；always-on 的 signal-detector（每消息触发）与 brain-ops。
- **路由表压缩研究**（v0.32.3.0）：`functional-area-resolver` 两层分发模式把大 RESOLVER 压缩 48% 体积且准确率 +13~17pp（`CLAUDE.md:305-328`）。
- **Iron Law back-link**（`skills/conventions/quality.md:23-30`）：提到有 brain 页面的人/公司必须 back-link 到提及页，每条事实必须带 `[Source: ...]` 内联引用。

---

## 四、记忆核心实现（写入管线与数据模型）

### 4.1 核心表/对象

`pages`（含 compiled_truth、synopsis、type、source_id、frontmatter provenance/status）、`chunks`（embedding 列）、`links`（typed edges，v98 加 link_kind）、`facts`（v0.31 hot memory，v82 加 event_type，含 claim_metric/value/unit/period）、`takes`（kind=fact/take/bet/hunch）、`timeline`、`sources`、`query_cache`（v56 加 knobs_hash）。

**compiled_truth**：brain 对实体的综合理解（synthesis 产物），检索命中时 2.0x boost。

### 4.2 写入管线：auto-link（零 LLM）

`src/core/link-extraction.ts`：每次 `put_page` 跑 `extractEntityRefs`，四 pass 抽取实体（markdown 链接 / qualified wikilink / Obsidian wikilink / generic wikilink）。先 `stripCodeBlocks`，用 masked-ranges 防双发。链接批量写入用单个 SQL `INSERT ... SELECT FROM jsonb_to_recordset(...)`（自由文本安全）。17K 页 brain 上全图抽取秒级完成（`RETRIEVAL.md:43`）。

**`inferLinkType()`（零 LLM 正则规则）**：page-type 绑定（media→mentions、image→image_of、meeting→attended）；动词正则（FOUNDED_RE→founded、INVESTED_RE→invested_in、ADVISES_RE→advises、WORKS_AT_RE→works_at）；含中文模式 ZH_FOUNDED_RE 等。

### 4.3 Hot Memory / facts 子系统（v0.31）

`src/core/facts/`：

- **extract.ts**：turn-extractor，含注入模式消毒、Haiku 严格 JSON 抽取、4-strategy 容错解析。
- **classify.ts**：矛盾分类器，核心是 **cheap fast-path**——top 候选 cosine ≥ 0.95 直接判 DUPLICATE 跳过 LLM（最便宜的准确去重）；LLM 分类 duplicate|supersede|independent；LLM 失败时 cosine ≥ 0.92 兜底为 DUPLICATE。
- **backstop.ts**：统一 facts 管道（extract→resolve→dedup@0.95→insert），替换五个分叉实现为单一 choke point。

### 4.4 升华：consolidate.ts（facts→takes）

规则：<3 条事实或最老事实 <24h 则跳过；embedding cosine 贪心聚类阈值 **0.85**；取 cluster 内最高置信度 fact 文本为 take claim（v0.31 无 LLM，保持确定性；TODO 注明 v0.32 用 Sonnet 重写）。contributing facts 标记 consolidated_at/consolidated_into，**永不 DELETE**。

### 4.5 dream cycle（夜间记忆循环）

`src/core/cycle.ts`：`gbrain dream` / `autopilot` 的 9 个 phase：lint → backlinks → sync → synthesize → extract → patterns → recompute_emotional_weight → embed --stale → orphans。用 `gbrain_cycle_locks` 行 + 30min TTL（PGLite 用文件锁）防并发。这是"醒来比睡去更聪明"的实现载体。

### 4.6 轨迹与 think 管线

- **find_trajectory**（v0.35.4）：按 (metric,value) 连续对检测回归（新值比旧值低 ≥10% 触发），Drift score = `1 - mean(cosine(emb[i], emb[i-1]))`。
- **think 管线**（v0.28.0）：INTENT → GATHER → SYNTHESIZE →（可选 COMMIT）。intent 用零 LLM 正则分类（temporal/knowledge_update/other），gather 四个 retriever 并行（hybrid / takes_kw / takes_vec / graph），RRF k=60 融合。

---

## 五、检索算法（核心中的核心）

### 5.1 四层策略与"为什么单打独斗都失败"

`docs/architecture/RETRIEVAL.md`：

1. **Vector（pgvector HNSW）**——语义相似。单独失败：任何没直接编码进 embedding 的事实关系都丢。
2. **BM25 keyword（tsvector）**——字面匹配。单独失败：对措辞脆弱，同义词/近似表达全是垃圾。
3. **RRF**——融合 vector+keyword 排名，各投一票。
4. **知识图谱 typed-edge 遍历**——"Bob 这季度投了什么"走 `bob ──invested_in──> company ──dated──> Q1`；单独失败：对未建链的新页是瞎子。

**BrainBench 数据**（`RETRIEVAL.md:22-33`、`README.md:12`）：

| Strategy | P@5 | R@5 | 备注 |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | lexical-only 基线 |
| vector-only RAG | ~18 | ~80 | 标准 RAG |
| gbrain graph-disabled | ~18 | ~85 | 仅混合 |
| **gbrain 全栈** | **49.1** | **97.9** | graph + extract-quality 提升 |

**结论：+31.4 分 P@5 来自图与抽取质量；"图不是边缘功能，是承重墙"**。

### 5.2 hybrid 管线

pipeline = keyword+vector → **RRF（score=sum(1/(60+rank))）** → normalize → boost → **cosine re-score（0.7*rrf + 0.3*cosine）** → dedup；compiled_truth boost 2.0x（`src/core/search/hybrid.ts`）。

### 5.3 Graph signals（v0.40.4.0）

三个 additive 信号：

1. **Adjacency-within-top-K ~1.05×**：≥2 个 top-K 页链入 = hub；
2. **Cross-source adjacency ~1.10×**：≥2 个不同 source 链入 = federated-team hub；
3. **Session diversification ~0.95×**：同 session 前缀的多个 top-K 页 demote（MMR-lite）。

受 floor-gate 保护，fail-open。

### 5.4 Relational recall arm（v0.43）

把"关系型查询"（"谁投资了 widget-co"）当作**第四 RRF arm**：解析 seed 实体（confidence-gated）→ engine.relationalFanout（within-source, deterministic）→ batch-hydrate。确定性、Precision-first、有 STOPWORD 拒绝与 ReDoS 防御。

### 5.5 命名实体检索四层

- **Per-page max-pool**：`DISTINCT ON (slug)` 在 LIMIT 前把 chunk 折叠成每页最佳 chunk。
- **Title-phrase boost**：查询是 title 内连续 token 串时 boost。
- **Alias hop**：frontmatter `aliases:` 投影进 `page_aliases`，查询时桥接零表面重合的真同义词。
- **Evidence contract**：每个结果带 `evidence` + `create_safety`（exists|probable|unknown），让 agent 判断"是否已存在、别写重复页"。

### 5.6 Reranker 与查询改写

- **zerank-2 reranker**（默认开）：真实语料 20 查询上把 **60% 的 top-1 结果重排**（+150ms p50、~$0.025/M tokens）（`RETRIEVAL.md:47-53`）。
- **Intent-aware 查询改写**：确定性 intent 分类（entity/temporal/event/general）+ tokenmax 模式下的 multi-query expansion（Haiku 生成 2-3 变体）。**诚实披露：LongMemEval 上 expansion 是干净零结果**（text-embedding-3-large 已弥合差距）。

### 5.7 完整 query op 管线

```
intent classify → expansion(可选) → hybrid（vector + keyword + relational + source-aware + RRF → top 30）
→ graph augment → reranker(zerank-2) → token-budget enforcement → dedup → results
```

每阶段可独立测试、可替换；orchestration 成本 <1ms。

---

## 六、团队 / 多用户能力（公司级脑库）

个人 brain → 公司 brain = **同一架构加三样东西**（`docs/tutorials/company-brain.md`）：

1. 同 brain 内多 source；
2. 每用户 OAuth 登录 + scopes，brain 在 **SQL 层拒绝跨 source 读**（database-enforced 隔离）；
3. 每用户子文件夹、cron、skill。

- **规模假设**：10-50 人公司；25 人 <$100/月；宣称全读路径 fuzz 测试零泄漏。
- **两种 scoping 模型**：
  - **Model A**：每成员独立 OAuth client，`--source` + `--federated-read` flags，隔离 DB 强制；
  - **Model B**：单 source + `partners/<slug>/` 目录约定，per-person client 用 `--bound-slug-prefixes` 绑定，越界写被拒绝（v0.42.72.0+）。
- **OAuth 2.1 Provider**（`src/core/oauth-provider.ts`，1252 行）：client 注册、authorization code + PKCE、client credentials、token refresh + rotation、revocation；**agent 级绑定**（boundTools/boundSourceId/boundSlugPrefixes/boundMaxConcurrent/budgetUsdPerDay）。
- **Federation 是 latent-space only**：跨 brain 由 agent 决定；同 brain 内跨 source 有 cross-source adjacency 信号与关系 arm 的多 source fan-out。

---

## 七、数据支撑（Benchmark + 出处）

> 所有数字按各自出处引用，不混用；部分含方法论 caveat（GBrain 刻意保持诚实披露文化）。

| 数据 | 数值 | 出处 |
|---|---|---|
| 生产规模 | 146,646 pages / 24,585 people / 5,339 companies / 66 cron | `README.md:5` |
| BrainBench | P@5 49.1% / R@5 97.9% / +31.4 P@5 | `README.md:12`、`RETRIEVAL.md:22-33` |
| LongMemEval | **R@5 97.60%**（超 MemPalace raw 96.6% 约 1 点） | `CHANGELOG.md:16107-16186`、gbrain-evals 仓库 |
| LongMemEval 分项 | single-session-assistant 100% vs 92.9%(+7.1)；temporal-reasoning 94.7% vs 96.2%(-1.5) | 同上 |
| 诚实披露 1 | vector-only K=5 上几乎等价（97.4 vs 97.6） | 同上 |
| 诚实披露 2 | query expansion 干净零结果 | `CHANGELOG.md:16151-16154` |
| 方法论披露 | harness 对 haystack 跑 Haiku 预处理，发布的是 "gbrain + Haiku-preprocess" | `CHANGELOG.md:9043` |
| reranker 效果 | zerank-2 重排 60% top-1 | `RETRIEVAL.md:49` |
| 抽取性能 | 17K 页 brain 全图抽取秒级 | `RETRIEVAL.md:43` |
| 成本事故 | `gbrain lsd` 估计 $0.96 实际 $50.71（53×） | `docs/incidents/2026-05-20-lsd-cost-explosion.md` |
| attribution | 100,720 takes 5 维交叉模态 eval，attribution 6.5/10 | `CHANGELOG.md:14849-14859` |

---

## 八、优点

1. **工程纪律极强**：契约优先（operations.ts 单源生成 CLI+MCP）、双引擎 parity 测试、JSONB 双拼写防坑脚本、CLAUDE.md 大小上限 + CI 强制。教科书级 agent-OS 工程。
2. **零 LLM 可跑 + fail-open 全面**：链接推断/意图/关系解析/矛盾快路径全是确定性纯函数，任何 LLM 依赖点有降级路径。成本与延迟被当一等公民设计（search mode 成本矩阵、max-usd cap、10 秒成本预览）。
3. **评测文化深入**：BrainBench/LongMemEval/Replay captures；"haters-immune"方法论（不用私有数据、public split pin commit、paired-bootstrap + Bonferroni）。
4. **诚实披露**：Haiku-preprocess 披露、query expansion 零结果发布、temporal-reasoning 弱项承认。
5. **自主维护闭环**：dream cycle 9 阶段 + `doctor --remediate`（依赖排序、cost cap）。
6. **信任边界清晰**：remote 标志 + fail-closed + source 级 SQL 隔离 + OAuth slug-prefix 绑定——多用户隔离是设计目标不是补丁。
7. **文档与 agent 协作一体化**：AGENTS.md/CLAUDE.md/RESOLVER.md/KEY_FILES.md 分层，skills 是 markdown（可版本化、可评审、可发布）。

---

## 九、缺点 / 局限

1. **单机偏好**：PGLite 默认，Postgres 仅在 1000+ 文件才建议；thin-client 二进制长期 deferred。
2. **关系/图能力有明确 v1 边界**：relational recall 跨 source 遍历是 v1 限制；`intro`/`connects` 是 type-agnostic（没有 `introduced`/`knows` 边）。
3. **consolidate 确定性但粗糙**：v0.31 无 LLM 聚类，take claim 质量上限受限（TODO 用 Sonnet 重写）。
4. **think rounds>1 无 gap-fill 逻辑**。
5. **LongMemEval 偏斜**：语料偏英语 + 技术向，非技术/非英文 brain 未测。
6. **temporal-reasoning 是已知弱项**（-1.5 vs MemPalace）。
7. **attribution 6.5/10** 是 100K takes 交叉模态 eval 的主要失败模式。
8. **内部工具假设 macOS**：README 安装引导、darwin-arm64 编译；Windows 支持路径不明确。
9. **无内置团队权限 UI**：company-brain 的授权管理靠 CLI/OAuth，对非技术用户门槛较高。

---

## 十、可借鉴点（站在"团队项目记忆系统"角度）

1. **检索 = 多路召回 + RRF，而不是单一向量**。对团队 wiki/代码/会话混合语料，BM25 的 lexical 兜底比纯向量稳得多。
2. **"零 LLM 边"是性价比之王**：typed edges + 零 LLM 正则抽取 + graph traversal，让关系查询不依赖重训 embedding——写文档时自动抽 `[链接]+动词` 建知识图，团队系统可直接抄。
3. **记忆闭环 = 写入钩子 + 夜间维护**：auto-link on every write + dream cycle（synthesize/extract/patterns/embed/consolidate）+ 确定性规则，比"定期整库重处理"便宜、可审计得多。
4. **成本是第一等公民**：search mode 档位化 + cost cap / preview / kill-switch，多用户系统最该抄。
5. **可复现评测门槛**：不用私有数据、public split pin commit、harness 不碰用户 brain、per-run record + receipt 绑定。
6. **契约优先 + 双引擎 parity**：一个 operation 定义生成 CLI + MCP + scope 强制；对要服务多 client 的团队系统是直接模板。
7. **信任边界显式化**：`remote` 标志 + fail-closed + source 级 SQL 隔离 + per-person slug 前缀绑定——多成员共享记忆库的权限模型应 DB 层强制，而非 UI 隐藏。
8. **事故复盘文化**：成本爆炸 incident 文档化根因 + 修复 + 防回归，落库可检索——"估算与执行语义鸿沟"值得任何记忆系统写成模板。

---

## 附：关键文件索引

- `README.md`、`AGENTS.md`、`CLAUDE.md`
- `src/core/operations.ts`（operation 契约）、`src/core/engine.ts`（BrainEngine 接口）
- `src/core/search/hybrid.ts`、`src/core/search/graph-signals.ts`、`src/core/search/relational-recall.ts`
- `src/core/facts/`（extract/classify/backstop）、`src/core/cycle.ts`（dream cycle）、`src/core/think/`
- `src/core/oauth-provider.ts`（OAuth 2.1）
- `docs/architecture/RETRIEVAL.md`、`docs/tutorials/company-brain.md`、`docs/ethos/ORIGIN.md`
