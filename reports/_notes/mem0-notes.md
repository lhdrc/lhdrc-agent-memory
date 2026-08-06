# Mem0 深度调研笔记

> 调研对象：`D:\memory_projects\mem0`（mem0ai/mem0，"The Memory Layer for Personalized AI"）
> 调研性质：纯研究任务，不修改任何代码。以下内容均基于对仓库源码与文档的实读，引用具体文件路径。
> 调研日期：2026-08-02（git HEAD `50bdaaea`，main 分支，Python SDK 版本 2.0.15）

---

## 1. 项目概述

### 1.1 定位

- **一句话定位**（`README.md` 第 73 行）："Mem0 ('mem-zero') enhances AI assistants and agents with an intelligent memory layer, enabling personalized AI interactions."——给 AI Agent/助手用的**长期记忆层**：记住用户偏好、跨会话自适应、持续学习。
- 官方文档站：docs.mem0.ai；商业站点 mem0.ai；**Y Combinator S24** 公司（README 徽章）；Apache 2.0。
- 论文可引用：`Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory`（arXiv:2504.19413，2025）。

### 1.2 形态：一条产品线三种交付方式

| 方式 | 形态 | 适用 | 备注 |
|---|---|---|---|
| **Library（OS S SDK）** | `pip install mem0ai` / `npm install mem0ai` | 测试/原型 | 最轻，自备 LLM + 向量库 |
| **Self-Hosted Server** | Docker（FastAPI + pgvector + dashboard） | 团队自有基础设施 | 含认证、API Key、审计日志、dashboard |
| **Cloud Platform** | 托管 `api.mem0.ai`（`MemoryClient`） | 零运维生产 | 含 Temporal Reasoning、Memory Decay 等专有优化 |

- 关键叙事：README 用一张表对比三种方式，并强调 **Platform 的 benchmark 数字包含专有优化，OSS 用户只能获得"方向相似的提升"而非完全相同的数字**（README 第 54 行）——这是一个重要的诚实口径。

### 1.3 技术栈（polyglot monorepo，见 `AGENTS.md`）

- **Python SDK**（`mem0/`，PyPI `mem0ai`）：核心。内存记忆、LLM、嵌入、向量库、reranker 全走 provider 模式。
- **TypeScript SDK**（`mem0-ts/`，npm `mem0ai`）：与 Python 平行的实现（client + OSS）。
- **CLI**：`cli/python`（Typer，PyPI `mem0-cli`）、`cli/node`（Commander，npm `@mem0/cli`）。
- **Server**：`server/` FastAPI + PostgreSQL/pgvector + SQLAlchemy + alembic + Next.js dashboard。
- **集成**：`integrations/`（Claude Code / Cursor / Codex / OpenCode MCP 插件、Vercel AI SDK、n8n、Zapier、OpenClaw、Pi Agent 插件）。
- **Skills**：`skills/` 为 Claude Code/Codex 等提供"SDK 知识技能"（mem0 / mem0-cli / mem0-vercel-ai-sdk）与"流水线技能"（mem0-integrate 等）。
- **MCP**：远程 MCP server `mcp.mem0.ai`；插件内置 9 个 MCP 工具（add/search/get/get_all/update/delete/delete_all/delete_entities/list_entities）。
- **基准**：`evaluation/` 是 git submodule → `mem0ai/memory-benchmarks`（`D:\memory_projects\mem0\.gitmodules`），LoCoMo/LongMemEval/BEAM 复现脚本都在该仓库。

### 1.4 生态规模（provider 数，`AGENTS.md` "Architecture" 表）

| 类别 | 数量 | 代表 |
|---|---|---|
| LLM | 24 | OpenAI(gpt-5-mini 默认)、Anthropic、Bedrock、Gemini、Groq、Ollama、DeepSeek、vLLM、LiteLLM 等 |
| Vector Stores | 30 | Qdrant(默认)、Pinecone、Chroma、Weaviate、Milvus、pgvector、MongoDB、Redis、ES、Faiss 等 |
| Embeddings | 15 | OpenAI(text-embedding-3-small 默认)、Azure、Gemini、HuggingFace、Ollama、Vertex 等 |
| Rerankers | 5 | Cohere、HuggingFace、LLM-based(默认 gpt-5-mini)、Sentence Transformer、Zero Entropy |
| Graph Stores | 4（**v3 已移除**） | Neo4j、Memgraph、Kuzu、Apache AGE |

> 注：`LLM.md`（给 LLM 的训练文件）与 `docs/platform/platform-vs-oss.mdx` 中的 provider 计数（19/20/15 等）与 `AGENTS.md` 略有出入——以 `AGENTS.md` 为准，因为它是随代码维护的。

### 1.5 版本与成熟度

- `pyproject.toml` 版本 `mem0ai 2.0.15`；git HEAD 提交为 "chore: bump versions and update changelog for Python 2.0.15, TypeScript 3.1.3"。
- **v3 记忆算法（2026 年 4 月发布）**是当前主线：README 有 "New Memory Algorithm" 章节；`docs/migration/oss-v2-to-v3.mdx` 与 `platform-v2-to-v3.mdx` 是官方迁移指南。核心变化：单遍 ADD-only 提取、混合检索（语义 + BM25 + 实体）、内置图记忆（entity linking）、Temporal Reasoning（Platform 专属）。
- 工程成熟度高：CI 门（`ci-gate.yml`）分包跑测试、OIDC trusted publishing、pre-commit（ruff+isort）、pytest（Python）+ jest/vitest（TS）。

---

## 2. 核心理念 / 理论

### 2.1 心智模型：Messages vs Memories

- **存事实，不存原文**：默认 `infer=True` 时，Mem0 用 LLM 把对话"提炼成可复用的独立事实"存储，而非逐字保存 transcript（`docs/core-concepts/how-it-works.mdx` "Messages vs memories"）。
  - `"I prefer aisle seats"` → `User prefers aisle seats`
  - `"Let's use Postgres for this project"` → `Project decision: use Postgres`
- `infer=False`（Direct Import）则原样存储原始文本。
- 两阶段使用模式：**交互后 `add` 写入，模型调用前 `search` 读取**，应用自己决定把哪些结果放进 prompt。

### 2.2 分层记忆（`docs/core-concepts/memory-types.mdx`）

| 层 | 生命周期 | 用途 |
|---|---|---|
| Conversation memory | 单次响应 | 工具调用、chain-of-thought |
| Session memory | 分钟~小时 | 多步任务（用 `run_id` 隔离） |
| User memory | 周~永久 | 个性化偏好 |
| Org memory | 全局配置 | 多 agent 共享知识 |

- 对应经典认知科学分类：事实/情景/语义记忆。检索时按 user > session > history 排序。
- **警告**：Mem0 默认可检索，勿存密钥/未脱敏 PII（memory-types.mdx 与 how-it-works.mdx 均明确）。

### 2.3 三存储模型（`how-it-works.mdx` "Where memories live"）

| Store | 存什么 | 用途 |
|---|---|---|
| SQL 数据库（SQLite `history.db`） | 事实 + 元数据 + 变更历史 | 变更审计（add/update/delete 历史） |
| 向量数据库 | 嵌入向量 | 语义相似检索 |
| Entity/Graph Store（`{collection}_entities`） | 实体 + linked_memory_ids | v3 内置图记忆，检索时 boost |

### 2.4 v3 算法哲学

- **ADD-only：记忆只增不覆盖**。信息变化时（如搬城市）新旧事实并存，靠检索排序让"最相关的当前信息"排前面（`oss-v2-to-v3.mdx`）。旧算法用两次 LLM 调用（提取候选 + 决定 ADD/UPDATE/DELETE），新算法**单次 LLM 调用只做 ADD**，模型算力花在理解输入而非 diff 现有记忆。
- **Agent 生成的事实也是一等公民**：assistant 说的"我帮你订好 3 月 3 日航班"也会被提取存储（旧算法常忽略）。
- **图记忆内置**：v3 移除外部图数据库（Neo4j 等，~4000 行代码），改为在 add 时从记忆里自动提取实体（专有名词/引用/复合名词短语），存入同名向量集合 `{collection}_entities`，共享实体的记忆互相链接；检索时查询实体匹配该集合并 boost 关联记忆。**影响排序、不改变响应形状**（不再有 `relations` 字段）。
- **优雅降级**：spaCy 缺失 → 无实体/无 BM25 词形还原；fastembed 缺失（Qdrant）→ 无 BM25；实体集合不可用 → 无实体 boost。**语义检索永远可用**（`oss-v2-to-v3.mdx` "Graceful Degradation"）。

---

## 3. 架构

### 3.1 分层与 Provider 模式

每个能力类别有一个抽象基类 + 多个 provider 实现，全部可插拔：

| 层 | 抽象基类 | 关键接口 |
|---|---|---|
| LLM | `mem0/llms/base.py` | `generate_response(messages, tools, tool_choice, **kwargs)`；含 reasoning-model 与 GPT-5 系列参数过滤逻辑（`_is_reasoning_model` / `_uses_max_completion_tokens`） |
| Embeddings | `mem0/embeddings/base.py` | `embed(text, memory_action: "add"|"search"|"update")` + `embed_batch` |
| Vector Store | `mem0/vector_stores/base.py` | `create_col/insert/search/delete/update/get/list`；**`search` 须返回 [0,1] 相似度**；v3 新增 `keyword_search`（第 68 行，BM25/全文）与 `search_batch`（第 85 行，实体批量匹配），不支持则优雅降级 |
| Reranker | `mem0/reranker/base.py` + `llm_reranker.py` | `rerank(query, results, limit)`；LLM reranker 默认 openai / `gpt-5-mini` |
| History DB | `mem0/memory/storage.py` | `SQLiteManager`，`history` 表（id/memory_id/old_memory/new_memory/event/created_at/updated_at/is_deleted/actor_id/role）+ `messages` 表；含老 schema 迁移 |

- 配置集中在 `mem0/configs/base.py` 的 `MemoryConfig`：`vector_store` / `llm` / `embedder` / `reranker` / `history_db_path`（默认 `~/.mem0/history.db`）/ `version` / `custom_instructions`。
- Factory：`mem0/vector_stores/factory.py`、`llms/factory.py` 等按 provider 名创建实例。
- 统一入口：`Memory`（同步，`main.py:463`）与 `AsyncMemory`（`main.py:2137`），`AsyncMemory` 通过 `asyncio.to_thread` 封装同步路径。

### 3.2 存储细节

- **向量 payload 键**（`main.py` add/update 与 get 的 `core_and_promoted_keys`）：`data`（事实文本）、`hash`（MD5 去重）、`created_at`/`updated_at`、`text_lemmatized`（BM25 用）、`user_id`/`agent_id`/`run_id`/`actor_id`/`role`/`attributed_to`/`expiration_date`（promoted 键，作为顶层字段返回）；其余键进 `metadata`。
- **实体存储**（`main.py` `_upsert_entity`，581 行）：payload 含 `data`（实体文本）、`entity_type`（PROPER/QUOTED/TOPIC/IDENTIFIER）、`linked_memory_ids`；实体去重 = 文本归一化精确匹配优先，语义匹配兜底（相似度 ≥ 0.95）。
- **消息持久化**：`db.save_messages` 把每轮对话存进 `messages` 表（供 `get_last_messages` 做提取上下文）。
- **历史表**：每次 add/update/delete 记录 `history` 行（event ADD/UPDATE/DELETE，delete 时 `is_deleted=1`）；`history(memory_id)` 可追溯每次变更。

### 3.3 Self-Hosted Server 架构（`server/`）

- **FastAPI 单体**（`server/main.py`）：认证（JWT + `ADMIN_API_KEY` + `AUTH_DISABLED`，默认开启）、限流（slowapi）、请求日志（`RequestLog`，/requests）、/api/health 豁免。
- **默认配置**（`main.py` DEFAULT_CONFIG）：pgvector（POSTGRES_* 环境变量）+ OpenAI（默认 `gpt-5-mini` / `text-embedding-3-small`）+ `history.db`。
- **状态管理**（`server_state.py`）：全局单例 `Memory` 实例 + `config_overrides` 持久化（运行时改 LLM/embedder 配置，重启生效）。
- **路由**：`routers/`（auth / api_keys / entities / requests），alembic 迁移，Docker Compose：mem0 + pgvector/pgvector:pg17 + mem0-dashboard。
- **Dashboard**（Next.js，`server/dashboard`）：Requests 审计日志、Memories 浏览、Entities 管理（带 cascade-delete）、API Keys、配置覆盖。

---

## 4. 记忆核心实现（add / search / update / delete / history）

> 全部在 `mem0/memory/main.py`（3821 行）。以下按公开 API 梳理。

### 4.1 add()（736 行）

输入校验 → 构建 filters/metadata（`_build_filters_and_metadata`，302 行）→ 校验 memory_type → 规范化 messages → 调 `_add_to_vector_store`（850 行）。

**`_add_to_vector_store` 的 V3 分阶段流水线（887 行起）：**

| Phase | 内容 | 细节 |
|---|---|---|
| 0 | Context gathering | `db.get_last_messages(session_scope, limit=10)` 取最近消息 + `parse_messages` |
| 1 | 现有记忆检索 | 语义检索 top_k=10（同 user_id/agent_id/run_id 作用域），UUID 映射成 `"0","1",...` 防幻觉 |
| 2 | **单次 LLM 提取** | system prompt = `ADDITIVE_EXTRACTION_PROMPT`（+ agent 作用域加 `AGENT_CONTEXT_SUFFIX`）；user prompt = `generate_additive_extraction_prompt`（含 Summary / Last k Messages / Recently Extracted / Existing Memories / New Messages / Observation Date / Current Date / 可选 Custom Instructions / 可选语言要求）；要求 `response_format={"type":"json_object"}`；解析 `{"memory":[{id,text,attributed_to,linked_memory_ids}]}` |
| 3 | 批量嵌入 | `embed_batch(texts, "add")`，失败逐条回退 |
| 4/5 | 哈希去重 | **MD5 文本哈希**，与现有记忆哈希 + 批内 seen 去重；`text_lemmatized = lemmatize_for_bm25(text)` 写入 payload |
| 6 | 批量持久化 | `vector_store.insert`（批量，失败逐条回退）+ `db.batch_add_history` |
| 7 | 批量实体链接 | `extract_entities_batch` → 全局去重 → 批量嵌入实体 → `entity_store.search_batch` 找已有实体（exact 优先 + 语义 ≥0.95）→ 更新已存在的 `linked_memory_ids` 或批量插入新实体 |
| 8 | 保存消息 + 返回 | 返回 `{"results":[{id, memory, event:"ADD"}]}` |

- `infer=False`：跳过 LLM，逐条把每个非 system 消息原样入库（Direct Import 路径）。
- `memory_type="procedural_memory"`：走 `_create_procedural_memory`（1964 行），用 `PROCEDURAL_MEMORY_SYSTEM_PROMPT` 把对话总结成程序性记忆（step-by-step 流程），需 `agent_id`。
- **错误语义**：LLM 提取失败现在会 re-raise `LLMError`（而非静默返回空），让调用方能区分"模型不可用"与"没提取到事实"（940 行注释）。
- **提取质量约束**（prompts.py 468 行起）：只提取有证据的独立事实；每个可记忆信息单独成条；用户消息以 User 视角、助手内容以"User was recommended X"视角写；相对时间必须锚定 Observation Date（"yesterday"→具体日期）；若新信息与现有记忆语义等价则跳过；相关记忆通过 `linked_memory_ids`（UUID）链接；text 建议 15-80 词、自包含、含上下文。

### 4.2 search()（1350 行）

参数校验（top_k 默认 20、threshold 默认 0.1、rerank 默认 False）→ 实体 ID 必须在 `filters`（顶层传会 `ValueError`）→ `_search_vector_store`（1599 行）：

1. 预处理：`lemmatize_for_bm25(query)` + `extract_entities(query)`
2. 嵌入查询：`embed(query, "search")`
3. 语义检索：**over-fetch** `internal_limit = max(limit*4, 60)`（候选池扩大，给 boost/过滤留空间）
4. 关键词检索：`keyword_search(query_lemmatized, ...)`（如支持）
5. BM25 归一化：`normalize_bm25(raw, midpoint, steepness)`，参数按**查询长度自适应**（见 §5）
6. 实体 boost：`_compute_entity_boosts`（见 §5）
7. 候选集 = 语义结果（过滤过期记忆）
8. `score_and_rank` 融合排序（阈值门槛在合并**之前**对 semantic 分生效）
9. 格式化：promoted 键提为顶层，其余进 metadata；`explain=True` 时返回 `score_details`

- rerank=True 且配置了 reranker 时，对初步结果再跑一次 `reranker.rerank`。
- 元数据高级过滤（`_process_metadata_filters`，1495 行）：支持 `eq/ne/gt/gte/lt/lte/in/nin/contains/icontains`、`"*"` 通配、`AND/OR/NOT` 逻辑组合，转换为各向量库格式（Qdrant 为 `$or/$not` 等）。

### 4.3 get / get_all / update / delete / delete_all / history / reset

- `get(memory_id)`（1179 行）：按 ID 取单条；promoted 键提为顶层；`get` 不因过期隐藏（无 show_expired 参数）。
- `get_all`（1226 行）：`filters` 必须含至少一个实体 ID；`top_k` 默认 20；`show_expired=False` 时 fetch `max(limit*4, 60)` 再过滤。
- `update(memory_id, text/metadata/expiration_date)`（1786 行）：重新嵌入 + 更新 payload + 写 UPDATE 历史 + **实体清理/重链**（`_remove_memory_from_entity_store` 628 行 + `_link_entities_for_memory` 683 行）；`user_id/agent_id/run_id/actor_id` 创建后不可变。
- `delete(memory_id)`（1840 行）：向量删除 + DELETE 历史 + 从实体记录剥离 memory_id（linked 清空则删实体记录）。
- `delete_all`（1861 行）：分批 list（每批 1000）→ 逐条 `_delete_memory`，带循环批次检测防无限循环；不传任何实体 ID 会要求用 `reset()`。
- `history(memory_id)`（1917 行）：从 SQLite 读变更历史。
- `reset()`（2095 行）：清向量集合 + 重置 SQLite + 重置实体存储。

### 4.4 TypeScript SDK（`mem0-ts/src/oss/src/memory/index.ts`，2197 行）

- 与 Python **功能平行**：同样的 `rejectTopLevelEntityParams`、add 分阶段流水线、`search` 混合打分、通知系统（temporal/decay/scale/performance 提示）。注意 TS 的 payload 键用 camelCase（`textLemmatized`），与 Python 的 snake_case **不互通**——文档明确警告"跨语言共享同一向量集合时 BM25 不解析，集合应语言隔离"（oss-v2-to-v3.mdx TS 表）。

---

## 5. 检索算法（核心亮点）

### 5.1 三信号融合（`mem0/utils/scoring.py`，全文 139 行）

```
combined = min((semantic + bm25 + entity_boost) / max_possible, 1.0)
```

- **阈值门槛前置**：semantic_score < threshold 直接剔除，即使 BM25/实体能拉高（`score_and_rank` 第 74 行注释）。
- **自适应分母**（按可用信号）：语义-only → 1.0；+BM25 → 2.0；+实体 → 2.5；语义+实体（无 BM25）→ 1.5。保证输出在 [0,1]。
- **BM25 是 boost 而非召回扩充**：候选集只有语义检索结果，BM25 与实体只改排序、不加新候选（`oss-v2-to-v3.mdx` "Scoring"）。

### 5.2 BM25 归一化：查询长度自适应 sigmoid（`scoring.py` 16-54 行）

- 长查询 raw BM25 天然偏高，因此 sigmoid 的 **midpoint/steepness 随词数变化**：
  | 词数 | midpoint | steepness |
  |---|---|---|
  | ≤3 | 5.0 | 0.7 |
  | ≤6 | 7.0 | 0.6 |
  | ≤9 | 9.0 | 0.5 |
  | ≤15 | 10.0 | 0.5 |
  | >15 | 12.0 | 0.5 |
- `normalize_bm25 = 1/(1+exp(-steepness*(raw-midpoint)))`，把无界 BM25 压到 [0,1] 与语义分可比。
- **词形还原**（`utils/lemmatization.py`）：spaCy lemma（attend/attends/attended→attend），且**额外保留 -ing 原形**处理名词/动词歧义（meeting vs meet）。

### 5.3 实体提取（`mem0/utils/entity_extraction.py`，772 行）

- 四类实体（`(entity_type, text)` 元组）：
  | 类型 | 来源 | 优先级 |
  |---|---|---|
  | PROPER | spaCy NER（PERSON/ORG/GPE/LOC/FAC/PRODUCT/...，**排除 DATE/TIME/CARDINAL/QUANTITY 等数字时间标签**）+ 专名跨度（含 "of/the/for/at/in" 连接词） | 0 |
  | IDENTIFIER | 技术标识符（`foo.bar.Baz` 风格正则） | 1 |
  | PROPER | 普通专名 | 2 |
  | QUOTED | 引号内文本（长度>2） | 3 |
  | TOPIC | 复合名词短语（noun chunks，含具体形容词或 compound 修饰，排除通用 head 如 thing/stuff/way/time、非特定形容词 many/some/new 等、circumstantial 修饰 solo/team/group） | 4 |
- 大量工程化过滤：`_GENERIC_HEADS`（60+ 通用名词）、`_GENERIC_SINGLE_ENTITY_TERMS`（user/assistant/agent/...）、`_NON_SPECIFIC_ADJ`（~100 模糊形容词）、`_GENERIC_ENDINGS`、`_GENERIC_CAPS`、格式化标记、跨度重叠解决（span resolution）。
- spaCy 不可用返回 `[]`（优雅降级）。

### 5.4 实体 boost（`main.py` `_compute_entity_boosts`，1704 行）

- 查询实体去重（最多 8 个）→ 批量嵌入 → **4 线程并行**在实体库搜索（top_k=500）→ 相似度 ≥0.5 才计 → boost 计入其 `linked_memory_ids` 指向的每条记忆。
- **权重公式**：
  ```
  memory_count_weight = 1 / (1 + 0.001 * (num_linked - 1)^2)
  boost = similarity * ENTITY_BOOST_WEIGHT(=0.5) * memory_count_weight
  ```
  实体链接的记忆越多，单条 boost 越低（防热门实体淹没一切）；最终 `ENTITY_BOOST_WEIGHT=0.5` 意味着实体信号最大贡献 0.5。

### 5.5 检索链路总览

```
Query
  → lemmatize + extract_entities（预处理）
  → embed(query, "search")
  → semantic search (over-fetch max(limit*4,60))        [候选集唯一来源]
  → keyword_search → BM25 sigmoid 归一化（查询长度自适应）
  → entity search → boost（0.5 权重 × 链接数衰减）
  → score_and_rank 融合（阈值前置、自适应分母）→ top_k
  → 可选 rerank（LLM/Cohere/...）→ 格式化返回
```

---

## 6. 团队 / 多用户

### 6.1 实体作用域（`docs/platform/features/entity-scoped-memory.mdx`）

- 四维身份：`user_id`（人/账号）、`agent_id`（agent 人格/工具）、`app_id`（白标 app/租户）、`run_id`（短期流程/会话/工单）。
- 写入（add）接受任意组合；**默认提取路径上**，每条事实归因到说话者：user 消息 → 只带 `user_id`；assistant 消息 → 只带 `agent_id`；`app_id`/`run_id` 每条都带。
  - 因此 `{"AND":[{"user_id":...},{"agent_id":...}]}` 对默认路径创建的记录**查不到**（两条不可能同时非空）——文档专门警告。要匹配任一侧用 `OR`。只有 Direct Import（`infer=False`）会产生双字段记录。
- 读取（search/get_all）身份放 `filters`；删除（delete_all）走 query 参数。
- **未提及的维度不受约束**：只传 `{"user_id":"alice"}` 不会要求 agent_id 为 null。
- 通配符 `"*"` 只匹配非空值。

### 6.2 OSS 多用户

- OSS 中实体 ID 就是向量集合内的 filter（`user_id`/`agent_id`/`run_id` 进 Qdrant/pgvector 过滤），天然支持多用户隔离；`search`/`get_all` 强制要求至少一个实体 ID，防止跨用户混搜。
- 实体库同样按这些 filter 隔离（`_upsert_entity` 里 search_filters 只取 user_id/agent_id/run_id）。
- 无内置 RBAC/团队 UI——那是 Self-Hosted Server 与 Platform 的能力。

### 6.3 Self-Hosted Server 的团队能力（`server/`）

- 认证默认开启：`JWT_SECRET` 必填、可选 `ADMIN_API_KEY`、`AUTH_DISABLED=true` 仅限本地。
- Dashboard 支持：管理员注册（首个 admin 后注册关闭）、**per-user API Key**（`m0sk_...` 仅显示一次，服务端只存前缀 + bcrypt）、请求审计日志、Entities 管理（cascade-delete）、配置覆盖。
- 定位 = 团队自有基础设施上的"小 Platform"。

### 6.4 Platform 的团队/项目（`mem0/client/project.py`）

- `Project` 类提供 `add_member(email, role=READER)` 等成员/权限模型（角色至少含 READER）；`project.get()/update()`（decay、multilingual、custom_categories 等开关挂在项目上）。
- 托管侧还有：组织/项目两级、`users()`/`delete_users()`、feedback（`feedback(memory_id, ...)`）、webhooks、memory export。

---

## 7. 数据支撑（Benchmark）

### 7.1 主数字（README "New Memory Algorithm" 表 + `docs/core-concepts/memory-evaluation.mdx`）

| Benchmark | 旧算法 | 新算法 | 平均 token/query | 延迟 p50 |
|---|---|---|---|---|
| **LoCoMo** | 71.4 | **92.5** | 7.0K / 6,956 | 0.88s |
| **LongMemEval** | 67.8 | **94.4** | 6.8K / 6,787 | 1.09s |
| **BEAM (1M)** | — | **64.1** | 6.7K / 6,719 | 1.00s |
| **BEAM (10M)** | — | **48.6** | 6.9K / 6,914 | 1.05s |

- **口径**：single-pass 检索（一次检索调用，无 agentic loop），`top_200` 检索预算，生产代表性模型栈（非 frontier），±1 分置信区间（judge 不一致）。**平台分数含专有优化，OSS 用户应期待"方向相似"而非相同数字**。
- 各维度明细（memory-evaluation.mdx）：
  - LoCoMo：single-hop 91.2 / multi-hop 91.3 / open-domain 72.7 / temporal 92.0。Temporal 与 multi-hop 受益最多，open-domain 不获益（正在调优）。
  - LongMemEval：single-session(user) 98.6 / single-session(assistant) 98.2 / preference 96.7 / knowledge update 93.6 / temporal 97.0 / multi-session 88.0。**Knowledge update 是 ADD-only 架构的软肋**：旧事实保留不覆盖，语义相近的旧事实会与新事实并存。
  - BEAM：preference_following 88.3→90.4（1M→10M）、instruction_following 85.2→82.5、knowledge_update 65.0→75.0 表现好；temporal_reasoning 61.8→16.3、event_ordering 53.6→20.2、multi_session_reasoning 65.2→26.1 在 10M 崩（文档承认这是全行业开放问题）。
- 迁移文档里的对应表述（`oss-v2-to-v3.mdx` / `platform-v2-to-v3.mdx`）：LoCoMo **71.4→91.6（+20）**、LongMemEval **67.8→93.4（+26）**、**提取延迟 p50 ~2.0s→~1.0s**、temporal +29.6（LoCoMo）/ multi-hop +23.1 / assistant recall +53.6（LongMemEval）。
- `LLM.md` 早期版本数字：+26% accuracy over OpenAI Memory on LOCOMO、91% faster、90% lower token（vs 全上下文方案）。

> **诚实提醒**：README/评估文档用 92.5/94.4，迁移文档用 91.6/93.4——同为官方数字，差 0.9~1 分，可能与版本/运行批次差异有关，口径需以各自文档上下文为准。基准脚本开源（memory-benchmarks），可用 `--top-k 200`、`--top-k-cutoffs 10,20,50,200` 复现。

### 7.2 评估方法论（memory-evaluation.mdx 第 312-320 行，行业视角很有价值）

- 小基准饱和 ≠ 可扩展记忆系统（可被激进检索 + frontier 模型暴力破解）。
- **token 效率与准确率同等重要**（95%@25K tokens ≠ 90%@7K tokens），必须报告每查询平均 token。
- 同约束比较：相同检索预算、相同模型、相同延迟预算。
- 注意天花板效应（single-session user 已 97%+）。
- BEAM 10M 才是真正考验。

### 7.3 官方复现路径

- `evaluation/` submodule → `mem0ai/memory-benchmarks`；`git submodule update --init evaluation` 填充。
- 每个 benchmark 是独立 runner（`benchmarks/{locomo,longmemeval,beam}/run.py`），共享 CLI：`--backend oss|cloud`、`--top-k 200`、`--answerer-model`、`--judge-model`、`--resume` 等；结果落 `results/[benchmark]/` 并有 web UI。

---

## 8. 优点（独到设计）

1. **ADD-only 单遍提取**：把记忆写入从"提取 + 更新决策"两遍 LLM 调用压缩为一遍，提取延迟减半、结果 +20/+26 分。模型算力全部花在理解输入，而非与旧记忆做 diff。这是本 repo 最核心的设计洞见。
2. **混合检索的工程化程度高**：语义（候选）+ BM25（词形还原 + 查询长度自适应 sigmoid）+ 实体 boost（0.5 权重 + 链接数衰减）三信号融合，分母自适应、阈值前置、`explain=True` 可观测——不是简单拼接，是精心调参的算法。
3. **内置图记忆取代外部图数据库**：实体提取 + 链接全自动、零配置、与向量库同设施（`{collection}_entities`），无运维负担且优雅降级。对"免部署"的 SaaS 化是重大简化。
4. **生态纵深**：24 LLM / 30 向量库 / 15 嵌入 / 5 reranker provider，Python + TypeScript 双实现，Plugin/MCP/Skills/CLI/REST server 全链路覆盖，Apache 2.0。接入现有 agent 生态成本极低。
5. **企业级工程纪律**：CI Gate 分包测试、OIDC 发布、pre-commit、pydantic v2 配置校验、结构化错误码（`Mem0ValidationError` VALIDATION_002/003）、`requests` 审计日志、JWT+bcrypt API Key、优雅降级与批量回退（embed_batch 失败逐条、insert 失败逐条）。错误边界与 fallback 逻辑写得非常细致。
6. **诚实的技术叙事**：明确区分 Platform（专有优化）与 OSS 分数；明确 knowledge-update 软肋与 BEAM 10M 弱项；开放基准仓库；"报告 token/延迟而不只报准确率"的评估哲学。
7. **生产可操作细节**：记忆过期（`expiration_date`，软隐藏不删除）、变更历史（history 表）、`delete_all` 循环批次检测、`reset()`、实体清理（update/delete 时级联维护 linked_memory_ids）、词形还原保留 -ing 处理歧义。
8. **提取 prompt 质量工程**：prompts.py 里几十个 few-shot 示例（多主题、assistant 推荐、去重、泛化时间、法律文档引用），把提取行为约束得相当具体（属性化 attributed_to、链接 linked_memory_ids、时间锚定 Observation Date、输出 15-80 词自包含事实）。

---

## 9. 缺点 / 局限（诚实评估）

1. **LLM 依赖度 = 成本与延迟**：提取、去重、程序记忆、LLM reranker 都依赖外部 LLM；OSS 默认 OpenAI。虽有 `infer=False` 直存与异步批量，但默认主路径每轮 add 一次 LLM 调用 + 多次嵌入。离线/私有部署成本高（`[nlp]` extra 还需 spaCy，且 Python 3.13 无预编译 wheel）。
2. **ADD-only 的语义取舍**：记忆只增不改 → **知识更新场景旧事实永远并存**（LongMemEval knowledge update 93.6、BEAM 10M 崩到 16.3-26.1 的问题类别多与此相关）。文档自己承认这是"本领域开放问题"。对"事实必须被纠正"的应用（如账号信息更新）需要应用层自己 update/delete 或依赖排序掩盖。
3. **分数口径不一致**：92.5/94.4（README/评估文档）vs 91.6/93.4（迁移文档）并存；`LLM.md` 的 provider 计数与 `AGENTS.md` 不一致（19 vs 30 向量库、20 vs 24 LLM）；`LLM.md` 大量 API 已过时（`org_id/project_id` 构造参数、graph_store 配置在 v3 已删）。文档多处落后于代码。
4. **Platform 与 OSS 能力断层**：Temporal Reasoning、Memory Decay、Webhooks、Memory Export、Custom Categories（完整）、Dashboard 均为 Platform 专属（`platform-vs-oss.mdx`）。OSS 拿到的是"方向相似"而非相同质量——"开源"叙事与"托管引流"的商业逻辑并存，需清醒认知。
5. **图记忆是"弱图"**：实体链接是共现图（schema-free、无类型化边），只做检索 boost，不做显式关系遍历（文档明说没有 "manages" 这类 labeled edge）。多跳推理主要靠实体 boost 的间接效果，不是真正的知识图谱推理。
6. **实体依赖 spaCy + 质量参差**：实体提取仅英文（spaCy en_core_web_sm），非英语/多语言场景实体链接基本失效；实体文本归一化匹配可能引入误链（不同实体共享文本）。BM25 在 Qdrant 需额外 fastembed，否则静默降级为纯语义。
7. **多租户/团队能力 OSS 基本没有**：OSS 只有实体 ID filter 隔离，无 RBAC/审计/团队管理——那是 server/Platform 的事。对"团队项目记忆"诉求，OS S 库形态只是"勉强可用"。
8. **`get_all` 无分页、`delete_all` 分批**：OSS `get_all` 一次性返回（top_k 限制），大规模集合下列举会压力大；`history.db` SQLite 单机文件，无分布式历史存储。

---

## 10. 可借鉴点（站在"团队项目记忆系统"角度）

1. **ADD-only + 检索排序承载"更新语义"**：与其在写入端做复杂的合并/覆盖决策（容易丢信息），不如全量保留 + 靠检索把最相关/最新的事实排前面。对"信息变更频繁但历史有用"的场景（偏好漂移、搬家、职位变化）是更稳的默认。**代价是存储膨胀，需配过期/清理机制**。
2. **混合检索的归一化工程**：BM25 与余弦相似度量纲不同，直接相加无意义。借鉴它：sigmoid 按查询长度自适应参数把 BM25 压到与语义分同量纲；融合时按实际可用信号调整分母（保证输出 [0,1]）；阈值在前置阶段对主导信号生效。这是可复现的通用做法。
3. **实体链接作为"图记忆"的轻量实现**：不部署 Neo4j，而是在向量库里放一个 `{collection}_entities` 集合存"实体 → linked_memory_ids"，检索时实体查询 boost 关联记忆。成本极低、零运维、可降级，换来实体查询/跨记忆关联的显著提升。团队记忆里的"项目名/人名/专有名词"这类强信号尤其适用。
4. **"提取 prompt 即产品规格"**：把记忆提取的行为约束（要提取什么、跳过什么、怎么归因、怎么锚定时间、输出格式 few-shot）全部写进 prompt 并随代码版本管理（prompts.py 1062 行）。LLM 记忆系统的核心逻辑在 prompt 而非代码，值得把 prompt 当成一等代码资产打磨。
5. **写路径的健壮性模式**：批量嵌入/批量插入失败自动逐条回退；实体链接、实体清理全部吞异常不阻塞主路径；hash（MD5）双级去重（对库 + 批内）；uuid 映射防 LLM 幻觉 ID。这些"外围容错"决定了生产可用性，值得全套照抄。
6. **可观测与审计**：`explain=True` 返回 `score_details`（各信号分、raw、分母、阈值）；history 表记录每次 add/update/delete 的 old/new/actor；请求审计日志。团队场景下"某条记忆为什么被检索到 / 谁改过"是刚需。
7. **评估哲学**：报告"每查询 token + 延迟 + top-K 多个截断深度"而不只报准确率；同约束比较；承认小基准饱和与天花板效应。做记忆系统的团队应该把这套评估纪律内化为标准。
8. **Provider 抽象 + 优雅降级**：LLM/嵌入/向量/reranker 全部抽象接口化，可选依赖缺失时逐能力降级（语义永远可用）。记忆系统的组件替换自由度高，避免被单一厂商锁定（尽管 Platform 叙事与之矛盾）。
9. **可借鉴但需谨慎的点**：LLM 自动提取的幻觉风险（建议低置信降级或人工确认）；"实体文本匹配"的误链风险；`MEM0_TELEMETRY`/PostHog 遥测默认开启的隐私问题——团队内部记忆系统应默认关闭遥测。
