# AGENTS.md — df-memory

给在本仓库工作的 AI agent / 工程师的导航与约束。实现前先读完本文。

## 项目是什么

**df-memory**：开源、单机、本地部署的记忆模块——「agent 的 git + 知识库」。  
当前交付焦点：**九期编码中**——检索量纲 + 写入合同（[`specs/九期/`](specs/九期/)）；**P9.1–P9.5、P9.9 已 commit**；**P9.6–P9.8 工作区未关账**。八期 **P8.2–P8.5 done**，P8.1 测例全绿（仅 P81-17 真机 next 关账）。七期 **P7.1–P7.5 done**。四期：**P4.2 A** 已接线（未 npm publish）；**B 档迁 P8.1**；**P4.1 MCP/REST 不做**。**P6.5 Cursor 模板不做**。

> 口号里的「git」指版本化知识仓体验；**实现上热路径以 md 文件为权威**，git 为可选批量账本（08 **D1/D18**）。

## 文档层级（权威顺序）

| 优先级 | 路径 | 用途 |
|---|---|---|
| 1 | [`specs/mvp/`](specs/mvp/) | **实现规格**——按此编码与验收 |
| 2 | [`specs/二期/`](specs/二期/) · [`三期/`](specs/三期/) · [`五期/`](specs/五期/) · [`六期/`](specs/六期/) · [`七期/`](specs/七期/) · [`八期/`](specs/八期/) · [`九期/`](specs/九期/) · [`四期/`](specs/四期/) | 二–七期主线已做；**八期 P8.2–P8.5 done / P8.1 真机关账**；**九期 P9.1–P9.5、P9.9 done；P9.6–P9.8 未关账**；P6.5 Cursor 模板不做；P4.2 A 已接线；P4.1 MCP **不做** |
| 3 | [`reports/08-开源记忆模块设计方案.md`](reports/08-开源记忆模块设计方案.md) | 架构与 ADR；与 Spec 冲突时 **先改 Spec/ADR 再改代码** |
| 4 | [`reports/01`](reports/01-gbrain-调研报告.md)–[`05`](reports/05-四项目对比总结.md) | 调研背景，不直接当接口规格 |

入口索引：[`specs/README.md`](specs/README.md)。

## 当前状态与接下来做什么

**MVP（M1–M3 + D18）已落地**；**二期（P2.1a + P2.2）已落地**；**三期（P3.1–P3.3）已落地**；**五期主线已完成**；**P5.6–P5.8 增强轨已完成**；**六期主线已完成**（P6.1–P6.4 + P6.5 查询门控；**Cursor 模板不做**）；**P6.6 提取合同已完成**；**七期 P7.1–P7.5 已完成**：

| Spec | 能力摘要 | 状态 |
|---|---|---|
| P3.1–P3.3 | 图谱 / skill·dream / AccessControl | **done** |
| **P5.1** | L0 提取快路径：余弦去重 + 启发式/LLM facts | **done** |
| **P5.2** | 分层读写 abstract/overview | **done** |
| **P5.3** | 检索增强 tokenmax / 实体层 / hotness | **done** |
| **P5.4** | EventLedger / linkFacts / `--purge` | **done** |
| **P5.5** | `think`/`find`/`eval`；`agent_id` | **done** |
| **P5.6** | `eval:mini`/`distill`/`report`；LoCoMo fixture；receipt | **done** |
| **P5.7** | `IndexEngine`；`index.engine: postgres` + `DF_MEMORY_DATABASE_URL` | **done** |
| **P5.8** | `ingest`：generic-jsonl / df-app fixture；只经 captureNode | **done** |
| **P6.1–P6.4** | LLM `complete` / inbox / session compile / `remember` | **done** |
| **P6.5 门控** | `shouldQueryMemory` 打分（学 OV，不调 LLM） | **done** |
| **P6.5 模板** | Cursor hook + `/` | **不做**（搁置） |
| **P6.6** | 提取合同：三类型说明书 + prefetch 已有标题 + `source_turns` + JSON 修复 | **done** |
| **P7.1** | LLM 方法全部经 `complete()`；EnvMock 按 purpose | **done** |
| **P7.2** | refine / compile 后懒蒸 / 自动 candidate skill / eval:distill | **done** |
| **P7.3** | 滑动窗口摄入（攒 turns 再 compile） | **done** |
| **P7.4** | compile 建 entity + 统一 linkify + query 邻接 | **done** |
| **P7.5** | `inbox retry`；revert merge/skill/noop | **done** |
| **P8.1** | 会话挂钩 + remember 异步（统一 job；承接 P4.2 B） | **in_progress**（本仓 deferCompile/`bindOpen` + `job_timeout_ms` + init gitignore 绿；插件 P81-10–18 除真机 next 生效外全绿：15 串行、16 崩溃恢复、17 门控注入 fail-open、卸载 flush、超时不写 L0 均已补测） |
| **P8.2** | 检索分层标注 / 溯源 / 图臂 schemaType | **done**（P82-01–09 全绿：本仓 exclude + 图臂 type + `annotateHits` + tie-break；插件默认排除 + 标注透传 + prompt 策略） |
| **P8.3** | Skill 查找与按需注入（不混默认 query） | **done**（本仓 `findSkills` 绿；插件 `memory_skill` list/find/read/inject + 宿主 `ctx.skills.register` A 通道 + 预算/幂等/ACL + P83-10–17 绿） |
| **P8.4** | 提取粒度（note 合并同类；不破 P6.6） | **done**（P84-00–05：Granularity 合同 + 清单 fixture 合成一条 + 独立 decision 仍拆；P6.6 回归） |
| **P8.5** | 工具 per-call `brain` | **done**（P85-01–06 插件绿：query/remember/job 按 brain 隔离；非法/不存在拒绝；list 含 sources/`is_default`；本仓 `assertBrainScope`） |
| **P4.2** | DSH 插件化 A：core Node 兼容 + 三工具；B 迁 P8.1 | **in_progress**（A 本仓测例绿；未 npm publish） |
| **P4.1** | MCP / REST / Claude Code | **不做** |
| **P9.1** | content_hash 语义归一化 | **done**（已 commit；P91-01–05：时间戳不进 hash，语义变才重切块） |
| **P9.2** | embedding 三档（默认 openai；CI 用 local） | **done**（已 commit；P92-01–07：init openai；无 Key fail-open 哈希；onnx 缺权重不冒充成功） |
| **P9.3** | RRF rescale + floor + cosine re-score + hotness 乘法 | **done**（已 commit；P93-01–10：rrf'、floor、cosine、α=0.15 乘法；P82-08 EPS=0.002） |
| **P9.4** | source 解析 7 层 | **done**（已 commit；P94-01–09） |
| **P9.5** | facts 量纲 + `memory trend` | **done**（P95-01–07：可选 metric/value/unit/period；扫 md 趋势；无 facts 表） |
| **P9.6** | skill outcome + 启动注经验 | **in_progress**（本仓 `listBootExperiences` + `p96_outcome`；插件仓 `memory_skill_outcome` + session-start 注入。**两边均未 commit**） |
| **P9.7** | Iron Law back-link + `[Source:]` | **in_progress**（工作区：`applyIronLaw` 挂 captureWrite；实体 back-link 直写文件避嵌套锁。**未 commit**） |
| **P9.8** | 写路径默认异步（JobRunner 入 core） | **in_progress**（JobRunner 已迁 `packages/core/src/jobs/`；CLI `capture`/`remember`/`ingest session` 默认入队 + `--wait`；插件 `jobs.ts` 再导出 core。**P98 未全绿关账**，勿当 done） |
| **P9.9** | 蒸馏读 pack `merge_op` | **done**（已 commit；P99-01–05：append/patch/immutable；L0 仍 ADD-only） |

**未做 backlog：**

> 当前主线见 [`specs/九期/`](specs/九期/)。下期与裁剪见 [`TODO.md`](TODO.md) 文首表。

| 优先级 | 项 | 说明 |
|---|---|---|
| — | **九期关账** | **已 commit**：P9.1–P9.5、P9.9。**下一步**：P9.7 → P9.6（含插件仓）→ P9.8。 |
| — | **P9.8 阻塞** | P98-01–06、P98-08 与 P64 `--wait`（P98-07）已绿。待单独 commit。 |
| — | **八期关账** | P81-17 真机 `next` 当步生效待补验。 |
| P1 | **remember 无 Key → `E_DISABLED`** | 设计如此；escape：`remember --no-extract`。 |
| P1 | **schema pack 仅 problem-tree** | 明确裁剪。 |
| P1 | **embedding** | **P9.2**：init 默认 `openai`；CI `local` 哈希；`onnx` 真本地模型。无 Key 语义臂 fail-open。 |
| P2 | **import 默认不 enrich** | P5.1：仅当 `llm.extract` 或 `dedupe_cosine>0` 才 post-import enrich。 |

回归：`bun test packages/core/tests/`；隔离：`bun run test:isolation`；迷你评测：`bun run eval:mini`；蒸馏：`bun run eval:distill`；摘要：`bun run eval:report`。

1. 改行为前先读 / 更新对应 Spec（[`00-conventions.md`](specs/mvp/00-conventions.md) §8、M1/M2/M3、[`二期/`](specs/二期/)、[`三期/`](specs/三期/)、[`五期/`](specs/五期/)、[`六期/`](specs/六期/)、[`七期/`](specs/七期/)、[`八期/`](specs/八期/)、[`九期/`](specs/九期/)、[`四期/`](specs/四期/)）  
2. 写入校验以 [`WRITE_FORMAT.md`](specs/mvp/WRITE_FORMAT.md) 为准（含 experience §9、skill §10）  
3. **五–八期主线已完成（P8.1 真机 next 除外）**。**九期 P9.1–P9.5、P9.9 done；P9.6–P9.8 未关账**：见 [`specs/九期/`](specs/九期/)。会话摄入必须 `complete()`（无 Key → `E_DISABLED`）。**P6.5 Cursor 模板不做。** **P4.1 MCP 不做。**  
   原文先归档 `.dfmemory/inbox/`。人手 `capture` 仍可零 LLM。**HEAD 上 capture/remember 仍同步**；工作区 P9.8 已改默认入队，关账后口令加 `--wait` 或先 `job status`。  
4. 与 Spec 冲突时：**先改 Spec/08 ADR，再改代码**  
5. **不**扩 dream 夜间维护全集（v1 五段维持）  

### 八期实现锁定（P8.1 §3.1，写代码必遵）

- 挂钩只收 `user/message` 且 `source.kind ∈ {user, model}`，以及全部 `assistant/message`（模型正文**不截断**）。丢 `plugin` / `goal` / `tool` 与工具事件。  
- inbox id：挂钩用 `dfm-` + `sha256(dshSessionId).hex.slice(0,16)`；**禁止**回退 `.open`。  
- 达窗 compile 必须 `deferCompile: true` 后入队；CLI `--buffer` 默认仍同步。  
- 任务权威是 `.dfmemory/jobs/`（宿主 `JobRegistry` 无 enqueue，不阻塞）。  
- 结束：`agent/disposed` + `session/disposed` 按 session.id 去重。  
- 知识注入：优先 pre-step waterfall `next(messages)`；成功则不再 `agent.inject` 同一份。  
- skill 不混默认 `memory_query`（P8.3）；不从会话直接抽 `SKILL.md`。  
- 懒蒸默认 5→3 **不改**（仓配置即可）。  

分期速查：二期 = P2.1a+P2.2（**done**）；三期 = P3.1–P3.3（**done**）；**五期 = P5.1–P5.8（done）**；**六期 = P6.1–P6.4 + 查询门控 + P6.6（done；Cursor 模板不做）**；**七期 = P7.1–P7.5（done）**；**八期 = P8.2–P8.5 done，P8.1 真机 next 待补**；**九期 = P9.1–P9.5、P9.9 done；P9.6–P9.8 未关账**；四期 = **P4.2 A in_progress / B 迁 P8.1**；P4.1 MCP **不做**。

## 技术栈（已锁定）

- TypeScript strict + **Bun** workspaces  
- 权威存储：**md + frontmatter**（文件真相）  
- 版本账本：git **可选批量 flush**（默认 `git.mode: batch`）  
- 索引：**PGLite**（`.dfmemory/pglite/`，可丢可 `rebuild-index`）；可选 **Postgres**（`index.engine: postgres` + `DF_MEMORY_DATABASE_URL`，见 `scripts/dev-postgres.md`）  
- 包：`packages/core`、`packages/cli`（bin: `memory`）、`packages/adapters/*`（摄取插件，D9）；DSH 插件在并列仓 `dsh-df-memory/`（P4.2）  
- **不实现 Java**；默认 **不强制联网**（`embedding.provider` init 默认 `openai`；hermetic CI / 测例用 `local` 哈希；`llm.provider` 默认 `off`）  

### 热路径写事务（D18）

```
持锁 → 写 md → 索引 hook（onFilesWritten）→ 标记 dirty
  → force（merge/schema/purge，且 mode≠off）立即单独 commit
  → 否则 batch：N=20 ∨ T=5min（相对 lastFlushAt）∨ CLI 退出 flush ∨ sync --commit
```

| `git.mode` | 行为 |
|---|---|
| `batch` | **默认**：热路径不每写 commit |
| `off` | 永不自动/强制 commit；**仅** `memory sync --commit` |
| `per_write` | 兼容旧行为（调试用） |

关键实现：`packages/core/src/write/queue.ts`、`dirty.ts`、`flush.ts`、`flush-policy.ts`；CLI `sync` + 退出 flush 见 `packages/cli/src/main.ts`。

## 不可违背的 ADR（摘要）

完整表见 08 §0。落地时尤其遵守：

| ID | 硬约束 |
|---|---|
| D1 | 文件是真相；索引可丢，必须能 `rebuild-index` 恢复；git **不是**写路径必要条件 |
| D2 | brain 级内容只在 `brains/{brainId}/`；根目录不放租户记忆 |
| D13 | Entity **merge = 文件事务**（canonical + redirect + event）；禁止只改索引 |
| D14 | 所有写入走 `WRITE_FORMAT` 校验，不靠模型自觉 |
| D17 | L0 热路径 ADD-only；蒸馏（二期 P2.2）不删 `sources/`；forget 默认软归档 |
| D18 | 热路径不借 git；N/T/退出/`sync --commit` flush；merge/schema/purge 在 **mode≠off** 时强制即时、**单独** commit |

## 工程习惯

- 先改 Spec / 测试意图，再写代码；Given/When/Then 要有对应 `bun:test`  
- 错误码与路径规则跟 `00-conventions.md`  
- Schema 形状来自 pack YAML（默认 `problem-tree`），核心不硬编码 issue 路径语义  
- 不要把调研报告或 08 全文复制进代码注释；引用 Spec ID（如 `M2-11` / `P51-03`）即可  
- 验收口令与 CLI 面见 [`specs/mvp/README.md`](specs/mvp/README.md)、[`specs/五期/`](specs/五期/)  
- 每次完成阶段建设后更新AGENTS.md文档，同步进度和完成背景。  
- 对于简单的任务可以交给subagent做，subagent使用composer2.5 模型。  

常用命令：

```bash
bun run test
bun run test:isolation
bun run typecheck
bun run memory -- <cmd>
bun run eval:mini
bun run eval:distill
bun run eval:report
bun run test:postgres
```

### 本仓库 git 提交约束（硬）

**用户未明确要求时，禁止** `git commit` / `git push` / 改 git config / 跳过 hooks / force push / 危险 reset。

用户**明确要求提交**时，按下列顺序执行：

1. **并行**采集：`git status`（含未跟踪）、`git diff`（含 staged）、`git log`（近期风格）  
2. 起草简短 commit message（1–2 句，偏 why）；**不**把疑似密钥（`.env`、credentials 等）纳入提交  
3. **顺序**执行：`git add` 相关文件 → `git commit`（message 用 HEREDOC / 等价安全传参）→ `git status` 确认成功  
4. commit 被 hook 拒绝时：修好后打 **新** commit；**禁止**在失败后 `amend`  
5. **仅当**用户明确要求且同时满足时才 `amend`：本次会话自己造的 HEAD、未推远程、或 hook 自动改文件需补进同一提交  
6. **禁止** interactive rebase（`-i`）、`--no-verify` 等，除非用户明文要求  
7. **不** push，除非用户明文要求  

## 明确不要做

- 在 MVP/默认路径引入云向量库当索引；**hermetic CI 不得出网**（九期 init 默认 embedding=openai，测例必须 `local`/mock，见 P9.2）；**P4.1 MCP/REST 不做**；**P6.5 Cursor 模板不做**  
- 把整场 transcript dump 进 `brains/*/sources/` 当 L0；inbox 只允许 `.dfmemory/inbox/`  
- Entity merge 只 UPDATE PGLite  
- 用覆盖写破坏 ADD-only  
- 把 `experiences/`、`skills/` 建在 `brains/{id}/` 之外  
- 未获要求实现四期 P4.1（MCP/REST）或并行 Java 栈；**P4.2 A 按原 Spec 收口；B 档与异步/skill 注入按 [`specs/八期/`](specs/八期/) 做，不要顺手做 P4.1**  
- 修改本文件或 Spec 以「绕过」验收，除非用户要求修订规格  
- 在「索引 / flush 失败」时用 `git checkout` 抹掉已成功的权威 md  
- 把先验 dirty 与 force commit（如 merge）打进同一条 commit  
- 用户未要求时主动 `git commit` / `git push`  

## 常用验收口令（MVP + 三期摘录）

```bash
bun run memory -- init ./demo
cd demo
bun run memory -- capture --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试"
bun run memory -- query "重试" --explain
bun run memory -- graph-query "谁提到了支付"
bun run memory -- rebuild-index
bun run memory -- sync --commit
bun run memory -- entity create --slug alice --title "Alice"
bun run memory -- entity create --slug bob --title "Bob"
bun run memory -- entity merge alice bob --canonical alice --confirm
bun run memory -- entity resolve bob   # → alice
bun run memory -- brain create team-b
bun run memory -- brain list
bun run memory -- --brain team-b capture --title "B仓笔记" --type note --body "仅B可见"
bun run memory -- dream --phases 1,2
bun run memory -- observer --json
bun run memory -- layers refresh --dirs --json
bun run memory -- read <path> --layer l0 --json
bun run memory -- query "重试" --mode tokenmax --explain --json
bun run memory -- events list --json
bun run memory -- entity link-facts alice --fact "已签约" --json
bun run memory -- forget <path>
bun run memory -- forget <path> --purge --confirm
bun run memory -- find "重试" --json
bun run memory -- think "重试" --json
bun run memory -- eval --mini
bun run memory -- eval --distill
bun run memory -- eval --report
bun run memory -- eval --adapter locomo --fixture
bun run memory -- agent register --id bot --source default
bun run memory -- agent list --json
bun run memory -- ingest --list-adapters
bun run memory -- ingest --adapter generic-jsonl --input ./packages/adapters/ingest-generic-jsonl/fixtures/two-notes.jsonl --json
bun run memory -- ingest --adapter df-app --input ./packages/adapters/ingest-df-app/fixtures/sample-export.jsonl --json
bun run memory -- remember --body "我们决定重试改为固定3次" --json
bun run memory -- ingest --adapter session --input ./packages/adapters/ingest-session/fixtures/decision.jsonl --json
bun run memory -- inbox list --json
bun run memory -- inbox retry <sessionId> --json
bun run memory -- remember --buffer --body "先攒着" --json
bun run memory -- graph-query "随便写点" --json
bun run memory -- remember --help
```

九期口令见 [`specs/九期/`](specs/九期/)（P9.8 关账后 capture/remember/ingest session 加 `--wait`；另有 `memory trend` / `memory job status`）。  
五期口令见 [`specs/五期/`](specs/五期/) 各 Spec 验收节。  
六期口令见 [`specs/六期/`](specs/六期/)；会话摄入无 Key 时 `E_DISABLED`（CI 用 mock `complete`）。**P6.5 Cursor 模板不做。** 七期口令见 [`specs/七期/`](specs/七期/)（P7.1–P7.5 已做）。八期口令见 [`specs/八期/`](specs/八期/)（P8.2–P8.5 done；P8.1 真机 next 待补）。

细节见各 Spec 验收节与 [`specs/mvp/README.md`](specs/mvp/README.md)、[`specs/三期/README.md`](specs/三期/README.md)、[`specs/五期/README.md`](specs/五期/README.md)、[`specs/六期/README.md`](specs/六期/README.md)、[`specs/七期/README.md`](specs/七期/README.md)、[`specs/八期/README.md`](specs/八期/README.md)、[`specs/四期/README.md`](specs/四期/README.md)（P4.2 A）。

> **多租户提示**：单仓多 brain 时 git 历史对同仓可见，非密码学隔离；鉴权由 `AccessControl` + `brain_id` 过滤保证。
