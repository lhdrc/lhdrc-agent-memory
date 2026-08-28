# 原则：错误包装给宿主 agent，不给仓内记忆 LLM

| 字段 | 值 |
|---|---|
| ID | P12-error-to-model |
| 状态 | locked（原则；**未编码**） |
| 来源 | 2026-08-28：信封给**使用记忆的 agent**；不是记忆系统里做抽取/compile 的那个模型 |
| 对照 | [`failure-degrade-audit.md`](failure-degrade-audit.md)；P8.1 §4.7；P9.2 |

> **宿主 agent** = DSH（或其它 harness）会话里那个调工具、读注入的模型。  
> **仓内记忆 LLM** = `complete()`：compile / extract / distill / abstract。  
> 错误信封只给前者。后者失败时把 `E_LLM` / `E_DISABLED` **原样打进信封交给宿主 agent**，禁止再调一轮 `complete()` 让仓内模型「判断要不要忽略」。

## 1. 两个模型，只问其中一个

```
宿主 agent  ──工具 / 注入──►  df-memory core
                ◄── 信封 ──     │
                                ├── 索引 / 文件 / job
                                └── 仓内 LLM complete()   ← 不负责判错
```

| 角色 | 做什么 | 看到错误之后 |
|---|---|---|
| **宿主 agent** | 用记忆：query / remember / 读注入 | 重试、换模式、`--no-extract`、向人要 Key、当没记忆继续 |
| **仓内记忆 LLM** | 把会话编成 L0 / 蒸馏 | **不判**「这次失败重不重要」。它自己挂了 → 码进信封，停 |

人手 CLI 不是 agent，但 `--json` 与工具同一信封，方便同一套客户端。

## 2. 信封落点（只到宿主）

| 通道 | 落点 |
|---|---|
| 显式工具 `memory_query` / `memory_remember` / `memory_job` | 工具返回 JSON |
| 被动注入（pre-step，宿主没调工具） | 注入块里的降级短句，让**同一宿主 agent**看见；禁止只「不注入当没发生」 |
| CLI `--json` | 同一 JSON；纯文本模式至少一行 `[E_*]` |
| `complete()` 内部 | **无信封、无二次 LLM**。失败沿现网：不写 L0 / inbox `failed` / job `error`，由外层打进信封 |

## 3. 信封形状

```ts
type MemoryToolEnvelope<T> = {
  ok: boolean;
  result?: T;
  /** 仍有 result 时的降级；给宿主 agent 读，不给仓内 complete() */
  degradation?: Array<{
    code: string;    // E_DISABLED / E_INDEX / E_LLM / E_TIMEOUT / …
    reason: string;  // missing_key | embed_http_5xx | semantic_hash_fallback | …
    message: string;
    arm?: "semantic" | "graph" | "keyword" | "write" | "job";
  }>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};
```

| `ok` | 含义 | 宿主 agent |
|---|---|---|
| true，无 degradation | 正常 | 用 result |
| true，有 degradation | 有货但降级（如仅 BM25） | 自行判断是否信、是否补 Key、是否再查 |
| false + error | 不能当成功 | 不要当成已记住；可 `--no-extract` 或停 |

`ok: true` 且有 hits **不得**再把缺 Key / 关臂藏起来。

## 4. 和现网 fail-open

| 现网 | 新口径 |
|---|---|
| query 缺 key → 哈希 hits，宿主看不见 | 信封 `degradation`；hits 仍给宿主 agent |
| hybrid 空 catch 关语义臂 | `reason: embed_http_5xx` 进信封，不是「语义零命中」 |
| P8.1 注入失败不抛宿主 | **仍不抛宿主**。给宿主 agent 一句 degraded；空失败 ≠ 没有记忆 |
| remember 无 key → job failed | 工具 `ok: false` + `E_DISABLED` 给宿主 agent；仓内 LLM 根本不该被叫到 |
| 仓内 `complete()` 5xx | **不要**再 complete 一次做分类；`E_LLM` 进信封给宿主 |

宿主隔离保留：信封是返回值，不是未捕获异常。

## 5. 明确不做

- 用仓内 `complete()` 给错误做三分类、重试策略、是否 fail-open  
- 信封只出现在 `--explain`（那是开发者分母）  
- 改变 D1：索引失败不回滚已写 md  

## 6. 编码落点（另开 Spec）

core 产出 `degradation[]`（不依赖 explain）→ CLI `--json` 与 **DSH 工具结果**同一信封 → 注入路径写给**宿主会话**的短句。  
`doctor` 只减少宿主第一次撞上缺 Key，**不替代**信封。
