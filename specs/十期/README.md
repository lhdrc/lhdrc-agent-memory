# 十期 Specs — 图谱密度 + 矛盾可见 + 检索可观测

> **前提**：九期 **P9.1–P9.9 done**。  
> **来源**：[`TODO.md`](../../TODO.md) 下期表；2026-08-20 用户锁定：**#9 pgvector/HNSW 本期不做**；其余检索相关下期项拆成本目录 Spec。  
> **原则**：不破坏 D1/D14/D17/D18；与 08 冲突时先改本目录 + 08 ADR 再改代码。无 facts / event_ledger 索引表（#16 不做）。  
> **明确不做（本期）**：postgres 真 `vector` 列 / HNSW（#9）；MCP/REST；npm publish；query LLM 扩写（#31）；compiled_truth；dream 九段；`link_kind` 列；按 page-type 绑默认边；第二份 schema pack。  
> **编号**：P10.1 留给 LoCoMo 发数（TODO #35，不进本切片）。本切片从 **P10.2** 起。

## 0. 对 TODO 下期表的拆分（已锁定）

| TODO | 评估 | 十期去向 |
|---|---|---|
| **#8 图谱规则密度** | 结构已有（四 pass + 图臂 + signals），缺词表、种子门控、查询防御、关系夹具。 | **P10.2** |
| **#9 pgvector HNSW** | 大库加速。用户 2026-08-20：**本期不做**。 | **不做** |
| **#17 矛盾分类** | 范围未锁 A/B/C。禁止按 08 全套 C 开工。用户要求拆 Spec：**锁 B**（跨文件 cosine；同文件启发式保留；不改 hybrid 排名；无 LLM 三分类）。 | **P10.3** |
| **#22 + #32** | 同一套 query log。observer 看整体；`--explain` 看单次。 | **P10.4** |
| #20+#37 / #29 / #34 / #35 | 非本次「检索相关」切片。 | **不进本期** |

### 0.1 必须遵守的裁剪

1. **#9 禁止顺手做**（含改 `chunks.embedding` 列类型）。  
2. **#17 禁止 C**：不做 LLM 三分类 duplicate/supersede/independent，不自动改检索分。  
3. pack 仍仅 `problem-tree`；动词扩展走 YAML `extra_verbs`，不新开 pack。  
4. 不做 `link_kind`、不做批量 jsonb 写入图边。  
5. 可观测不改变默认检索排序（P10.4 只记、只展示）。

## 1. 产品承诺

```
写入正文含「任职 / founded」等 → 抽到 typed 边（零 LLM）
graph-query / 邻接臂            → 停用词种子不乱扩；恶意长正则不炸
dream 第 4 段                   → 跨文件近似 facts 写入 contradictions.md（不删 L0）
memory query --explain --json   → 看得到步骤、目录、每条分从哪来
memory observer --json          → 有延迟、三臂命中占比
```

## 2. 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P10.2 图谱 | [`P10.2-graph-verbs.md`](P10.2-graph-verbs.md) | P3.1、P7.4 | 扩动词 + extra_verbs + 种子门控 + 查询防御 + 夹具 |
| 2 | P10.3 矛盾 | [`P10.3-contradictions.md`](P10.3-contradictions.md) | P3.2、P5.1、P9.2 | 跨文件 cosine；只写 contradictions.md |
| 3 | P10.4 可观测 | [`P10.4-query-observe.md`](P10.4-query-observe.md) | P3.1、P9.3 | query log + explain 分母级字段 |

P10.2 与 P10.4 可并行。P10.3 不依赖 P10.2。

## 2.1 进度（2026-08-20）

| Spec | 状态 |
|---|---|
| P10.2 图谱 | **done** |
| P10.3 矛盾 B | **done** |
| P10.4 可观测 | **done** |
| #9 HNSW | **不做** |

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| 抽链 / 图臂 / dream contradictions / query log / explain | 本仓 `packages/core` + CLI |
| DSH 插件 | **不改**（P10.4 字段若 JSON 多出来，插件忽略即可） |
| postgres 向量列 | **不改** |

## 4. 验收总则

- Given/When/Then 一事一验；`bun test packages/core/tests/`。  
- 图与矛盾测例 **不得出网**；embedding 用 `local` 或 mock。  
- P10.3 在 `local` 哈希档：**跳过**跨文件 cosine（易误报），只跑同文件启发式。  
- P10.4 不得让无 `--explain` 的 query 变慢到改变现网测例期望（log 追加允许）。

## 十期完成标志

P10.2–P10.4 DoD 勾选 → 本切片完成（**不含** #9 / #35 / #17-C）。
