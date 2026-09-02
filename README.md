# df-memory

> **团队记忆，不止于会话。给 agent 一个不会失忆的本地大脑。**

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/version-0.13.0-green) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) ![Tests](https://img.shields.io/badge/tests-200+-green) ![PGLite](https://img.shields.io/badge/PGLite-zero--config-lightgrey)

![记忆从文档汇入项目脑](docs/images/hero.png)

**`query` 给你 10 条命中，`think` 给你答案。** 大多数记忆工具只做检索——把命中的 10 条 Markdown 甩给你自己读。df-memory 在此之上做了蒸馏、图谱和矛盾检测：检索后合成带来源的答案，告诉你哪些是过期事实、哪些还没验证。开箱 3 条命令，单机跑在你自己的磁盘上。

> **3 分钟跑起来。** `memory.yml` 不配也能跑，PGLite 2 秒就绪，`--local` 哈希向量离线可用。配上 `OPENAI_API_KEY` 才开 `compile` / `distill`。

## 它解决了什么

换个会话，agent 就忘了你定过的决策、踩过的坑。同一团队换个人，等于重新踩一遍。

**没记忆时：**

> 你：“网关超时之前定的是多少？”  
> Agent：“我没有相关上下文，需要你再提供一下。”

**有 df-memory 时：**

> 你：“网关超时之前定的是多少？”  
> Agent：“支付网关超时 5s，固定重试 3 次，2 月会上定的 [Source: decisions/1-重试策略.md]。注意：另一篇 `decisions/2-超时阈值.md` 曾写 2s，已被标记 `superseded`。”

同一条查询，一次给来源、一次给矛盾提示——这就是 `think` 和 `query --explain` 的区别。

## 核心能力

| 能力 | 一句话 | 关键实现 |
|---|---|---|
| **文件是真相** | 每条记忆是带 `frontmatter` 的 Markdown，`git` 只是可选账本，`rebuild-index` 随时重建 | `brains/{id}/sources/**` + `content_hash` |
| **三路混合检索** | BM25（GIN 物化 + 清洗 + 长度归一 + 短语） + 向量（Float32 视图 + max-pool）+ 图谱（10 种 typed edges）→ `RRF*(k+1) + cosine + signals + hotness` | `retrieve/hybrid`  `k=60 α=0.15` |
| **图谱建≡检索** | `决定/产出/属于/投资/顾问` 等 10 动词，`who decided/invested` 均走 `relational` 臂 | `graph/link-extraction` + `retrieve/graph` |
| **History 正排** | 全量对话不进索引，`note` 侧车 `history_index.jsonl` 存 `turn_index`，`read --with-history` 按需回跳 | `inbox/sessions/*/messages.jsonl` |
| **真矛盾** | 实体桶 `k=5` + `≥0.95` 直判 + `值冲突/否定` 二筛 + 灰区 `0.92-0.95` 批量 `LLM triage`，人审后 `superseded *0` | `dream/runner` + `contradiction/review` |
| **经验沉淀** | 热路径 `ADD-only`，`distill` 只写 `experiences/`，成熟结晶 `SKILL.md`，`forget` 默认软归档 | `distill/*` + `crystallize` |

## 快速开始

```bash
# 1. 装依赖
bun install

# 2. 初始化一个记忆仓（PGLite 零配置）
bun run memory -- init ./demo
cd demo

# 3. 写一条决策，立刻可查
bun run memory -- capture --wait --title "重试策略" --type decision --body "支付网关超时 5s，固定重试 3 次"
bun run memory -- query "重试" --explain --json

# 4. 会话自动记（配 LLM Key 后）
# DSH 插件接入后：用户/助手正文自动进 inbox，达窗异步 compile，命中时注入
```

## 日常使用

```bash
# 会话编译与 History 回跳
bun run memory -- remember --wait --body "我们在会上决定……"
bun run memory -- read "brains/default/sources/default/issues/general/decisions/1-重试策略.md" --with-history
bun run memory -- history read --session <id> --turn 2

# 检索与合成
bun run memory -- query "重试" --explain
bun run memory -- think "当前最大的风险是什么" --json
bun run memory -- graph-query "谁投资了 Acme"

# 矛盾与维护
bun run memory -- contradiction list --json
bun run memory -- contradiction resolve <pair_id> --keep a --json
bun run memory -- rebuild-index
bun run memory -- rebuild-index --pending-embeddings
bun run memory -- sync --commit
bun run memory -- job status <task_id> --json
bun run memory -- config list --json
bun run memory -- config doctor --json
```

<details>
<summary><code>memory.yml</code> 配置（可不配）</summary>

```yaml
brain_id: default
git: { mode: batch, batch_size: 20, batch_interval_ms: 300000 }
llm: { provider: off }          # off | openai
embedding: { provider: openai } # openai | onnx | local | off  # 无 Key 自动降级 local 哈希
search:
  fusion: { per_arm_min: 0.70, fused_min: 0.05, cosine_lambda: 0.3 }
  hotness: { enabled: true, half_life_days: 30, alpha: 0.15 }
```

</details>

## 架构

```
人/ agent ──► CLI / DSH 插件 ──► WriteQueue(单写者锁) ──► md 文件（真相）─┬─► PGLite 索引（BM25+向量+图，可丢）
                                                      │                └─► git 批量账本
                                                      └─► inbox → compile → L0 → dream → experiences/skills
读： hybrid（BM25 + 向量 + 图 + entity boost）→ RRF*rescale → cosine → signals → hotness(freq×recency) → L0/L1
```

详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`specs/十三期/README.md`](specs/十三期/README.md)。

## 与其他方案对比

| 维度 | df-memory | Mem0 | GBrain |
|---|---|---|---|
| 存储 | Markdown 文件是真相 | DB 为主 | Markdown + DB 双写 |
| 部署 | 单机 PGLite 零配置 | 云/自托管 | PGLite / Postgres |
| 检索 | 三路 RRF + 图 + hotness | 向量+BM25+entity | 向量+BM25+图+综合回答 |
| 写入 | ADD-only + 蒸馏经验 | 单遍 ADD-only | 事务 + 事实表 |
| 成本 | 无 Key 可跑，`local` 降级 | 需 LLM | 需 LLM |

## 测试与评测

```bash
bun run test              # 全量回归（含真实 git + PGLite）
bun run test:isolation    # 多 brain/source 隔离
bun run typecheck
bun run eval:mini         # 检索 12 条 + 隔离
bun run eval:distill
bun run eval:report
```

十三期 **P13.1-5 done**（`p131 4/4`、`p132 3/3`、`p133 3/3`、`p134 3/3`、`p135 3/3`），十二期 `P12.1-3 done`，`#9 HNSW` 未编码。详见 [`AGENTS.md`](AGENTS.md) 与 [`TODO.md`](TODO.md)。

## 贡献

欢迎 Issue / 想法 / PR。

1. 开 Issue 讨论 → 2. Fork → 3. 按 `AGENTS.md` 约束开发（先改 Spec 再改码，`bun:test` 覆盖 `Given/When/Then`）→ 4. PR 附测试。

## 许可证

MIT（`LICENSE`）
