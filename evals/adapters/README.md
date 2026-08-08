# 公开基准适配（TODO）

后续可在此挂载：

- LoCoMo
- LongMemEval

建议接口：

```ts
interface EvalAdapter {
  id: string;
  load(): Promise<EvalCase[]>;
  score(output: unknown, gold: unknown): Promise<number>;
}
```

当前 DoD 不要求实现公开基准；先跑通 `isolation_fuzz` + `evals/run.ts` 迷你 harness。
