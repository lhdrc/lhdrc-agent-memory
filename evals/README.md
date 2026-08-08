# evals — df-memory 评测脚手架（P3.3）

本目录提供最小评测 harness。公开基准（LoCoMo / LongMemEval）适配标记为 TODO。

## 如何跑

```bash
# 隔离 fuzz（CI required，P3.3 DoD）
bun test packages/core/tests/isolation_fuzz.test.ts

# 迷你夹具：索引一致性冒烟
bun run evals/run.ts
```

## 目录

| 路径 | 说明 |
|---|---|
| `fixtures/mini/` | 自建双 brain 小集说明 |
| `adapters/README.md` | 公开基准适配接口（TODO） |
| `run.ts` | 迷你 harness 入口 |

## 隔离说明

单仓多 brain 时 **git 历史对同仓可见**，非密码学隔离。权限边界由 `AccessControl` + `brain_id` 检索过滤保证。
