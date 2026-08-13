# Agent protocol v1

给接入 df-memory 的 coding agent：何时查仓、如何提交原文、禁止自造写入格式。

## 何时查（`shouldQueryMemory`）

门控是**确定性打分**，不调 LLM。默认阈值 3。

**强制查**

- 会话第一条用户消息 / `sessionStart` → `memory think "<这句>"`
- 用户写了 `/memory <q>` 或「查一下记忆」→ `memory find`
- 配置 `recall.force=true`

**硬跳过**

- 空串，或 trim 后 Unicode 长度 < 4
- 文本已含 `<df-memory-context`（防重复注入）
- `bypass=true`
- 与上次实际查询完全相同且在 120s 去抖窗内

**打分（可叠加，同类不重复加）**

| 信号 | 分 |
|---|---|
| 问历史（以前/上次/谁决定/踩过/我们约定/last time/how did we） | +3 |
| 拟改约定（依赖、目录结构、错误码、鉴权、公共 API、`memory.yml`） | +3 |
| 操作型动词（实现/修复/重构/部署/写入/create/implement/fix/deploy/build） | +3 |
| 执行动词（测试/构建/调试/test/build/debug/run） | +2 |
| 失败信号且 `failCount >= 2` | +2 |
| 工程对象（路径、ErrorCodes、hook、API、pack） | +2 |
| 经验意图（踩坑/教训/best practice/avoid） | +1 |
| 对话型（你好/谢谢/好的/ok/继续/再试/修一下/lint 一下/翻译/总结这段） | −3 |
| 纯知识问答、无工程对象、无执行/操作动词 | −2 |
| 与上次注入 query 词重叠率 ≥ 0.5 且在去抖窗内 | −3 |

`score >= 3` 才查。操作型或失败重试或 sessionStart 用 `think`，其余用 `find`。

编码场景默认不查；命中才 `memory think` / `memory find`。

## 交原文

会话要进仓时，把**原始 turns**交给 `memory remember` / `memory ingest --adapter session`。
不要先自己改写成 md / frontmatter / 路径。编译器在记忆系统内，经 `complete()` 填槽。

- 原文先归档 `.dfmemory/inbox/`（不是 L0，不进检索）
- L0 只出现在 `brains/{id}/sources/` 下经校验的 md
- 无 LLM key 时会话摄入失败（`E_DISABLED`），不要用启发式冒充

## 禁自造格式

Agent **不得**：

- 发明 `path`、`[[wikilink]]`、`@slug`、YAML frontmatter 当提取结果
- 把整场 transcript dump 进 `sources/`
- 把 `<df-memory-context>` 注入块再交给 compile 当新记忆（系统会剥离；你也应避免回喂）

写入形状由 `WRITE_FORMAT` 与 `session-extract-v1.md` 约束。

## 剥离标签

注入块格式：

```
<df-memory-context query="…">
…think/find 的 L0 摘要…
</df-memory-context>
```

`compileSession` 送模型前会剥离该标签。召回块不得再变成新 L0。
