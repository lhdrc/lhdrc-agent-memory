# df-memory

> 团队记忆，不止于会话。

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/version-0.13.0-green) ![Language](https://img.shields.io/badge/TypeScript-strict-blue) ![Tests](https://img.shields.io/badge/tests-200%2B-green)

![记忆从文档汇入项目脑](docs/images/hero.png)

## 简介

对话关了，上下文就没了。定过的决策、踩过的坑、换个会话就得重讲一遍。

**df-memory** 是开源、单机、本地部署的记忆仓：**文件是真相，索引可重建**。人用 CLI 读写，agent 用插件自动记、自动取。记忆落在带 `frontmatter` 的 Markdown 上，能打开、能 `grep`、能 `diff`；检索靠 PGLite（可选 Postgres）实时建，不绑云、不绑模型。当前 **十三期 P13.1–P13.5 done**，BM25、图谱、History 正排、Prompt 与矛盾检测已闭环。

## 核心特性

**Markdown 是真相，索引可以扔。** 每条记忆是一篇 Markdown，`rebuild-index` 随时从文件重建。git 是可选账本，默认攒 20 条或 5 分钟批量提交，也可 `off` 完全关掉。

**BM25 已物化，中文不丢分。** `fts_title/body + title/body_ngrams` 四列 `GIN` 表达式索引，`cleanForIndex` 统一去 `code`/`Markdown` 噪音，`power(len,0.3)` 长度归一，`phraseto_tsquery` 短语加权。万级文章仍走 `Bitmap Index Scan`。

**图谱建≡检索。** 10 种 `KNOWN_LINK_TYPES`（`decided/produced_by/works_on/belongs_to/works_at/founded/invested_in/advises/mentions/references`）`extra_verbs` 可扩；`who decided/invested …` 10 模板均走 `relational` 臂，`BFS depth≤2`。

**History 不进索引，按需回跳。** 全量对话落 `.dfmemory/inbox/sessions/*/messages.jsonl`，`note` 侧车 `history_index.jsonl` 存 `provenance→turn_index`，`read --with-history` / `history read --session` 按 `turn` 回跳原文；`query` 永不扫 `inbox`。

**Prompt 学 Codex。** `session-extract` 首部 `NO-OP Gate（Will future agent act better?）` + 高信号 4 桶 + `User>Tool>Assistant` + `when user said "<quote>" -> future default` + `success/partial/fail/uncertain` 分流；`abstract/overview` 保字面。

**真矛盾，非相似。** 实体桶 `k=5` + `cosine≥0.95` 快路径 + `值冲突/否定` 二筛（`isObjectValueConflict` + `alias` 归一）+ 灰区 `0.92-0.95` 批量 `LLM triage` + 人审 `contradiction resolve --keep a|b|both` 后 `superseded` 索引剔除 `*0`。

**LLM 是加速器，不是开关。** 无 Key 照样 `capture/query`；配模型才开 `compile/distill/skill`。语义缺失时 `openai→local` 哈希 `fail-open`，`onnx` 缺权重不冒充成功。

**写入只增，经验沉淀。** L0 `ADD-only`，`L1 experiences`、`L2 dream`、`L3 forget(soft)` 分层；`history` 不进 `L0`。

## 快速开始

环境：Node.js ≥ 20 或 Bun ≥ 1.0，git。

```bash
bun install

bun run memory -- init ./demo
cd demo

bun run memory -- capture --wait --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试" --explain
bun run memory -- read "brains/default/sources/default/issues/general/decisions/1-重试策略.md" --with-history
```

## 日常使用

```bash
# 写：capture 零 LLM；remember 走 LLM 编译。默认异步入队，--wait 同步
bun run memory -- capture --wait --title "会议结论" --type decision --body "..."
bun run memory -- remember --wait --body "我们在会上决定……"

# 查：query/ think / graph-query
bun run memory -- query "重试" --explain --json
bun run memory -- think "当前风险是什么" --json
bun run memory -- graph-query "谁投资了 Acme"

# History 回跳
bun run memory -- history read --session <id> --turn 2
bun run memory -- read <path> --with-history

# 矛盾
bun run memory -- contradiction list --json
bun run memory -- contradiction resolve <pair_id> --keep a --json

# 维护
bun run memory -- rebuild-index
bun run memory -- rebuild-index --pending-embeddings
bun run memory -- sync --commit
bun run memory -- job status <task_id> --json
```

### 配置 `memory.yml`

```yaml
brain_id: default
git: { mode: batch, batch_size: 20, batch_interval_ms: 300000 }
llm: { provider: off }          # off | openai
embedding: { provider: openai } # openai | local | onnx | off  # 无 Key 自动降级 local
search:
  fusion: { per_arm_min: 0.70, fused_min: 0.05, cosine_lambda: 0.3 }
  hotness: { enabled: true, half_life_days: 30, alpha: 0.15 }
```

## 架构概览

```
人/ agent ──► CLI / DSH 插件 ──► 单写者队列 ──► md 文件（真相）─┬─► PGLite 索引（BM25+向量+图，可丢）
                                              │                └─► git 批量账本
                                              └─► inbox → compile → L0 → dream → experiences/skills
读： hybrid（BM25 + 向量 + 图 + entity boost）→ RRF*rescale → cosine → signals → hotness → L0/L1
```

详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`specs/十三期/README.md`](specs/十三期/README.md)。

## 测试

```bash
bun run test              # 全量回归（真实 git + PGLite）
bun run test:isolation    # 多 brain / source 隔离
bun run typecheck
bun run eval:mini         # 检索 12 条 + 隔离
bun run eval:distill
bun run eval:report
```

## 进度

十三期 **P13.1-5 done**（`p131 4/4`、`p132 3/3`、`p133 3/3`、`p134 3/3`、`p135 3/3`），十二期 `P12.1-3 done`，`#9 HNSW` 未编码。详见 [`AGENTS.md`](AGENTS.md) 与 [`TODO.md`](TODO.md)。

## 贡献

欢迎 Issue / 想法 / PR。

流程：Issue 讨论 → Fork → 按 `AGENTS.md` 约束开发（先改 Spec 再改码，`bun:test` 覆盖 Given/When/Then）→ PR 附测试。

## 许可证

MIT（`LICENSE`）
