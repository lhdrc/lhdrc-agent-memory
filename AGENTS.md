# AGENTS.md — df-memory

给在本仓库工作的 AI agent / 工程师的导航与约束。实现前先读完本文。

## 项目是什么

**df-memory**：开源、单机、本地部署的记忆模块——「agent 的 git + 知识库」。  
当前交付焦点：MVP + 二期 + **三期已落地**（图谱/signals、结晶/dream、多租户）；四期未获明确要求前不做。

> 口号里的「git」指版本化知识仓体验；**实现上热路径以 md 文件为权威**，git 为可选批量账本（08 **D1/D18**）。

## 文档层级（权威顺序）

| 优先级 | 路径 | 用途 |
|---|---|---|
| 1 | [`specs/mvp/`](specs/mvp/) | **实现规格**——按此编码与验收 |
| 2 | [`specs/二期/`](specs/二期/) · [`三期/`](specs/三期/) · [`四期/`](specs/四期/) | 二期/三期已做；**四期最后** MCP/REST |
| 3 | [`reports/08-开源记忆模块设计方案.md`](reports/08-开源记忆模块设计方案.md) | 架构与 ADR；与 Spec 冲突时 **先改 Spec/ADR 再改代码** |
| 4 | [`reports/01`](reports/01-gbrain-调研报告.md)–[`05`](reports/05-四项目对比总结.md) | 调研背景，不直接当接口规格 |

入口索引：[`specs/README.md`](specs/README.md)。

## 当前状态与接下来做什么

**MVP（M1–M3 + D18）已落地**；**二期（P2.1a + P2.2）已落地**；**三期（P3.1–P3.3）已落地**：

| Spec | 能力摘要 |
|---|---|
| P3.1 | 零 LLM 抽链 → `links`；关系臂 + `graph-query`；graph signals；意图；`search_cache`；`query --explain` |
| P3.2 | Skill 结晶 / outcome / 状态机；dream v1 五段；cost / observer；skills 索引 |
| P3.3 | `AccessControl`；`brain create/list` + `--brain`；隔离 fuzz；`evals/` 脚手架 |

回归：`bun test packages/core/tests/`；隔离：`bun run test:isolation`；迷你评测：`bun run eval:mini`。

1. 改行为前先读 / 更新对应 Spec（[`00-conventions.md`](specs/mvp/00-conventions.md) §8、M1/M2/M3、[`二期/`](specs/二期/)、[`三期/`](specs/三期/)）  
2. 写入校验以 [`WRITE_FORMAT.md`](specs/mvp/WRITE_FORMAT.md) 为准（含 experience §9、skill §10）  
3. **不要**开始四期（**MCP·REST** / harness 适配器 / 外部仓 git sync），除非用户明确要求  
4. 与 Spec 冲突时：**先改 Spec/08 ADR，再改代码**  

分期速查：二期 = P2.1a+P2.2（**done**）；三期 = P3.1–P3.3（**done**）；四期 = P4.1（MCP/REST 最后）。

## 技术栈（已锁定）

- TypeScript strict + **Bun** workspaces  
- 权威存储：**md + frontmatter**（文件真相）  
- 版本账本：git **可选批量 flush**（默认 `git.mode: batch`）  
- 索引：**PGLite**（`.dfmemory/pglite/`，可丢可 `rebuild-index`）  
- 包：`packages/core`、`packages/cli`（bin: `memory`）  
- **不实现 Java**；默认 **不强制联网**（`embedding.provider` / `llm.provider` 默认 `off`）  

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
- 不要把调研报告或 08 全文复制进代码注释；引用 Spec ID（如 `M2-11`）即可  
- 验收口令与 CLI 面见 [`specs/mvp/README.md`](specs/mvp/README.md)  
- 每次完成阶段建设后更新AGENTS.md文档，同步进度和完成背景。  
- 对于简单的任务可以交给subagent做，subagent使用composer2.5 模型。  

常用命令：

```bash
bun run test
bun run test:isolation
bun run typecheck
bun run memory -- <cmd>
bun run eval:mini
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

- 在 MVP/默认路径引入云向量库、默认云 API；MCP/REST 服务属**四期**  
- Entity merge 只 UPDATE PGLite  
- 用覆盖写破坏 ADD-only  
- 把 `experiences/`、`skills/` 建在 `brains/{id}/` 之外  
- 未获要求实现四期能力或并行 Java 栈  
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
```

细节见各 Spec 验收节与 [`specs/mvp/README.md`](specs/mvp/README.md)、[`specs/三期/README.md`](specs/三期/README.md)。

> **多租户提示**：单仓多 brain 时 git 历史对同仓可见，非密码学隔离；鉴权由 `AccessControl` + `brain_id` 过滤保证。
