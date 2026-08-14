# 澄清

产品链路挂在 **`remember`**（`compileSession`），不是 `capture`。

1. agent 对话原文进 inbox 缓存；达到 buffer 上限 / 退出 / 手动存储 → `remember` 编成 `sources/` 里带 schema 的 L0（decision / lesson / note）。未蒸 L0 够数则懒蒸馏成 experience；compile 时自动提 entity 并建 links（模型提议 + 代码写文件/挂 `@slug`）。经验成熟则自动结晶 **candidate** skill。写入走增量索引，不是每次 `rebuild-index`。
2. 查找：索引 + BM25 + 向量 + graph，RRF 融合后给模型。
3. 知识不够：模型再 `read` 原文（无自动闭环）。

## 已定（七期要做）

### 1. `remember` 还要不要单写者队列？

**要，但只锁落盘。**

- 每轮推进 inbox、调模型：不加 `write.lock`（inbox 不进 git/检索）。
- 窗口满了真正写成 L0 / entity 文件：仍走单写者队列，**一场 compile 一次** `execute`（多条 md 同一把锁），然后增量索引 + dirty。
- 后面的懒蒸馏、结晶是 **放锁之后** 另一次（或几次）队列任务，不塞进 compile 那一 lock。

### 2. 蒸馏经验何时？

**不在 `remember` 写 L0 的那把锁里蒸**（LLM 太慢，堵住写入）。

时机：

1. `compile` 成功、锁已放 → 数未蒸 L0；`≥ distill.lazy_min_sources`（默认 5）则本进程懒蒸馏。
2. 人手 `memory refine` / `dream --phases 3` 仍可随时跑。
3. 只 append 进 inbox、还没 compile：不蒸。
4. `capture` 不自动蒸（那条不是会话链路）。

已蒸过的源跳过（懒）。`lazy_min_sources≤0` 关闭自动，只留手动 refine。

### 3. entity 和图何时建？

**`remember` compile 落盘时，和 L0 同一把写锁。**

1. 模型在提取 JSON 里可选带 `entities`（slug/title/别名）。
2. 代码校验 slug → 写 `entities/*.md`（已有则只补别名）→ `linkifyBody` 把正文里的名字打成 `@slug`。
3. 索引 hook 从 `@slug` / wikilink / markdown 链抽边，写入 `links` 表。检索时 BM25/向量/图邻接 RRF。

人手 `capture`：只给**已经存在**的实体挂链，不调模型新建。查询时不建图，只用已有边。

### 4. 自动结晶 skill（七期 P7.2）

P3.2 成熟公式不变（`eta≥0.7` 且 `support≥2` 且无反例）。  
懒蒸馏或手动 refine **之后**，对够熟的经验簇自动写 `skills/.../SKILL.md`，状态 **candidate**，**不**自动 activate。已有同名 skill 跳过。`provider=off` 不自动结晶（避免启发式刷 skill）。人手 `skill crystallize` / `skill activate` 仍可用。

### 5. 每轮对话进缓存 — 先不做，别忘了

产品要：agent **每一轮**用户/助手话都 `append` 进 inbox（P7.3 的窗口 API）。  
七期只做 CLI：`remember --buffer` / `--end`。  
**不**做 Cursor hook、不做「对话系统自动每轮调用」。接入层以后再说。见 [`specs/七期/README.md`](specs/七期/README.md)「以后再说」。
