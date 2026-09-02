# GroupMemBench / OrgMemBench 测试操作手册

本手册只说明 **如何准备数据、如何启动**。适配代码在 `eval/groupmem-orgmem` 分支。  
**不要**把全量评测当 CI 门禁；官方 GroupMemBench 用 gpt-5 QA+judge，官方 OrgMemBench 用 Docker harness + rubric LLM judge。本仓 `evals/run.ts --adapter` 默认是 **完整能力流水线冒烟**（ingest note → dream 蒸馏+矛盾 → 混合检索 goldHit），**不是**官方分数。

验收约定：代码与手册写好即可。**本任务不启动全量评测。**

## 0. 前置

- 已切到分支 `eval/groupmem-orgmem`（基于十一期 P11.1–P11.5）。
- Bun 可用：`bun --version`
- 仓内夹具 **不需要** API Key。
- 全量 fetch 需要出网；GroupMemBench Technology 频道 JSON 约数万条消息，下载与 ingest 都很大。
- 若要用官方 LLM judge，需要你们自己的模型资源（见文末「需要模型的步骤」）。本仓评测 LLM 默认可走 **OpenCode Go**（`OPENCODE_API_KEY`）。

工作目录：仓库根 `d:\memory_projects\lhdrcMem`（或你的 clone 根）。

## 1. 仓内夹具（推荐先跑，无网）

自建小样，形状对齐上游，**不是**官方全量。

### 1.1 GroupMemBench 夹具

知识更新：先写「on-call 7 天」，再写「改为 14 天」。检索应能命中 14 days。

```powershell
bun run eval:groupmembench-sample
```

等价：

```powershell
bun run evals/run.ts --adapter groupmembench --fixture
memory eval --adapter groupmembench --fixture
```

期望：进程退出 0，stdout JSON 含 `"adapter":"groupmembench"`、`pipeline":"ingest_dream_query"` 且 `metrics.accuracy` 为 1（2 道题都 goldHit）。receipt 写到 `evals/receipts/`。无 LLM 时 `distill.skipped` 可为 true。

### 1.2 OrgMemBench 夹具

Rivermark 保留策略 90 天 → 30 天。C1 问 current policy；C2 问谁拍板 90 天。

```powershell
bun run eval:orgmembench-sample
```

等价：

```powershell
bun run evals/run.ts --adapter orgmembench --fixture
memory eval --adapter orgmembench --fixture
```

期望：退出 0，`accuracy` 为 1。

夹具失败时先查：`embedding.provider` 在 eval workspace 由 `createEvalWorkspace` 决定；夹具正文短，BM25 应能命中。

## 2. 拉取全量（只下载，不评测）

必须加 `--allow-net`。默认 **不联网**。

### 2.1 GroupMemBench

默认域 `Technology`、题型 `knowledge_update`（十一期最关心的更新题）。

```powershell
bun run evals/run.ts fetch --adapter groupmembench --allow-net
```

落地：

- `evals/cache/groupmembench/Technology/channels.json`
- `evals/cache/groupmembench/Technology/knowledge_update.jsonl`

换域 / 题型：

```powershell
$env:DF_EVAL_GMB_DOMAIN = "Finance"
$env:DF_EVAL_GMB_QTYPE = "multi_hop"
bun run evals/run.ts fetch --adapter groupmembench --allow-net
```

题型取值：`multi_hop` | `knowledge_update` | `temporal` | `user_implicit` | `term_ambiguity` | `abstention`。  
域：`Finance` | `Technology` | `Healthcare` | `Manufacturing`。

**体积警告**：单域 `channels.json` 约 2–3 万条消息。fetch 可能要几分钟；磁盘数百 MB 量级。失败时看 HTTP 状态；可用 HuggingFace 镜像 `kimperyang/GroupMemBench` 后把文件拷进上述 cache 路径。

### 2.2 OrgMemBench（Helix small，CC BY 4.0）

```powershell
bun run evals/run.ts fetch --adapter orgmembench --allow-net
```

落地 `evals/cache/orgmembench/`：

- `benchmark_v0.0.jsonl`（题目 + rubric）
- `corpus_index.jsonl`
- `corpus/**/*.md`（按 index 逐文件拉）

small 约一百多个 artifact。若 GitHub raw 限流，改为：

```powershell
git clone --depth 1 https://github.com/JackCGardner/OrgMemBench.git $env:TEMP\OrgMemBench
Copy-Item -Recurse $env:TEMP\OrgMemBench\datasets\helix\small\* evals\cache\orgmembench\
```

medium 更大，本 fetch **不拉 medium**。要 medium 请按官方 `docs/REPRODUCIBILITY.md` 自己拷到 cache，并改 adapter 读取的 jsonl 名（当前写死 `benchmark_v0.0.jsonl`）。

## 3. 对本仓跑完整能力流水线（全量仍不是官方分）

默认流水线（`DF_EVAL_FULL=1`）：

```
ingest（默认有 Key → 滑动窗口 compileSession / complete；无 Key → capture note）
  → sync 索引
  → baseline hybrid/think（可选，DF_EVAL_BASELINE）
  → dream phases 3,4（蒸馏 pending + 矛盾检测）
  → sync
  → 最终 query（带分层标注）
```

`DF_EVAL_INGEST=capture` 可强制不调 LLM；`compile` 强制走会话提取。

fetch 完成后再跑。GroupMem 全量 ingest 会非常慢，请先限条数：

```powershell
$env:DF_EVAL_MAX_INGEST = "200"
$env:DF_EVAL_GMB_DOMAIN = "Technology"
$env:DF_EVAL_GMB_QTYPE = "knowledge_update"
bun run evals/run.ts --adapter groupmembench
```

`DF_EVAL_MAX_INGEST=0`（缺省）表示不截断。截断后 accuracy **不能**当正式结果。

OrgMem small：

```powershell
bun run evals/run.ts --adapter orgmembench
```

只要检索冒烟、跳过 dream：

```powershell
$env:DF_EVAL_FULL = "0"
bun run evals/run.ts --adapter groupmembench --fixture
```

评分与 receipt 指标（本仓）：

| 轨 | metrics 字段 | 含义 |
|---|---|---|
| R 检索 | `accuracy` / `retrieval.final`；有基线时还有 `retrieval.baseline` + `lift` | top-k 拼接文本是否含 gold 子串 |
| D 蒸馏 | `distill.written` / `skipped` / `reason` | dream 第 3 段；无 LLM 时通常 `skipped` |
| C 矛盾 | `contradictions.intra` / `cross_file` / `listed_pairs` | dream 第 4 段；跨文件需真 embedding + facts |
| 分层 | `layers`（note/experience/…） | 最终 hits 的 `schema_type` 分布 |

| adapter | gold 规则 |
|---|---|
| groupmembench | 检索拼接文本是否包含 `answer` 子串（大小写不敏感） |
| orgmembench | `ground_truth_answer` 展平后的字符串 **任一** 出现在检索文本中 |

这比官方 gpt-5 / rubric facet 宽松或偏严都可能，**不可与论文表对比**。蒸馏/矛盾轨是能力展示，**不**折进唯一官方分。

## 4. 官方评测怎么启动（本仓不代跑）

### 4.1 GroupMemBench 官方 RAG + judge

需要 Python 3.9+、Azure OpenAI 或 OpenAI（默认 agent/judge 为 gpt-5）。

```powershell
git clone https://github.com/UCSB-NLP-Chang/GroupMemBench.git
cd GroupMemBench
pip install -r requirements.txt
copy .env.example .env
# 填 KEY
$env:DOMAINS = "Technology"
$env:BASELINES = "bm25"
$env:QTYPES = "knowledge_update"
bash run_eval.sh
```

Windows 无 bash 时用 Git Bash，或按 README 直接跑 `baselines/bm25/run_eval.sh` 并设置 `CONVERSATION_JSON` / `QUESTIONS_JSONL`。

要把 **df-memory** 接进官方 harness：用本仓 ingest（`capture` / session compile）建索引，再在他们的 `eval_lib` 里换成调用 `memory query`。那是后续工作，本分支未改他们的 Python。

### 4.2 OrgMemBench 官方 harness

```powershell
git clone https://github.com/JackCGardner/OrgMemBench.git
cd OrgMemBench
pip install -e .
# 按 docs/CONTRIBUTING-AN-ADAPTER.md 实现 MemoryAdapter
# 本仓对应：_ingest ← captureNode；_query ← hybridQuery / think
orgmembench run --system df-memory --tier small --execute
```

默认 `ORGMEMBENCH_DRY_RUN` 为开，真正跑分要关 dry-run 并准备 judge 模型。Docker 说明见上游 `docker/`。

**不要**在本任务里执行 `--execute` 全量。

## 5. 环境变量速查

| 变量 | 作用 | 缺省 |
|---|---|---|
| `DF_EVAL_GMB_DOMAIN` | GroupMem 域 | `Technology` |
| `DF_EVAL_GMB_QTYPE` | GroupMem 题型 | `knowledge_update` |
| `DF_EVAL_GMB_BASE` | GroupMem raw 根 URL | GitHub UCSB-NLP-Chang |
| `DF_EVAL_ORGMEM_BASE` | OrgMem small raw 根 | GitHub helix/small |
| `DF_EVAL_MAX_INGEST` | 最多 ingest 条数；`0` 不截 | `0` |
| `DF_EVAL_CACHE_DIR` | 覆盖 cache 目录 | `evals/cache/<adapter>` |
| `DF_EVAL_RECEIPT_DIR` | receipt 目录 | `evals/receipts` |
| `DF_EVAL_FULL` | `1`：ingest→dream(3,4)→query；`0`：仅 ingest→query | `1` |
| `DF_EVAL_BASELINE` | 全栈时是否先打基线检索分 | 随 FULL，默认开 |
| `DF_EVAL_DREAM_PHASES` | dream 相位列表 | `3,4`（全量建议 `4`：矛盾；`3` 蒸馏对万级 L0 需另批） |

| `DF_EVAL_QUERY` | `hybrid` 或 `think` | `hybrid` |
| `DF_EVAL_INGEST` | `auto` / `compile`（滑动窗+LLM）/ `capture`（人手 note） | `auto` |
| `DF_EVAL_COMPILE_CONCURRENCY` | 连续分区并行路数；每区独立 checkpoint | `1` |
| `DF_EVAL_WORKSPACE_RESET` | `1` 清空持久仓+checkpoint；默认 `0` 续跑 | `0` |
| `DF_EVAL_STOP_AFTER` | `ingest` 只摄入 | 空 |
| `DF_EVAL_SEMANTIC` | `1`：query 挂真 embedding 语义臂；默认关（夹具 hermetic） | `0` |
| `OPENCODE_API_KEY` | 评测 LLM 走 [OpenCode Zen](https://opencode.ai/docs/zen/)（`auto` 时检测到即改 `llm.base_url`） | 空 = 仍 `llm.provider=off` |
| `OPENCODE_GO_API_KEY` | 同上，备选 env 名 | — |
| `DF_EVAL_LLM` | `auto` / `opencode-go` / `off` / `openai` | `auto` |
| `DF_EVAL_LLM_MODEL` | chat 模型 id | `hy3-free` |
| `DF_EVAL_LLM_BASE_URL` | 覆盖根 URL | `https://opencode.ai/zen`（Go 套餐改 `/zen/go` + `hy3`） |
| `SILICONFLOW_API_KEY` / `DF_EVAL_API_BASE` | 评测临时仓 embedding 改写（语义臂 + 跨文件矛盾） | 空 = init 默认 openai/`OPENAI_API_KEY` |
| `DF_EVAL_EMBED_MODEL` / `DF_EVAL_EMBED_DIMS` | 覆盖 embedding model/dims | — |

**不要**把 token 写进 `memory.yml`。Go **没有** embeddings；语义臂与跨文件矛盾继续 `OPENAI_API_KEY` 或 SiliconFlow。

仓库根 `.env`（gitignore）填 `OPENCODE_API_KEY=` 即可，`bun run` 会自动加载。模板见 [`.env.example`](../.env.example)。

```powershell
# 编辑仓库根 .env 后：
bun run evals/run.ts --adapter groupmembench --fixture
```

## 6. 需要模型资源的步骤（不会在 CI 里假绿）

本仓夹具 ingest **默认仍是** `captureNode`（人手 note，不调 compile）。全栈流水线会跑 dream：

1. **蒸馏（dream 第 3 段）**：设 `OPENCODE_API_KEY`（或 mock）且 `llm.provider≠off` 时才会 `refineSource` 写 experience；否则 metrics 里 `distill.skipped=true`。
2. **矛盾（dream 第 4 段）**：同文件启发式看 facts；跨文件 cosine 需要真 embedding（非 local 哈希 fallback）。夹具 note 若无 facts，矛盾计数常为 0——属预期。
3. **本仓会话提取 / compile**：设 `OPENCODE_API_KEY` 后，评测仓会把 `llm.provider=openai`、`base_url=https://opencode.ai/zen`、`openai_api_key_env=OPENCODE_API_KEY`。模型默认 `hy3-free`。`DF_EVAL_LLM=off` 可关掉这层改写。
4. **GroupMemBench 官方** QA agent + judge 默认仍是 gpt-5；若要用 Go，需在上游 Python `.env` 里改 OpenAI-compatible base。
5. **OrgMemBench 官方** answerer + rubric judge（见上游 config）。

P11 单元测试没有活模型依赖；不必为十一期测例配 Key。
