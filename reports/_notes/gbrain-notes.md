# GBrain 深度调研笔记

> 调研对象：`D:\memory_projects\gbrain`（Garry Tan 的 agent 记忆系统，GStack/OpenClaw 生态）
> 调研性质：纯研究，未写任何代码
> 日期：2026-08-02
> 说明：所有数字均标注出处（文件路径/版本/链接）；凡不确定处均如实标注，不编造。

---

## 1. 项目概述

**定位一句话**：Search 给你原始页面，GBrain 给你答案（"synthesis + graph traversal + gap analysis 三合一"），是 agent 的"大脑层"。来源 `README.md:3`。

- **作者/背景**：Garry Tan，Y Combinator President/CEO。为自用 agent 构建，是作者 OpenClaw 与 Hermes 部署背后的生产大脑。来源 `README.md:5`。
- **生产规模宣称**（README，2026-08 时点）：**146,646 pages / 24,585 people / 5,339 companies / 66 cron jobs**，agent 在作者睡眠时摄入会议、邮件、推文、语音、原创想法并富化/修引用/合并记忆。来源 `README.md:5`。注：早期数字见 ORIGIN.md（17,888 pages / 4,383 people / 723 companies / 21 cron），两处为不同时期，需按出处分别引用。
- **一句话卖点**（README hero）：比"搜索返回页面列表"更进一步——返回带引用的综合答案 + 明确标注"大脑还不知道什么"（gap analysis）。示例见 README "meeting with Alice" 场景。来源 `README.md:24-64`。
- **两种接入方式**：
  1. 独立全自主 agent（autopilot/daemon，24/7 dream cycle 自动富化）。
  2. 作为 Claude Code / Codex 的记忆层，一条命令接入 MCP：`gbrain init --pglite` + `claude mcp add gbrain -- gbrain serve`，或远程 `gbrain connect https://your-host/mcp --token ... --install`。来源 `README.md:98-116`。
- **company-brain 卖点**：每成员登录后只见自己被授权的内容，宣称全读路径 fuzz 测试零泄漏；直接对标 YC 的 Company Brain RFS。来源 `README.md:7`、`docs/tutorials/company-brain.md`。
- **技术栈**（`package.json`）：Postgres-native、type=module、Bun 生态；双引擎 PGLite（嵌入式 WASM Postgres，零配置默认）与 Postgres+pgvector（Supabase）；`bin=src/cli.ts`，导出 engine/types/operations/search/hybrid/pglite-engine/engine-factory 等子路径。交叉编译 darwin-arm64 + linux-x64 二进制的脚本。定位 "Postgres-native personal knowledge brain with hybrid RAG search"。
- **安装**：**不在 npm 分发**（README 有明确警告，npm 上 `gbrain` 是无关同名包）；唯一路径 `bun install -g github:garrytan/gbrain` 或 git clone + bun install && bun link。来源 `README.md:66-77`。

---

## 2. 核心理念 / 理论

**起源故事**（`docs/ethos/ORIGIN.md`）：GBrain 源于作者的 OpenClaw agent fork。原版"大脑"是平面 markdown 目录 + ripgrep 搜索 + "vibes"式记忆，暴露两个问题：
1. **跨会话遗忘**——每周介绍过的人下周一名字就没了，周二的决定活不到周四；
2. **重复工作**——同一公司的两个信号变成两个 person 页面，与同一人的三次会面变成三条不相关的 timeline 条目，信噪比实时恶化。

**核心主张：贡献不是单个新点子，而是"全部打包在一起"**。ORIGIN.md 逐条列出（每条都不是新的）：
- 写任何页面时自动建链（auto-link），让图免费增长；
- 带类型的边（typed edges），让"谁在 Acme 工作"真的能答出来；
- 混合检索（vector 单独不够）；
- 其上再加 reranker（混合检索局部最优、全局次优）；
- 夜间 cron 去重/富化/修引用/暴露矛盾；
- 一个 agent 读一次 `skills/RESOLVER.md` 就知道该做什么。
- **工程打包方式的三个反直觉选择**：Postgres+pgvector 跑在 WASM 上（无服务器）、skills 是 markdown 而非代码、由小文本文件路由而非 router LLM。来源 `docs/ethos/ORIGIN.md:13-25`。

**North Star（CLAUDE.md:10-19）**：做"下一个 Postgres for memory"——给公司 brain 与个人 AI 用，目标十亿用户；主张是**全系统最优**（跨 BrainBench 全谱系：retrieval/longmemeval/calibration 等），"gbrain is best"不是靠单一 feature 证明；评测要证明 feature 对 gbrain 用户有价值，不做与其他算法的 research bake-off。

**设计哲学基调**（贯穿全项目的可观察规律）：
- **零 LLM 也要能跑**：大量关键路径是确定性纯函数/正则（link 类型推断、intent 分类、关系查询解析、矛盾分类的 cosine 快路径），LLM 只用于富化/综合。且"先安全，再便宜"——每个 LLM 调用点都讲究 fail-open / 可降级。
- **fail-open / 确定性 / 可复现**反复出现（关系检索 arm、graph signals、意图分类、trajectory 注入、评测管线）。
- **契约优先**（contract-first）：`src/core/operations.ts` 是 ~90 个共享 operation 的唯一来源，CLI 与 MCP server 都由它生成；HTTP dispatch 在 handler 执行前强制 scope/localOnly。来源 `CLAUDE.md:41-44,87-89`。
- **"大脑即数据库、skill 即 markdown、路由即文本文件"**——一切可审计、可版本化、无隐藏状态。

---

## 3. 架构

### 3.1 双轴心智模型（关键）

两个正交轴，用户和 agent 都必须懂，否则查询静默错路由。来源 `CLAUDE.md:21-37`、`docs/architecture/brains-and-sources.md`、`skills/conventions/brain-routing.md`：

- **Brain = 哪个数据库**。个人 brain 是 `host`；可 mount 额外 brain（团队发布，各自 DB 与访问策略）。路由：`--brain` / `GBRAIN_BRAIN_ID` / `.gbrain-mount` dotfile / `gbrain mounts add`（v0.19+）。
- **Source = 数据库里的哪个仓库**。一个 brain 可装多个 source（wiki/gstack/openclaw/essays），slug 按 source 唯一（复合主键 `(source_id, slug)`）。路由：`--source` / `GBRAIN_SOURCE` / `.gbrain-source` dotfile。

Source 解析链 7 层（v0.41.13+，`src/core/source-resolver.ts`）：`--source` flag → `GBRAIN_SOURCE` env → `.gbrain-source` dotfile → local_path 最长前缀匹配 → brain 级 `sources.default` config → **tier 5.5 `sole_non_default`**（仅当单 source 非 default 时自动路由，v0.41.13 新增，修单 source brain 的静默错路由）→ 字面 `'default'`。来源 `skills/conventions/brain-routing.md:49-70`。

### 3.2 引擎层

- `BrainEngine` 接口在 `src/core/engine.ts`，是抽象契约；具体实现两个：**PGLiteEngine**（WASM 内嵌 Postgres，零配置默认）与 **PostgresEngine**（pgvector，Supabase）。`engine-factory.ts` 按配置动态 import。
- **Engine parity 铁律**（`CLAUDE.md:83-86`）：两个引擎必须锁步，新方法/SQL 形状必须同时落地两边，由 `test/e2e/engine-parity.test.ts` 钉住。因为 PGLite 会隐藏 postgres.js 的某些 bug（见 JSONB 坑），真正的 parity 由 DATABASE_URL-gated 的 e2e 兜底。
- **部署拓扑三种**（`docs/architecture/topologies.md`）：单 brain / 跨机 thin client / split-engine，由 `~/.gbrain/config.json` + `GBRAIN_HOME` 控制；PGLite 用于小 brain，Supabase 约 1000+ 文件推荐。
- **迁移**：schema DDL 全部在 `src/core/migrate.ts` 的 `MIGRATIONS` 数组；`CREATE INDEX CONCURRENTLY` 需 `transaction:false`。版本已到 v100+（如 v98 给 links 加 link_kind 列、v82 给 facts 加 event_type、v56 给 query_cache 加 knobs_hash）。

### 3.3 表面层

- **CLI + MCP 同源**：约 90 个 operation 定义在 `src/core/operations.ts`，每个带 `scope: 'read'|'write'|'admin'` + 可选 `localOnly`。MCP 工具从 operations 生成（`src/mcp/server.ts` + `dispatch.ts` + HTTP transport + rate-limit + tool-defs）。
- **信任边界（critical）**：`OperationContext.remote`——可信本地 CLI 调用者 `remote=false`（`src/cli.ts` 设置），不可信 agent 端 `remote=true`（`src/mcp/server.ts` 设置）。安全敏感操作（如 file_upload）在 remote=true 时收紧文件系统限制，未设置时默认严格。来源 `AGENTS.md` Trust boundary 节、`CLAUDE.md:46-50`。**fail-closed**：不是严格 false 一律视为 remote。
- **Source 隔离铁律**：所有读侧 op 走 `sourceScopeOpts(ctx)`，优先级 federated array（`ctx.auth.allowedSources`）> scalar（`ctx.sourceId`）> nothing；不得手写 source 过滤——漏一线就是跨 source 数据泄漏。
- **CLI 命令面**（`src/commands/` 约 130 个文件）覆盖面极广：init/doctor/dream/autopilot/think/eval 系列/lsd/brainstorm/schema/mounts/sources/auth/serve/serve-http/connect/whoknows/founder-scorecard/trajectory/extract/sync/embed/lint/orphans/backlinks/maintain/advisor/recall/graph-query/whoknows 等。其中 `eval-*` 命令 20+ 个。
- **进度上报**（`CLAUDE.md:338-368`）：所有 bulk 命令走共享 `src/core/progress.ts`，agent 1 秒内心跳；进度写 stderr，stdout 保持干净（`--json` 数据）；CI 有 guard 禁止往 stdout 写 `\r` 进度。

### 3.4 技能系统（Skills）

- 60+ 技能（`skills/`），RESOLVER.md 是调度器。**always-on**：signal-detector（每消息并行触发）+ brain-ops（任何 brain 读写）。
- 触发表（`skills/RESOLVER.md`）：query/enrich/repo-architecture/brain-taxonomist/eiirp/citation-fixer/data-research/publish/frontmatter-guard/capture/idea-ingest/media-ingest/meeting-ingestion/ingest/daily-task-manager/daily-task-prep/briefing/cron-scheduler/gbrain-advisor/reports/skill-creator/skillify/functional-area-resolver/skillpack-*/smoke-test/cross-modal-review/testing/webhook-transforms/minion-orchestrator/ask-user/setup/cold-start/migrate/maintain/gbrain-upgrade/soul-audit/schema-author/schema-unify/book-mirror/article-enrichment/strategic-reading/concept-synthesis/idea-lineage/perplexity-research/archive-crawler/academic-verify/brain-pdf/voice-note-ingest/GStack(office-hours/ceo-review/investigate/retro)。
- **身份与访问**：非 owner 消息先查 ACCESS_POLICY.md；agent 身份读 SOUL.md；用户上下文 USER.md；节奏 HEARTBEAT.md。
- **路由表压缩研究**（v0.32.3.0，`CLAUDE.md:305-328`）：`functional-area-resolver` 是两层分发模式（每个功能区一行，区内列子技能 `(dispatcher for: ...)`），把大 AGENTS/RESOLVER（≥12KB）压到 48% 体积且准确率 +13~17pp（实测 Opus 4.7 / Sonnet 4.6 / Haiku 4.5）；`(dispatcher for: ...)` 子是承重信号（去掉后 Sonnet 上 lenient 准确率崩到 41.7%）。对应 AnyTool/RAG-MCP/Anthropic Agent Skills 渐进披露路线。A/B 评测面在 `evals/functional-area-resolver/`，三模型 receipt 已提交。
- **brain-resident skillpack + advisor**（v0.42.47.0）：brain 仓库可自带可发布 skillpack（`brain_resident:true`）；`gbrain skillpack init-brain-pack` 脚手架；`gbrain advisor` op 从 brain 状态算高杠杆动作排序列表（`src/core/advisor/` 8 个 collector），MCP 暴露默认关闭。
- **Iron Law back-link**（`skills/conventions/quality.md:23-30`）：提到有 brain 页面的人/公司必须从实体页 back-link 到提及页，格式 `- **YYYY-MM-DD** | Referenced in [page](path) -- context`；未链接的提及 = broken brain。每条事实必须带 `[Source: ...]` 内联引用，且有一份 source 优先级（用户原话 > compiled truth > timeline > 外部）。

---

## 4. 记忆核心实现（数据模型与写入管线）

### 4.1 核心表/对象

- **pages**（含 compiled_truth、synopsis、type、source_id、frontmatter provenance/status 等）；**chunks**（embedding 列）；**links**（typed edges，v98 加 link_kind）；**facts**（v0.31 hot memory，v82 加 event_type，含 claim_metric/claim_value/unit/period）；**takes**（kind=fact/take/bet/hunch）；**timeline**；**sources**（source 注册表，`'default'` 种子）；**query_cache**（v56 加 knobs_hash）；**op_checkpoint_paths**（sync 可恢复）；**gbrain_cycle_locks**（cycle 锁）。
- **compiled_truth**：brain 对实体的综合理解（synthesis 产物），检索时会命中它的 2.0x boost。

### 4.2 写入管线：auto-link（零 LLM）

`src/core/link-extraction.ts`：每次 `put_page` 跑 `extractEntityRefs`，四 pass 抽取实体：
1. `[Name](path)` markdown 链接；
2. `[[source-id:path|Display]]` qualified wikilink；
3. unqualified Obsidian wikilink；
4. generic `[[...]]` wikilink（Issue #972，needsResolution 标记交 SlugResolver）。

先 `stripCodeBlocks` 剥代码块、masked-ranges 防双发。链接批量写入用单个 SQL `INSERT ... SELECT FROM jsonb_to_recordset(...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1`（自由文本安全；旧的 `unnest(text[])` 形式在日历/Zoom 上下文崩溃，gbrain#1861）。17K 页 brain 上全图抽取秒级完成。来源 `docs/architecture/RETRIEVAL.md:35-45`。

**inferLinkType()（零 LLM 正则规则，link-extraction.ts:788）**：
- page-type 绑定：media→'mentions'、image→'image_of'、meeting→'attended'；
- 动词正则：FOUNDED_RE→'founded'、INVESTED_RE→'invested_in'、ADVISES_RE→'advises'、WORKS_AT_RE→'works_at'；还有中文模式 ZH_FOUNDED_RE 等；
- person→company 时 page-role prior（investor > advisor > employee 优先级）。

### 4.3 NER 类型链接（v0.41.18，`src/core/extract-ner.ts`）

复用 by-mention gazetteer + schema-pack 的 `link_types[].inference.regex` 给提及赋类型化动词（"CEO of Acme"→works_at 链接到 Acme）。**设计锁定**：不拆 `link_source='ner'` 新 provenance（会破坏所有 link_source='mentions' 查询），而是保持 mentions 且新行置 `link_kind='typed_ner'`（v98 加列）；legacy plain mentions 保持 link_kind=NULL。因为 UNIQUE 约束排除 link_kind，相同 (from,to,type,source,origin) 的 plain mention 行 + typed_ner 行会冲突 → DO NOTHING，NER 不覆盖 plain mentions。上下文窗口 ±80 字符，BATCH 500。无 pack 或 pack 无 regex → `pack_unavailable:true` 降级（hint 而非报错）。来源 `src/core/extract-ner.ts:1-116`。

### 4.4 Hot Memory / facts 子系统（v0.31，`src/core/facts/`）

- **extract.ts**：turn-extractor，管道 = ①`INJECTION_PATTERNS` 消毒（与 takes/think 同一 sanitizer，单一事实来源）②dream_generated 页面反循环跳过 ③Haiku 严格 JSON 抽取 ④4-strategy 容错解析 ⑤出向再消毒 ⑥同步算 embedding。AbortError 必须向调用方重抛（SIGTERM 时不应写 NULL embedding 行）。默认模型 Sonnet（notability 判断需要强模型，非 Haiku）；kill-switch `facts.extraction_enabled`；`#2113` 把 output-token cap 从硬编码 1500 提到默认 4000（思考型模型 thinking tokens 吃掉 cap 导致 JSON 永远解析不了）。
- **classify.ts**：矛盾分类器 = ①无候选→INSERT ②**cheap fast-path（D13）**：top 候选 cosine ≥ 0.95 → DUPLICATE，完全跳过 LLM（最便宜的准确去重）③LLM 分类器：duplicate|supersede|independent ④**失败降级（D12）**：LLM 出错时 cosine ≥ 0.92 → DUPLICATE 否则 INSERT。LLM 用 Haiku（热路径便宜）。
- **backstop.ts**：统一 facts 管道（extract→resolve→dedup@0.95→insert），**替换五个分叉实现**（put_page hook、extract_facts MCP op、sync 后置块、file_upload、code_import）为单一 choke point。两种执行模式：`'queue'`（fire-and-forget，默认，caller await≈0）与 `'inline'`（await 全管道，返回真实计数，供 extract_facts MCP op）。notability 过滤：sync 传 'high-only'（HIGH 立即落，MEDIUM 等 dream cycle，LOW 在 LLM 层丢弃），其他 surface 默认 'all'。失败走 ingest_log。
- 另有 decay.ts、forget.ts、eligibility.ts、fence-write.ts、extract-from-fence.ts、queue.ts、absorb-log.ts、phantom-audit.ts、stub-guard-audit.ts。

### 4.5 升华：consolidate.ts（facts→takes，dream cycle 阶段）

规则：<3 条事实或最老事实 <24h 则跳过；embedding cosine 贪心聚类阈值 **0.85**；取 cluster 内最高置信度 fact 文本为 take claim（v0.31 **无 LLM，保持确定性**；TODO 注明 v0.32 用 Sonnet 重写）；INSERT takes(kind='fact', holder='self')，contributing facts 标记 consolidated_at/consolidated_into，**永不 DELETE**。来源 `src/core/cycle/phases/consolidate.ts`。

### 4.6 dream cycle（`src/core/cycle.ts`）

`runCycle()` 统一入口（`gbrain dream` / `gbrain autopilot` daemon / minions autopilot-cycle）。**9 个 phase**：lint --fix → backlinks --fix → sync → synthesize（v0.23 transcripts→pages）→ extract → patterns（v0.23 跨 session 主题）→ recompute_emotional_weight（v0.29）→ embed --stale → orphans。Postgres 用 `gbrain_cycle_locks` 行 + 30min TTL（经 PgBouncer transaction pooling，pg_try_advisory_lock 不可用），PGLite 用文件锁。

### 4.7 轨迹（v0.35.4，`src/core/trajectory.ts`）

`find_trajectory` 的衍生指标纯函数：
- **Regression 检测**：每连续 (metric,value) 对，新值比旧值低 ≥10% 即触发（阈值可配 `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD` 默认 0.10）；只用 claim_value≠null 的点；按 metric 分组独立检测（mrr/arr/team_size 交错不误报）；分母用 `abs(older)`（负值指标不颠倒改进/回退）。
- **Drift score**：`1 - mean(cosine(emb[i], emb[i-1]))` 夹在 [0,1]；<3 个有 embedding 的点返回 null。
- `gbrain think` 对 temporal/knowledge_update intent 自动注入 trajectory block（v0.40.2.0 默认 ON，`think.trajectory_enabled=false` 可关）；facts.event_type（meeting/job_change/location_change）走同一管道。MCP op `find_trajectory` 对 remote 调用做可见性过滤。

### 4.8 think 管线（`src/core/think/`，v0.28.0）

INTENT → GATHER → SYNTHESIZE →（可选 COMMIT）。Anthropic 调用依赖注入（MessagesClient 适配 gateway.chat()，MCP stdio 启动不继承 shell env 也能读到 config 里的 key）。--anchor/--save/--take 仅本地 CLI（MCP remote 返回 not_implemented）。rounds>1 尚无 gap-fill 逻辑。
- **intent.ts**：零 LLM 正则分类器，三桶 temporal/knowledge_update/other，刻意偏 'other'（false positive 浪费 token > false negative）；`src/eval/longmemeval/intent.ts` 复用同一正则集（单一来源，不可漂移）。
- **gather.ts**：四个 retriever 并行——hybrid（页面级）、takes_kw、takes_vec（无 embedder 时跳过）、graph（anchor 子图遍历，需 --anchor）；RRF k=60 融合；gatherLimit 默认 40 / takesLimit 30 / graphDepth 默认 2。

---

## 5. 检索算法（hybrid + graph，核心中的核心）

### 5.1 四层策略与"为什么单打独斗都失败"（`docs/architecture/RETRIEVAL.md`）

1. **Vector（pgvector HNSW）**——语义相似。"谁在做 YC 的检索质量？"即使没打 "YC" 也能命中"Garry Tan + retrieval"页。单独失败：任何没直接编码进 embedding 的事实关系都丢（"Garry 投资组合里的公司"返回关于 portfolio 的文章而不是公司页）。
2. **BM25 keyword（tsvector）**——字面匹配，名字/精确短语/代码标识符。单独失败：对措辞脆弱（"谁做 retrieval"漏掉说 "search ranking" 的页），同义词/近似表达全是垃圾。
3. **RRF**——融合 vector+keyword 排名，不全局加权，各投一票。
4. **知识图谱 typed-edge 遍历**——"Bob 这季度投了什么"走 `bob ──invested_in──> company ──dated──> Q1`；vector 看不见因果链。单独失败：只擅长"Alice 的邻居"，对未建链的新页是瞎子（backlinks 积累前稀疏）。

**Benchmark（BrainBench，corpus+harness 在同级 garrytan/gbrain-evals 仓库，240 页 Opus 生成的 rich-prose corpus，P@5/R@5/MRR/nDCG@5）：**

| Strategy | P@5 | R@5 | Notes |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | lexical-only baseline |
| vector-only RAG | ~18 | ~80 | 标准 RAG |
| gbrain graph-disabled（hybrid+RRF，无图遍历） | ~18 | ~85 | 仅混合 |
| **gbrain default（全栈）** | **49.1** | **97.9** | graph + extract-quality lift |

**结论：+31 P@5 来自图与抽取质量；"图不是边缘功能，是承重墙"**（"the load-bearing wall"）。来源 `docs/architecture/RETRIEVAL.md:22-33`、`README.md:12`。

### 5.2 hybrid 管线（`src/core/search/hybrid.ts`，从生产 Ruby 实现 content_chunk.rb 移植）

pipeline = keyword+vector → **RRF（score=sum(1/(60+rank))）** → normalize → boost → **cosine re-score（0.7*rrf + 0.3*cosine）** → dedup；compiled_truth boost **2.0x**；`hybridSearch()` 入口 resolve search mode。来源 `src/core/search/hybrid.ts`（开头/中段/925 行附近）。

### 5.3 Graph signals（v0.40.4.0，`src/core/search/graph-signals.ts`）

三个 additive 信号，作用于 runPostFusionStages 第 4 阶段：
1. **Adjacency-within-top-K ~1.05×**：≥2 个 top-K 页链入 = hub；
2. **Cross-source adjacency ~1.10×**：≥2 个不同 source 链入 = federated-team hub（单 source brain 自动 dormant）；
3. **Session diversification ~0.95×**：同 session 前缀的多个 top-K 页只保留最高分、其余 demote（MMR-lite）。注释明确说明"boost cluster"原构思被 Codex 外部评审纠正为 demote。

受 v0.35.6.0 `computeFloorThreshold` floor-gate 保护；**fail-open**。

### 5.4 Relational recall arm（v0.43，`src/core/search/relational-recall.ts` + `relational-intent.ts`）

把"关系型查询"（"谁投资了 widget-co"、"Acme 谁在做 payments"、"谁介绍我给 alice"、"fund-a 和 fund-b 之间有什么联系"）当作**第四 RRF arm**注入：`parseRelationalQuery → 解析 seed 实体（scope-aware, confidence-gated）→ engine.relationalFanout（within-source, deterministic）→ batch-hydrate 为 SearchResult`。
- **确定性**：解析原始查询（绝不用 LLM 扩写变体）；遍历+解析全部确定性；fail-open（任何错误返回空 arm + audit 行，不破坏热路径）。
- **Precision-first（D4）**：模式要求关系短语与实体相邻（"who invested TIME in learning Rust"不触发）。
- **Vocabulary（D2）**：默认词库覆盖常见原型；schema pack 可用 `extraVerbs` 扩展；每个 link_type 必须 ⊆ KNOWN_LINK_TYPES（13 种：founded/invested_in/advises/works_at/attended/yc_partner/led_round/mentions/image_of/discussed_in/source/related_to/wikilink_basename），保证查询侧不会遍历 ingest 从不产生的边。
- **种子 STOPWORD 拒绝**（it/that/this/people/who/what…）。
- **Confidence gate（D3 tier-1）**：`fallback_slugify` 才解析出的 seed 直接丢弃，arm 绝不从发明出来的 slug 出发遍历。tier-2 解析余量门是 filed TODO。
- **ReDoS 防御**：seed 捕获长度受限（`.{1,80}?`）且所有模式锚定，无灾难性回溯面。
- **Federation（E2=A）**：在作用域内每个 source 解析 seed 并从各自 fan out；v1 遍历保持 source 内（无跨边界边）。
- **relationalRetrieval knob**：balanced/tokenmax 默认 ON，conservative OFF；v0.42.34.0 knobs_hash v9→v10 把该 knob+depth 折进 cache key（防污染）。

### 5.5 命名实体检索四层（RETRIEVAL_MAXPOOL_INCIDENT 后新增，`RETRIEVAL.md:63-102`）

- **Per-page max-pool**：searchVector 两个引擎都用 `DISTINCT ON (slug)` 在用户 LIMIT 前把 chunk 级候选折叠成每页最佳 chunk（`buildBestPerPagePoolCte` in sql-ranking.ts）——返回 N 个不同页面，而非会折叠成更少页面的 N 个 chunk。
- **Title-phrase boost**：查询是 title 内连续 token 串（或全标题精确匹配）时，floor-ratio-gated 有界乘子（`applyTitleBoost`, `search.title_boost` knob）。
- **Alias hop**：frontmatter `aliases:` 投影进 `page_aliases` 表（独立于 wikilink 重定向的 slug_aliases），查询时全匹配注入/提升 canonical 页——唯一能桥接零表面重合真同义词的层（"Hall of Light"→Mingtang 页）。backfill 用 `gbrain reindex --aliases`。
- **Evidence contract**：每个结果带 `evidence`（alias_hit|exact_title_match|high_vector_match|keyword_exact|weak_semantic）+ `create_safety`（exists|probable|unknown）。agent 判断"是否已存在、别写重复页"时看 create_safety 而非混合分。
- **Extraction quarantine lane**（Issue #160）：带 `provenance: auto-extracted` + `status: unverified` 的页按普通内容排名——跳过 compiled-truth 融合 boost、跳过 people/companies 命名空间 source-boost，且每个搜索结果标 `unverified:true` 供 agent 标注来源。`gbrain extraction-pending` / `extraction-review` 处理。

### 5.6 Source-aware ranking（`src/core/search/sql-ranking.ts`）

SQL 层 source-factor CASE 表达式：curated（originals/concepts/writing）压过 bulk（your-openclaw/chat、daily、media/x）；hard-exclude 前缀（test/attachments/.raw）在检索时过滤而非 post-rank。**`archive/` 特意不 hard-exclude**（Issue #1777）——高信号历史内容，降权 0.5x 而非隐藏；且 cross-encoder reranker 仍可把幸存者提升进 rerank 窗口。boost map 可用 `GBRAIN_SOURCE_BOOST` env 或 `SearchOpts.exclude_slug_prefixes` 覆盖；时间型查询（detail:'high'）绕过 boost 让 chat 页重新浮出。数值因子来自 parseSourceBoostEnv。

### 5.7 Reranker（v0.36.0.0）：ZeroEntropy zerank-2

默认开在 balanced mode bundle；真实语料 20 查询上，**zerank-2 把 60% 的 top-1 结果重排**。理由：hybrid ranking 每策略局部最优但全局次优；cross-encoder 把 query+候选联合读一遍、full attention，抓住"vector+keyword+graph 全同意但主题错误"的文档。成本：+150ms p50、~$0.025/M tokens；`gbrain config set search.reranker.enabled false` 关闭。来源 `docs/architecture/RETRIEVAL.md:47-53`。

### 5.8 Intent-aware 查询改写 + Multi-query expansion（`src/core/search/intent.ts`、`expansion.ts`）

- intent 分类（确定性，无 LLM）：entity（更高 graph 遍历权重）/temporal（绕过 source-boost 让 chat/daily 浮出）/event（启用 timeline 索引）/general（标准栈）；分错优雅降级。
- expansion（`detail:'high'` 或 tokenmax）：Haiku 生成 2-3 个查询变体，各跑全栈，RRF 合并。opt-in（tokenmax 默认开，balanced/conservative 关）；约 +$0.001/查询 +200ms。**LongMemEval 上是干净零结果（97.60% 有无一样）**——text-embedding-3-large 已弥合大部分 user-voice/answer-voice 差距。来源 `CHANGELOG.md:16151-16154`、`RETRIEVAL.md:115-119`。

### 5.9 查询缓存与防污染

query_cache 带 `knobs_hash`（SHA-256 of knobs）：v56 引入；v2→v3（v0.36.3.0）折入 embedding 列名+provider（防 voyage 1024d 命中 openai 1536d 的行）；v9→v10（v0.42.34.0）折入 relationalRetrieval knob+depth。升级时一次性 miss spike（旧行不可达）。

### 5.10 完整 query op 管线（`RETRIEVAL.md:121-153`）

```
intent classify → expansion(可选) → hybrid:
   ├─ vector (HNSW)
   ├─ keyword (BM25 via tsvector)
   ├─ relational (v0.42.34.0: typed-edge recall arm，仅关系查询)
   ├─ source-aware re-rank (CASE in SQL)
   └─ RRF fusion → top 30
→ graph augment (typed-edge 遍历)
→ reranker (zerank-2, top 30 → 重排)
→ token-budget enforcement (per mode bundle)
→ dedup (同 slug 不同 chunk → 保留最佳)
→ results
```
每阶段可独立测试、可替换；orchestration 成本 <1ms，延迟预算全在 HTTP 调用（embedding/rerank）与索引扫描。

---

## 6. 团队 / 多用户能力

### 6.1 三种部署拓扑与 company-brain（`docs/tutorials/company-brain.md`）

个人 brain → 公司 brain 是**同一架构加三样东西**：
1. **同 brain 内多 source**（会议笔记一个 source、每成员客户笔记一个、共享 wiki 一个）；
2. **每用户 OAuth 登录 + scopes**：凭据决定能读写哪些 source；brain 在 SQL 层拒绝跨 source 读（database-enforced 隔离）；
3. **每用户子文件夹、cron、skill**。

**规模假设**：10-50 人公司；25 人 <$100/月。**fuzz 测试"所有读路径零泄漏"**（search/list/lookup/multi-source reads）。

**两种 scoping 模型**：
- **Model A（推荐多用户多 AI client）**：每成员独立 OAuth client，带 `--source` + `--federated-read` flags；隔离 DB 强制。
- **Model B（一 agent 服务众人，作者生产实际形态）**：单 source `default` + `partners/<slug>/` 目录约定；每个 per-person client 用 `--bound-slug-prefixes partners/alice-example/` 注册（v0.42.72.0+），越界写被拒绝 `permission_denied`；无绑定则仅约定（agent 自我约束）。**读隔离在两种模型下都是 source 粒度**（共享 source 内授权者可读所有文件夹）。

### 6.2 OAuth 2.1 Provider（`src/core/oauth-provider.ts`，1252 行）

实现 MCP SDK 的 OAuthServerProvider，**直接跑 SQL（PGLite 或 Postgres），不经 BrainEngine 接口**——OAuth 是基础设施不是 brain 操作。
- 支持：client 注册（CLI 手动 / Dynamic Client Registration）、authorization code + PKCE（ChatGPT、浏览器端 client）、client credentials（M2M：Perplexity、Claude）、token refresh + rotation、revocation、legacy access_tokens 兼容。
- **agent 级绑定（AgentClientBindings）**：boundTools / boundSourceId / boundBrainId / boundSlugPrefixes / boundMaxConcurrent / budgetUsdPerDay。
- **`assertValidSlugPrefixes`** 严格校验：非空、无首尾空白、必须小写、必须以 `/` 或 `/*` 结尾（防止"emp-alice"被读成覆盖 emp-alice-2 的字符前缀）。
- `pgArray` 手写 Postgres 数组字面量并转义（PGLite 拒绝 JS 数组绑 TEXT[]；且防 `,` 走私元素，CSO finding #5）。
- token_endpoint_auth_method 白名单三值（client_secret_post/basic/none）；**read-tolerant**：getClient 原样返回存的行，白名单只 gate 新写入。
- scope 校验在 `src/core/scope.ts`（hasScope/assertAllowedScopes/parseScopeString/InvalidScopeError）+ legacy-token-scope.ts。

### 6.3 双 brain / federated

- **Mounts**：`gbrain mounts add` 可挂载额外 brain（团队发布、各自 DB 与访问策略）。来源 `CLAUDE.md:26-31`。
- **Federation 是 latent-space only**：跨 brain 由 agent 决定（`skills/conventions/brain-routing.md`）。同 brain 内跨 source：graph-signals 有 cross-source adjacency 信号；relational arm 在作用域内每个 source 解析 seed 并从各自 fan out（v1 遍历不跨 source 边界）。
- **thin-client**：远程 MCP seam 见 `docs/architecture/thin-client.md`；MCP remote 默认 `remote=true` 不可信。

### 6.4 公司场景的读取隔离实现要点

- `sourceScopeOpts(ctx)` 贯穿所有读侧 op；federated allowedSources 数组优先。
- `find_trajectory` MCP op 对 remote 调用 visibility-filtered。
- think/runThink 把 source scope 线程化进 gather 全流（hybrid retrieval、takes 检索、graph walk）与 trajectory 解析，由 `test/e2e/think-source-isolation-pglite.test.ts` 钉住。

---

## 7. 数据支撑（benchmark 数字 + 出处）

> 注意：项目内文档使用 2026 年日期；数字按各自出处引用，不混用。

### 7.1 LongMemEval（v0.28.12，2026-05-07，`CHANGELOG.md:16107-16186`）

**R@5 = 97.60%**，超越 MemPalace raw（96.6%）1 个点。完整报告在 `https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-07-longmemeval-s.md`。

| Adapter | R@5 | Cost/1000 问 | LLM in retrieval? |
|---|---|---|---|
| **gbrain-hybrid** | **97.60%** | ~$1 | no |
| gbrain-hybrid + Haiku query expansion | 97.60% | ~$3 | yes (Haiku) |
| gbrain-vector（OpenAI embeddings only） | 97.40% | ~$1 | no |
| MemPalace raw（ChromaDB） | 96.6% | n/a（对方发布） | no |
| gbrain-keyword（BM25 baseline） | 19.80% | $0 | no |

分类别（gbrain-hybrid vs MemPalace raw）：single-session-assistant **100% vs 92.9%（+7.1）**；multi-session 100% vs 98.5%（+1.5）；knowledge-update 100% vs 99.0%（+1.0）；single-session-user 95.7% 平；single-session-preference 93.3% 平；temporal-reasoning 94.7% vs 96.2%（-1.5）。

数据集：n=500、六类问题、每问 ~50 distractor sessions、ground-truth 标签。两个诚实发布：
1. **Vector-only 在 K=5 上几乎等价（97.4 vs 97.6）**——只需 top-5 会话检索可只上纯 vector；hybrid 的增值在更小 K 和 keyword 重叠真正有用的文本（code/named entities/structured data）。
2. **Query expansion 是干净零结果**。

**方法论披露**：LongMemEval harness 在检索前对每个 haystack session 跑 Haiku 预处理（populate typed-claim substrate 供 trajectory 路由），因此发布的是 "gbrain + Haiku-preprocess" 而非 "gbrain alone"，与已发布 baseline 不可直接比（每个 question envelope 打 `methodology_note: "extractor=haiku-preprocess-full-haystack-v1"`）。来源 `CHANGELOG.md:9043`。

### 7.2 BrainBench（`docs/architecture/RETRIEVAL.md:22-33`）

P@5 49.1% / R@5 97.9% / +31.4 lift（README hero 文案 `README.md:12`，有 `test/readme-hero-anchors.test.ts` 5 用例做回归保护）。corpus 240 页 Opus 生成 rich-prose。基于 gbrain-evals 同级仓库。

### 7.3 Cross-modal takes 质量（`CHANGELOG.md:14849-14859`，未精读，grep 命中摘要）

100,720 takes 5 维 rubric 交叉模态 eval（GPT-5.5/Opus 4.6 评审）；attribution 6.5/10 是主要失败模式。

### 7.4 其他可引数字

- zerank-2 重排 60% top-1（`RETRIEVAL.md:49`）。
- 17K 页 brain 全图抽取秒级（`RETRIEVAL.md:43`）。
- functional-area-resolver：25KB→13KB、+13~17pp、48% 体积（`CLAUDE.md:305-328`）。
- lsd/brainstorm 成本事故：估计 $0.96 实际 $50.71（53×），见 8.4。
- README hero 生产规模 146,646 pages / 24,585 people / 5,339 companies / 66 cron（`README.md:5`）。

---

## 8. 优点 / 缺点与局限

### 8.1 优点

1. **工程纪律极强**：契约优先（operations.ts 单源生成 CLI+MCP）、双引擎 parity 测试、JSONB 双拼写防坑脚本（`scripts/check-jsonb-pattern.sh` + `check-jsonb-params.mjs`）、版本五处同步 + CI gate、CLAUDE.md 大小上限 + reference docs 只写当前状态 + CI 强制。这在国内少见，属于教科书级 agent-OS 工程。
2. **零 LLM 可跑 + fail-open 全面**：link 推断/intent/关系解析/矛盾快路径全是确定性纯函数；任何 LLM 依赖点都有降级路径。成本与延迟被当作一等公民设计（search mode 成本矩阵、pace mode、max-usd cap、10 秒成本预览）。
3. **评测文化深入**：BrainBench/LongMemEval/Replay captures；haters-immune 方法论（不用私有数据、public split pin commit、paired-bootstrap + Bonferroni、pre-registered expectations、threats to validity 明确列出未测量项）；每 PR 检索改动有 12 条手挑查询的 hermetic 回归（top-1 ≥80%、recall@10 ≥85%）。
4. **诚实披露**：LongMemEval 的 Haiku-preprocess 披露、query expansion 零结果的发布、temporal-reasoning -1.5 的承认与后续 filed TODO。
5. **自主维护闭环**：dream cycle 9 阶段 + doctor --remediate（依赖排序、逐步骤复检 score、cost cap）+ maintain skill + autopilot daemon。"醒来比睡去更聪明"不是口号。
6. **信任边界清晰**：remote 标志贯穿、fail-closed、source 隔离单一路径、OAuth slug-prefix 绑定校验——多用户隔离是设计目标不是补丁。
7. **文档与 agent 协作一体化**：AGENTS.md/CLAUDE.md/RESOLVER.md/KEY_FILES.md 分层，docs 防膨胀 CI 守卫；skills 是 markdown（可版本化、可评审、可发布 skillpack）。

### 8.2 缺点 / 局限（从代码与文档实际观察）

1. **单机偏好**：PGLite 默认，Postgres 仅在 1000+ 文件才建议；thin-client 二进制安装长期 deferred（`CLAUDE.md:303`）。
2. **关系/图能力有明确 v1 边界**：relational recall 跨 source 遍历是 v1 限制（`__all__` 枚举是 filed TODO）；tier-2 解析余量门未实现；`intro`/`connects` 是 type-agnostic（gbrain 没有 `introduced`/`knows` 边）。来源 `relational-recall.ts:18-22`、`relational-intent.ts:24-25`。
3. **consolidate 确定性但粗糙**：v0.31 无 LLM 聚类取最高置信度文本，TODO 注明 v0.32 用 Sonnet 重写；take claim 质量上限受限。
4. **think rounds>1 无 gap-fill 逻辑**（`think/index.ts`）。
5. **LongMemEval 偏斜**：方法论文档自己承认语料偏英语 + 技术向（software-engineering / consumer-product），非技术/非英文内容的 brain 表现未测（`SEARCH_MODE_METHODOLOGY.md:62`）。
6. **temporal-reasoning 是已知弱项**（94.7% vs MemPalace 96.2%，-1.5）；timeline-aware ranking 已 filed 但未落地。
7. **attribution 6.5/10** 是 100K takes 交叉模态 eval 的主要失败模式（`CHANGELOG.md:14849-14859`）。
8. **内部工具假设 macOS**：README 的安装引导（launchd、darwin-arm64 编译）、文档示例以 macOS 为主；Windows 支持未见明确路径。

### 8.3 项目自称的"Not"（README + company-brain 教程）

- 不是单一大点子，是打包；不是 research bake-off（North Star 明确禁止"证明 gbrain 算法打败某算法"的 off-mission 评测）；company-brain 不是不同安装、不是 thin-client-everywhere。

### 8.4 事故案例（`docs/incidents/2026-05-20-lsd-cost-explosion.md`，教训清单）

`gbrain lsd` 成本爆炸：估计 $0.96 → 实际 $50.71（53×），13,690 页 brain、v0.37.1.0。
- RC1：`listPrefixSampledPages` 每 prefix 返回 1 页，2,000 个 prefix → far set 1,985 页而非配置的 12 → 3,970 crosses × 4 ideas = 15,868 ideas。
- RC2：**无成本熔断器**（无超阈值 abort、无运行中 spend 偏离 abort、无 far set 大小上限）；`--yes` 跳过 10 秒成本预览。
- RC3：judge 全量 ideas 单 prompt → 超上下文（Sonnet 1M cap），且 JSON 解析脆弱。
- RC4：页面含**未配对 UTF-16 代理对**，序列化进 JSON body 产生非法 JSON。
- RC5：单 cross 无超时。
- 修复后重试仍失败（96 ideas 也 judge 失败）→ 0 条 idea 落地。**教训**：成本估计公式对、far-set 选择发散；估算与执行的"语义鸿沟"是事故根源——一个值得写进任何记忆系统设计文档的案例。

### 8.5 其他已知坑（CLAUDE.md 明确列出的跨切面陷阱）

- JSONB 双拼写（template `:jsonb` 与 positional `$N::jsonb`）在 postgres.js 下 double-encode、PGLite 隐藏 bug——#2339 曾 abort 掉每次 sync。
- engine-live 路径避免运行时动态 import（有 script 强制）。
- PgBouncer transaction pooling 下 pg_try_advisory_lock 不可用 → 用行锁 + TTL。
- sync 锁偷取有 grace 窗口 + stall watchdog（GBRAIN_SYNC_STALL_ABORT_SECONDS 默认 900，防无声 hang）。
- PGLite 拒绝 JS 数组绑 TEXT[] → pgArray 手写字面量（含转义）。

---

## 9. 可借鉴点（站在"团队项目记忆系统"角度）

1. **检索 = 多路召回 + RRF，而不是单一向量**。BM25 + vector + RRF 是基础，其上再加：source 加权、标题/别名桥、关系 arm。对团队 wiki/代码/会话混合语料，BM25 的 lexical 兜底比纯向量稳得多（gbrain 自己发布 keyword-only 19.8% vs vector 97.4%，但混合的价值在更小 K 和混合语料）。
2. **"零 LLM 边"是性价比之王**：typed edges + 零 LLM 正则抽取 + graph traversal，让关系查询（"谁在 X 工作"）不需要重训 embedding。团队系统可以直接抄这个模式：写文档时自动抽 `[链接]+动词` 建知识图。
3. **记忆闭环 = 写入钩子 + 夜间维护**：auto-link on every write（图免费增长）+ dream cycle（synthesize/extract/patterns/embed/consolidate）+ 确定性规则（<3 条或 <24h 跳过、cosine 阈值聚类）。比"定期整库重处理"便宜得多、可审计得多。
4. **成本是第一等公民**：search mode（conservative/balanced/tokenmax）把"检索质量 vs 下游 token 成本"做成可配置档位；任何 LLM 调用有 cost cap / preview / kill-switch。多用户系统最该抄这条。
5. **可复现评测门槛**：不用私有数据、public split pin commit、harness 不碰用户 brain（in-memory + TRUNCATE）、per-run record + receipt 绑定（model/prompt_hash/fixtures_hash/harness_sha/ts）。团队做检索改动时，这个"别人能复核你的数字"的规矩直接提升可信度。
6. **契约优先 + 双引擎 parity**：一个 operation 定义生成 CLI + MCP + HTTP dispatch + scope 强制；引擎差异用 e2e parity 测试兜底而不是"文档承诺"。对要服务多 client（Slack/CLI/web）的团队系统是直接模板。
7. **信任边界显式化**：`remote` 标志 + fail-closed + source 级 SQL 隔离 + per-person slug 前缀绑定。多成员共享记忆库的权限模型可以参考（不是"权限靠 UI 隐藏"而是 DB 层强制）。
8. **诚实 vs 营销的分界线**：hero 数字（97.60% / P@5 49.1）都带方法论 caveat（Haiku-preprocess、语料偏斜、vector-only 等价）；README 与 CHANGELOG 的差距是刻意保持的（"gbrain is best"是全系统 claim）。团队对外宣称 benchmark 时也应如此。
9. **文档即运行时**：AGENTS.md/CLAUDE.md/RESOLVER.md 作为 agent 的操作协议而不是摆设；skills 是 markdown（团队可评审、可版本化、可发布）；路由表压缩（dispatcher 一行一功能 + 子技能列表）是 LLM context 工程的可复用实践。
10. **事故复盘文化**：成本爆炸 incident 文档化根因 + 修复 + 后续防回归（成本熔断器已作为 filed TODO/规则化）；incident 落在仓库里可检索。团队系统应同样把"估算与执行语义鸿沟"这类事故写成模板。

---

## 10. 未解决 / 待深入（诚实清单）

- `src/core/engine.ts` 未读全（~大文件），BrainEngine 全方法面未完整枚举。
- `docs/architecture/KEY_FILES.md`（per-file index，大文件）未读，各文件语义以 CLAUDE.md/源码为准。
- evals/ 目录的 embedding-provider-eval.json、baseline.md、harness-runner 细节未精读。
- cross-modal takes eval 的 5 维 rubric 全文与 100,720 数字上下文未精读（仅 grep 摘要）。
- `gbrain search tune` 的具体推荐算法、`founder scorecard` 四信号细节未读源码。
- migrate 的 MIGRATIONS 数组版本号上限未确认（仅知 v98/v82/v56）。
- 双引擎差异的具体 SQL 分叉（sqlFor.pglite vs postgres）未逐行对比。
- CHANGELOG.md 22920 行仅精读了少数关键条目，其余以 grep 摘要为准。
- AGENTS.md 的 9-step install flow（INSTALL_FOR_AGENTS.md）未读全文。
- 中文支持面（ZH_FOUNDED_RE 等）只确认存在，未读具体模式。
