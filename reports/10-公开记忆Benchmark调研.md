# 公开记忆 Benchmark 选型调研

> 调研对象：df-memory（本仓）对外/对内评测应采用哪些**公开**基准  
> 调研日期：2026-08-15 ｜ 语言：中文  
> 前提：P5.6 已落地 hermetic `eval:mini` / `eval:distill` / LoCoMo **仓内 fixture**；全量仅 `fetch --allow-net`。  
> 本文不替代 P5.6 门禁，只回答：**若要测评本项目，该选哪些公开 bench、为什么、先跑什么。**

---

## 0. 结论先行（建议组合）

**先跑能对标、后跑能打脸、永远不要用长上下文分数冒充记忆分数。**

| 优先级 | 基准 | 建议 | 一句话理由 |
|---|---|---|---|
| **P0** | **LoCoMo**（全量 QA） | **必跑** | 2024–2026 记忆系统对外数字的入口；本仓已有 adapter + pin URL |
| **P0** | **LongMemEval_S**（cleaned） | **必跑** | 补 LoCoMo 没有的 **知识更新** 与 **拒答（abstention）**；P5.6 已点名未实现 |
| **P1** | **HaluMem-Medium** | **应跑** | 按「提取 / 更新 / 问答」拆幻觉，对齐本仓 compile + D14，不只测检索 |
| **P1** | 本仓 `eval:mini` + `eval:distill` + isolation | **保持并强化** | 公开 bench **测不到** 多 brain 隔离、蒸馏有效性、中文检索 |
| **P2** | LongMemEval_M 或 **BEAM-128K/1M** | 规模压力后再跑 | 证明「分层 + 混合检索」不是塞 1M 上下文；10M 档不要当第一数字 |
| **P2** | MemoryAgentBench（FactConsolidation / EventQA） | 可选 | 冲突消解、时间线，对齐 distill / entity |
| **不做主数字** | NIAH / RULER / LongBench / InfiniteBench / BABILong | **禁止当记忆分** | 测的是单次注意力，不是跨会话写→存→取 |
| **暂缓** | PersonaMem / PrefEval / τ²-bench / SkillsBench | 产品主张对齐后再说 | 本仓主线是知识仓 + skill 查找，不是画像/客服工具 agent |

对外报分时**必须同表给出**：准确率、**每问注入 token**、延迟、judge 模型、数据 pin。只报准确率会重蹈竞品「同分不可比」的坑（见 [`05-四项目对比总结.md`](05-四项目对比总结.md) §数据提醒）。

---

## 1. 本项目实际要测什么

公开 bench 必须映射到 **df-memory 已承诺的能力**，而不是「业界有榜就上」。

| 本仓能力 | 对应失败模式 | 公开 bench 能否覆盖 |
|---|---|---|
| 会话写入 inbox → `compileSession`（decision/lesson/note） | 该记的没抽出 / 抽出幻觉 | **弱**（多数只评最终 QA）；HaluMem 相对最贴 |
| 混合检索（BM25 + 语义 + 图）+ RRF | 召不回 / 召回错层 | LoCoMo / LongMemEval / BEAM 的 QA 面 |
| 分层 L0/L1/L2、token 预算 | 分数靠灌上下文刷高 | **必须自报 token**；MemBench/BEAM 部分触及效率 |
| 蒸馏 experience / skill | 有经验不比没经验强 | **几乎没有**；继续靠 `eval:distill` |
| 知识更新 / 遗忘 | 过期事实仍被当真理 | LongMemEval KU、BEAM KU/CR、HaluMem update |
| 拒答 | 没有的事编出来 | LongMemEval abstention、BEAM ABS |
| 多 brain 隔离 | 租户泄漏 | **公开 bench 全无**；靠 isolation fuzz |
| 中文检索 / 中文 compile | 英文榜虚高 | **公开 conversational memory 几乎全英文** |
| skill 按需注入（P8.3） | skill 混进默认 query | 无对口公开榜；SkillsBench 偏宿主 skill 不是本仓结晶 |

因此：**公开数字用来和 Mem0 / MemOS / GBrain / OpenViking 对话；产品回归仍以仓内 hermetic 为准。**

---

## 2. 先分清两类评测（选错就全错）

2026 年业界已基本接受（Mem0《AI Memory Benchmarks 2026》、BEAM 论文）：

| | **记忆基准** | **长上下文基准** |
|---|---|---|
| 输入 | 多会话流：先写入外部存储，再在后续轮次检索 | 一次塞进 100K–10M token，当场答题 |
| 失败点 | 抽错、存错、取错、更新失败、串用户 | 注意力落错 span |
| 代表 | LoCoMo、LongMemEval、BEAM、HaluMem | NIAH、RULER、LongBench、InfiniteBench、BABILong |
| 对本仓 | **要对的** | 只说明「底层模型能不能读长文」，**不能**证明记忆模块有用 |

本仓 ADR 是「文件是真相、热路径不灌整场 transcript」。用 NIAH/RULER 当主分，等于用别人的上下文窗口给自己贴金。

一条可用的检验句：**「状态在第 50 轮是否依赖于第 1–49 轮写进了仓里的东西？」** 是 → 记忆 bench；否 → 长上下文 bench。

---

## 3. 候选清单（2024–2026 公开面）

### 3.1 行业对标三件套

#### LoCoMo（2024，Snap Research）

- **论文**：Maharana et al., *Evaluating Very Long-Term Conversational Memory of LLM Agents*  
- **数据**：约 50 段对话；每段约 300 轮 / 9K token / 最多 35 session；QA 约 **1540** 题（single-hop / multi-hop / temporal / open-domain；另有摘要、多模态，业界几乎只报 QA）  
- **仓库**：[snap-research/locomo](https://github.com/snap-research/locomo)；本仓 pin：`data/locomo10.json`（见 `evals/fetch.ts`）  
- **优点**：引用最多；协议成熟；体量小、可在本仓现有 `EvalAdapter` 上跑全量；已有 fixture 子集  
- **缺点**：按 2026 标准偏短；**不显式测知识更新**；头部系统已接近饱和（Mem0 宣称 ~92，MemOS ~89——**口径不同，不可直接比**）  
- **对本仓**：P0。用来回答「我们是不是记忆系统」，不是用来证明「我们比别人强」。

#### LongMemEval（2024/25，Wu et al.）

- **论文**：arXiv:2410.10813；代码 MIT；数据建议用 **cleaned**：[xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)  
- **规模**：500 题；**S** ≈ 115K token / ~40 session；**M** ≈ 500 session；另有 oracle（只含证据 session）  
- **能力**：信息抽取、跨 session 推理、时间推理、**知识更新**、**拒答**  
- **优点**：比 LoCoMo 更像「助手记忆」；abstention 能打幻觉；S 档成本可接受；P5.6 已预留 adapter 位  
- **缺点**：官方 QA 常用 GPT-4o judge（要锁模型与 prompt）；历史 session 来自 ShareGPT/UltraChat 拼接，叙事连贯性弱于 BEAM；**英文**  
- **对本仓**：P0 跑 **S + cleaned**。M 档放到 P2（证明索引/分层在「塞不下」时仍工作）。

#### BEAM（ICLR 2026，Tavakoli et al.）

- **论文**：arXiv:2510.27246；代码 MIT；数据 **CC BY-SA 4.0**；[mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM)  
- **规模**：100 段连贯多领域对话；长度 128K / 500K / 1M / 10M；**2000** 题；**十项**能力（抽取、多跳、更新、时间、拒答、矛盾、事件序、指令、偏好、摘要）  
- **优点**：2026 新标尺；明确证明「1M 窗口 ≠ 长期记忆」；能力面最全；Mem0/MemOS 已开始报 1M/10M  
- **缺点**：算力与 token 成本高；容易滑成长上下文军备；ShareAlike 对衍生评测脚本有传染风险（适配器注意不要把改写数据再闭源发布）  
- **对本仓**：P2。若要对外说「我们不是靠长窗口」，先报 **128K 或 1M**，不要一上来 10M。

### 3.2 写路径 / 幻觉（对本仓更「疼」）

#### HaluMem（2025，MemTensor / IAAR）

- **论文**：arXiv:2511.03506；数据：[IAAR-Shanghai/HaluMem](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem)  
- **规模**：Medium ≈ 160K token/用户、~3467 QA；Long ≈ 1M + 干扰项；按 **提取 / 更新 / 问答** 三级打幻觉  
- **已评系统**：Mem0、MemOS、Zep、Supermemory 等  
- **优点**：公开 bench 里少有真正打 **写入** 的；对齐 `compileSession` / remember、D14「不靠模型自觉」  
- **缺点**：较新，引用面小于三件套；Long 档贵  
- **对本仓**：P1 先 **Medium**。这是最能暴露「启发式冒充 compile / 无 Key 乱写 L0」的公开集。

### 3.3 补充（按主张选用）

| 基准 | 年份 | 测什么 | 对本仓 |
|---|---|---|---|
| **MemoryAgentBench** | 2025 | 增量多轮：精确检索、冲突消解、长程理解、test-time learning | P2：优先 FactConsolidation / EventQA；ICL 系列与记忆模块无关 |
| **MemBench**（ACL 2025 Findings） | 2025 | 参与/观察 × 事实/反思；准确率+效率+容量 | 可参考其**效率指标**；引用与复现生态弱于三件套 |
| **PersonaMem** | 2025 | 演化用户画像、个性化回复 | 暂缓：本仓不是画像系统 |
| **PrefEval** | — | 偏好是否被遵守 | 暂缓：无「偏好记忆」产品承诺 |
| **τ²-bench / tau2** | 2024– | 工具 agent 任务成功率 | 暂缓：测的是宿主 agent，不是记忆仓；OpenViking 用它讲「有记忆的 bot」 |
| **SkillsBench** | — | 宿主 skill 调用 | P8.3 注入落地后再评估，不要和 `memory_query` 混报 |
| **Locomo-Plus / LongMemEval-V2** | 2026 前后 | 认知记忆 / Web-agent 记忆 | **观察**，尚未形成对标惯性，不替换 P0 |

### 3.4 明确不要当记忆主分

NIAH、RULER、InfiniteBench、LongBench v1/v2、BABILong、HotpotQA（作为「记忆榜」）、以及把 **OmniMemEval** 当成数据集本身（它是 MemOS 的评测框架，底下仍是 LoCoMo/LME 等）。

---

## 4. 竞品在跑什么（用来校准「别人听得懂的数字」）

来源：本仓 `reports/01`–`05` 与 2026-08 公开博客/README（数字**营销属性大于可比性**）。

| 项目 | 对外主报 | 附带 |
|---|---|---|
| Mem0 | LoCoMo、LongMemEval、BEAM 1M/10M | 强调 token/query 与延迟；OSS vs Platform 口径不同 |
| MemOS | 同上 + OmniMemEval 包装 | 另有 PrefEval / PersonaMem / HaluMem 脚本 |
| GBrain | LongMemEval-S + 自建 BrainBench | 强调 pin commit、receipt、不碰用户 brain |
| OpenViking | LoCoMo + τ² | 强调相对「无记忆」的提升与 token 下降 |

**启示**：要进入同一对话，至少要有 **LoCoMo + LongMemEval**。要显得诚实，必须学 GBrain/Mem0：**pin、receipt、token、声明未测项**。

---

## 5. 建议落地顺序（对齐本仓工程习惯）

与 P5.6 一致：默认无网；全量 `fetch --allow-net`；adapter 禁止空 stub。

| 阶段 | 做什么 | 验收 |
|---|---|---|
| **已有** | `eval:mini` / `distill` / locomo fixture | 保持 CI 门禁 |
| **下一刀** | LongMemEval **adapter + 仓内 3–5 条 fixture**；全量 pin cleaned `_s` | `memory eval --adapter longmemeval --fixture` 无网绿 |
| **对外第一份数** | LoCoMo 全量 QA + LongMemEval_S；同一 judge；写 receipt | 报告含 accuracy / tokens / latency / pin |
| **写路径** | HaluMem-Medium 适配（提取/更新分项） | 无 Key 路径不得靠「写进 sources 再检索」刷分 |
| **规模** | LME_M 或 BEAM-128K/1M | 证明分层检索；10M 可选、不阻塞 |
| **产品缺口** | 自建 **中文** LoCoMo 形 fixture（10–30 QA） | 公开英文榜之外的回归 |

摄入协议（硬，与 ADR / 八期锁定一致）：

1. 对话进 `.dfmemory/inbox/`，经 `appendSessionTurns` / `compileSession` / `remember`，**禁止**把整场 transcript dump 进 `brains/*/sources/`。  
2. 无 Key → `E_DISABLED`，该 case 记失败，**不算**「记忆系统分」。  
3. 检索用现网 `hybridQuery`（可 `excludeSchemaTypes: ["skill"]`），不要为刷分换一套检索。  
4. Judge 锁模型与 prompt hash，写入 receipt（学 GBrain）。

---

## 6. 公开基准仍然测不到的东西

选对 bench 也不会自动证明产品完整。下列必须继续用**仓内评测**，不要假装公开集已经覆盖：

1. **多租户隔离**（`brain_id` / shared skill ACL）  
2. **蒸馏是否真的让代理更好**（`eval:distill`）  
3. **中文**（分词、query 门控、提取合同）  
4. **写入选择性**（该丢的闲聊不进 L0）——HaluMem 只覆盖一部分  
5. **skill 不混默认 query、按需注入**（P8.2/P8.3）  
6. **成本熔断 / 懒蒸默认值**对延迟的影响  

---

## 7. 推荐决策（可直接执行）

1. **对外主数字 = LoCoMo QA + LongMemEval_S（cleaned）**，附 token 与延迟。  
2. **对内质量数字 = HaluMem-Medium 的提取/更新分 + 现有 distill/mini**。  
3. **规模数字（可选）= BEAM-1M 或 LongMemEval_M**，用来反驳「你们不就是 RAG + 长窗口」。  
4. **不要**用 LongBench/RULER 发记忆新闻稿。  
5. **不要**和 Mem0 92.5 / MemOS 88.83 做无协议对比。  
6. 中文与隔离继续自建；等出现可 pin 的公开中文记忆集再加 adapter。

---

## 8. 主要出处

| 资源 | 用途 |
|---|---|
| [snap-research/locomo](https://github.com/snap-research/locomo) | LoCoMo 数据与任务定义 |
| [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) / [longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | LME 协议与 cleaned 数据 |
| [mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) · arXiv:2510.27246 | 2026 规模与十能力面 |
| [IAAR-Shanghai/HaluMem](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem) · arXiv:2511.03506 | 操作级幻觉 |
| [HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) · arXiv:2507.05257 | 增量多轮 / 冲突 |
| MemBench, ACL 2025 Findings | 效率与观察场景（复现生态较弱） |
| Mem0, *AI Memory Benchmarks 2026*（2026-08） | 业界「三件套」叙事与长上下文辨析 |
| 本仓 [`specs/五期/P5.6-evals.md`](../specs/五期/P5.6-evals.md)、[`evals/README.md`](../evals/README.md)、[`reports/05-四项目对比总结.md`](05-四项目对比总结.md) | 已有评测面与竞品口径 |

> 许可以各上游仓库当时声明为准。落地 adapter 时在 `evals/adapters/README.md` 写 pin URL、许可、fixture vs full（P5.6 已有此纪律）。
