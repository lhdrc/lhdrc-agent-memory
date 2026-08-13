# 公开基准适配（P5.6）

实现 `EvalAdapter`（见 `types.ts`）。**禁止**空 README + `E_DISABLED` 算完成。

## locomo

| 项 | 值 |
|---|---|
| id | `locomo` |
| 格式 | LoCoMo JSON：`conversation.session_N[]` + `qa[]` |
| fixture | [`../fixtures/locomo-sample/`](../fixtures/locomo-sample/)（自建 1 样本 2 QA，**不是**全量下载） |
| full pin | `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`（`fetch --allow-net`） |
| 许可 | 全量数据遵循 [snap-research/locomo](https://github.com/snap-research/locomo) 上游许可；仓内 sample 为自建夹具 |

```bash
bun run evals/run.ts --adapter locomo --fixture
bun run evals/run.ts fetch --adapter locomo --allow-net
```

无 fixture 且未 fetch 时退出非 0，并提示使用 `--fixture` 或 `fetch --allow-net`。

## LongMemEval

未实现。需要时新增 adapter id + `fixtures/longmemeval-sample/`，不要用 stub 占位声称完成。
