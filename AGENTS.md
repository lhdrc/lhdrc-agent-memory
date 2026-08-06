# AGENTS.md — df-memory

给在本仓库工作的 AI agent / 工程师的导航与约束。实现前先读完本文。

## 项目是什么

**df-memory**：开源、单机、本地部署的记忆模块——「agent 的 git + 知识库」。  
当前交付焦点：**CLI MVP**（可写可查的本地记忆仓），不是完整的蒸馏飞轮。

> 口号里的「git」指版本化知识仓体验；**实现上热路径以 md 文件为权威**，git 为可选批量账本（08 **D1/D18**）。

## 文档层级（权威顺序）

| 优先级 | 路径 | 用途 |
|---|---|---|
| 1 | [`specs/mvp/`](specs/mvp/) | **实现规格**——按此编码与验收 |
| 2 | [`specs/二期/`](specs/二期/) | MVP 完成后再做 |
| 3 | [`reports/08-开源记忆模块设计方案.md`](reports/08-开源记忆模块设计方案.md) | 架构与 ADR；与 Spec 冲突时 **先改 Spec/ADR 再改代码** |
| 4 | [`reports/01`](reports/01-gbrain-调研报告.md)–[`05`](reports/05-四项目对比总结.md) | 调研背景，不直接当接口规格 |

入口索引：[`specs/README.md`](specs/README.md)。

## 现在该做什么

1. 读 [`specs/mvp/00-conventions.md`](specs/mvp/00-conventions.md)（含 **§8 D18 flush**）  
2. 按顺序实现并勾选 DoD：  
   - [`M1-repo-file-authority.md`](specs/mvp/M1-repo-file-authority.md)  
   - [`M2-write-cli.md`](specs/mvp/M2-write-cli.md)  
   - [`M3-index-query.md`](specs/mvp/M3-index-query.md)  
3. 写入校验以 [`specs/mvp/WRITE_FORMAT.md`](specs/mvp/WRITE_FORMAT.md) 为准  
4. **不要**开始二期（MCP / 蒸馏 / 向量 / 多租户），除非用户明确要求  

## 技术栈（已锁定）

- TypeScript strict + **Bun** workspaces  
- 权威存储：**md + frontmatter**（文件真相）  
- 版本账本：git **可选批量 flush**（默认 `mode: batch`，非每写必 commit）  
- 索引：**PGLite**（`.dfmemory/pglite/`）  
- 包：`packages/core`、`packages/cli`（bin: `memory`）  
- **不实现 Java**；MVP **不调用 LLM**、不强制联网  

## 不可违背的 ADR（摘要）

完整表见 08 §0。落地时尤其遵守：

| ID | 硬约束 |
|---|---|
| D1 | 文件是真相；索引可丢，必须能 `rebuild-index` 恢复；git 不是写路径必要条件 |
| D2 | brain 级内容只在 `brains/{brainId}/`；根目录不放租户记忆 |
| D13 | Entity **merge = 文件事务**（canonical + redirect + event）；禁止只改索引 |
| D14 | 所有写入走 `WRITE_FORMAT` 校验，不靠模型自觉 |
| D17 | L0 热路径 ADD-only；蒸馏（二期）不删 `sources/`；forget 默认软归档 |
| D18 | 热路径不借 git；N/T/退出/显式 sync flush；merge/schema/purge **强制即时 commit** |

## 工程习惯

- 先改 Spec / 测试意图，再写代码；验收表（Given/When/Then）要有对应 `bun:test`  
- 错误码与路径规则跟 `00-conventions.md`  
- Schema 形状来自 pack YAML（默认 `problem-tree`），核心不硬编码 issue 路径语义  
- 提交信息风格：用户未要求则不要主动 `git commit`（指本仓库开发提交）  
- 不要把调研报告或 08 全文复制进代码注释；引用 Spec ID（如 `M2-05`）即可  
- 每完成一个spec及时进行git commit  

## 明确不要做

- 在 MVP 引入云向量库、默认云 API、MCP/REST 服务  
- Entity merge 只 UPDATE PGLite  
- 用覆盖写破坏 ADD-only  
- 把 `experiences/`、`skills/` 建在 `brains/{id}/` 之外  
- 未获要求实现二期能力或并行 Java 栈  
- 修改本文件或 Spec 以「绕过」验收，除非用户要求修订规格  
- 在「索引/flush 失败」时用 `git checkout` 抹掉已成功的权威 md  

## 常用验收口令（MVP）

```bash
bun run memory -- init ./demo
# 在仓内：
bun run memory -- capture --title "重试策略" --type decision --body "改为固定3次"
bun run memory -- query "重试"
bun run memory -- rebuild-index
bun run memory -- sync --commit
bun run memory -- entity merge <a> <b> --canonical <a> --confirm
```

细节与更多用例见各 Spec 验收节与 [`specs/mvp/README.md`](specs/mvp/README.md)。
