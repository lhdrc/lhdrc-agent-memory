# 十期 Specs — LoCoMo 发数 + 图谱密度 + 矛盾可见 + 检索可观测

> **前提**：九期 **P9.1–P9.9 done**。P5.6 hermetic 门禁（`eval:mini` / `eval:distill` / locomo **fixture**）保持，不进 P10.2–P10.4 改语义。  
> **来源**：P10.1 来自 2026-08-18 会话锁定（LoCoMo 发数）；P10.2–P10.4 来自 [`TODO.md`](../../TODO.md) 下期表（2026-08-20 用户锁定 **#9 pgvector/HNSW 本期不做**）。  
> **原则**：公开数字走 CLI `evals/` 直调 core；**不**用 DSH 插件刷分。写入必须 `compileSession`，禁止 transcript dump。CI 默认无网。P10.2–P10.4 不破坏 D1/D14/D17/D18；与 08 冲突时先改本目录 + 08 ADR 再改代码。  
> **明确不做（本期）**：postgres 真 `vector` 列 / HNSW（#9）；MCP/REST；npm publish；query LLM 扩写（#31）；compiled_truth；dream 九段；`link_kind` 列；按 page-type 绑默认边；第二份 schema pack；LongMemEval（TODO #35 其余项仍下期再问）。

## 0. 拆分

| 项 | 去向 |
|---|---|
| LoCoMo 发数协议 + 评测前检查单 + runner | **P10.1** |
| 图谱规则密度 (#8) | **P10.2** **done** |
| pgvector HNSW (#9) | **不做** |
| 矛盾分类 B (#17) | **P10.3** **done** |
| query log + explain (#22+#32) | **P10.4** **done** |
| 把 `eval` 做成 DSH 工具 | **不做**（P4.2 非目标） |
| 改 `eval:mini` / locomo `--fixture` 子串口径 | **不做**（P5.6 门禁） |

### 0.1 P10.2–P10.4 必须遵守的裁剪

1. **#9 禁止顺手做**（含改 `chunks.embedding` 列类型）。  
2. **#17 禁止 C**：不做 LLM 三分类 duplicate/supersede/independent，不自动改检索分。  
3. pack 仍仅 `problem-tree`；动词扩展走 YAML `extra_verbs`，不新开 pack。  
4. 不做 `link_kind`、不做批量 jsonb 写入图边。  
5. 可观测不改变默认检索排序（P10.4 只记、只展示）。

## 1. 产品承诺

**P10.1（LoCoMo 发数）**：能按业界 J-score 协议跑全量 `locomo10.json`，receipt 含准确率 / token / 延迟 / pin，数字可写进报告。

**P10.2–P10.4（主线，已 done）**：

```
写入正文含「任职 / founded」等 → 抽到 typed 边（零 LLM）
graph-query / 邻接臂            → 停用词种子不乱扩；恶意长正则不炸
dream 第 4 段                   → 跨文件近似 facts 写入 contradictions.md（不删 L0）
memory query --explain --json   → 看得到步骤、目录、每条分从哪来
memory observer --json          → 有延迟、三臂命中占比
```

## 2. 实现顺序

**P10.1**：评测前检查单（[`P10.1-locomo-publish.md`](P10.1-locomo-publish.md) §4）必须按 G0→G6 过完，才允许全量跑、才允许把数字写进 README / 对外稿。G0 是代码交付；G1–G6 是发数前操作门闩。

**P10.2–P10.4**：

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P10.2 图谱 | [`P10.2-graph-verbs.md`](P10.2-graph-verbs.md) | P3.1、P7.4 | 扩动词 + extra_verbs + 种子门控 + 查询防御 + 夹具 |
| 2 | P10.3 矛盾 | [`P10.3-contradictions.md`](P10.3-contradictions.md) | P3.2、P5.1、P9.2 | 跨文件 cosine；只写 contradictions.md |
| 3 | P10.4 可观测 | [`P10.4-query-observe.md`](P10.4-query-observe.md) | P3.1、P9.3 | query log + explain 分母级字段 |

P10.2 与 P10.4 可并行。P10.3 不依赖 P10.2。

## 2.1 进度

| Spec | 状态 |
|---|---|
| P10.1 LoCoMo 发数 | **in_progress**（G0 runner + P101 测例绿；全量发数待 G1–G6） |
| P10.2 图谱 | **done** |
| P10.3 矛盾 B | **done** |
| P10.4 可观测 | **done** |
| #9 HNSW | **不做** |

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| adapter / publish runner / prompts / receipt | 本仓 `evals/` + CLI `memory eval` |
| 评测仓 `memory.yml` 覆盖（openai + 关蒸馏） | 评测脚本写临时仓，不改用户仓默认 |
| 抽链 / 图臂 / dream contradictions / query log / explain | 本仓 `packages/core` + CLI |
| DSH 插件 | **不改**（P10.4 字段若 JSON 多出来，插件忽略即可） |
| postgres 向量列 | **不改** |

## 4. 验收总则

- Given/When/Then 一事一验；`bun test packages/core/tests/`。  
- 图与矛盾测例 **不得出网**；embedding 用 `local` 或 mock。  
- P10.3 在 `local` 哈希档：**跳过**跨文件 cosine（易误报），只跑同文件启发式。  
- P10.4 不得让无 `--explain` 的 query 变慢到改变现网测例期望（log 追加允许）。

## 十期完成标志

- **P10.1**：G0–G6 全绿 → LoCoMo 发数可对外。  
- **P10.2–P10.4**：DoD 勾选 → 主线切片完成（**不含** #9 / #35 / #17-C）。
