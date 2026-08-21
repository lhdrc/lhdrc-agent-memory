# 十一期 Specs — 范围选择 + 时间热度 + 变更可写 + 旧记忆让位

> **前提**：十期 **P10.2–P10.4 done**。P10.1 LoCoMo / P10.5 HaluMem 发数仍属十期，**不进本期 DoD**。P5.6 hermetic 门禁不改口径。  
> **来源**：[`TODO.md`](../../TODO.md) #44–#48（2026-08-21 会话）。OpenViking 选目录 / freq×recency；HaluMem Update 0/8 + topk=20 miss；P10.3 留「过期降权另开 Spec」。  
> **原则**：不破坏 D1/D14/**D17**/D18；与 08 冲突时先改本目录 + 08 ADR 再改代码。意图分类仍零 LLM。  
> **明确不做（本期）**：postgres HNSW（#9）；#17-C LLM 三分类；通用 `updateNode` 改 `sources/`；无回退的目录级联（#6）；LLM 意图分析 / HierarchicalRetriever 递归下钻；compiled_truth ×2（#18）；query LLM 扩写（#31）；MCP；npm publish；#20+#37 L0 memory_diff；#29 mask；LongMemEval 全量。

## 0. 对 TODO 的拆分（已锁定）

| TODO | 评估 | 十一期去向 |
|---|---|---|
| **#45 范围选择** | 意图只调权 → 噪声占满 top-k。必须带 fallback。 | **P11.1** |
| **#44 hotness freq** | 现网只有 mtime；OV 是访问次数 × 衰减。α=0.15 乘法不改。 | **P11.2** |
| **#46 duplicate≠update** | prefetch「已有」+ 余弦去重吞掉新值。L0 仍只增。 | **P11.3** |
| **#47 旧事实降权** | P10.3 文件已有，检索不认。只降权不删。 | **P11.4** |
| **#48 实体槽位** | 当前值投影放实体 facts patch；note 不 patch。 | **P11.5** |

### 0.1 必须遵守的裁剪

1. **D17**：`sources/` 热路径 ADD-only；禁止 merge 旧 note 正文。  
2. **#6**：窄范围 miss 必须扩全仓；禁止无回退级联。层 tie-break（P8.2 ±0.002）不改成层权重。  
3. **#17 禁止 C**：不在写入或 dream 跑 LLM duplicate/supersede/independent。  
4. **P9.3**：hotness 仍乘法、α 默认 0.15；旧标题全命中仍压过新无关文档。  
5. pack 仍仅 `problem-tree`；不新开「设计偏好」分类。  
6. 十期发数协议（LoCoMo J-score / HaluMem C.1/C.2）**不改**。

## 1. 产品承诺

```
query（scope_first） → 先按意图搜一块目录；不够再全仓；explain 看得见
think                → 经验题先搜 experiences/，不再先全仓再分桶
query 多次后         → 常被命中的 path 相对上浮（无计数时序不变）
「搬去旧金山」       → 新 L0 必须落下，不能被旧「住纽约」余弦跳过
dream 过的矛盾对     → 较旧那篇仍可召回，但排在较新之后
人的当前职位/住址    → 写在实体 facts 上可 patch；sources/ 仍是历史
```

## 2. 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P11.3 变更可写 | [`P11.3-update-write.md`](P11.3-update-write.md) | P5.1、P6.6 | 无新材料则后三项救不了 Update |
| 2 | P11.1 范围选择 | [`P11.1-scope-route.md`](P11.1-scope-route.md) | P3.1、P10.4 | 意图改搜索空间 |
| 3 | P11.2 hotness freq | [`P11.2-hotness-freq.md`](P11.2-hotness-freq.md) | P9.3、P10.4 | 终榜 path 计数 × 衰减 |
| 4 | P11.4 旧事实降权 | [`P11.4-stale-demote.md`](P11.4-stale-demote.md) | P10.3、P9.3 | contradictions 较旧侧乘子 |
| 5 | P11.5 实体槽位 | [`P11.5-entity-slot.md`](P11.5-entity-slot.md) | P5.4、P9.9 | 实体 facts patch |

P11.1 与 P11.2 可并行（都在 hybrid 尾段，测例勿互相绑死默认）。P11.4 依赖 dream 已能写出跨文件行。P11.3 不依赖检索项。

## 2.1 进度

| Spec | 状态 |
|---|---|
| P11.1 范围选择 | **ready** |
| P11.2 hotness freq | **ready** |
| P11.3 变更可写 | **ready** |
| P11.4 旧事实降权 | **ready** |
| P11.5 实体槽位 | **ready** |

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| intent→path、hotness、dedupe、contradiction 乘子、entity facts | 本仓 `packages/core` + CLI |
| 提取合同文案 | 本仓 `packages/core/resources/session-extract-v1.md` |
| query log / counter | `.dfmemory/logs/` |
| DSH 插件 | **默认不改行为**；新 explain 字段忽略即可。`scope_first` 由仓 `memory.yml` 决定 |
| 评测 adapter | **不改** P10.1/P10.5 协议；可用十一期检索/写入吃回归 |

## 4. 验收总则

- Given/When/Then 一事一验；`bun test packages/core/tests/`。  
- 检索/去重测例 **不得出网**；embedding `local` 或 mock。  
- P9.3 / P10.3 / P8.2 回归必须仍绿。  
- 无 `--explain` 的 query 不得无故变慢到改现网期望（log/counter 追加允许）。

## 十一期完成标志

P11.1–P11.5 DoD 勾选。**不含** HaluMem/LoCoMo 全量发数、不含 #17-C、不含 L0 覆盖写。
