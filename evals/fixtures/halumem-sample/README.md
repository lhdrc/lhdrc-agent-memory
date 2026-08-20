# halumem-sample

HaluMem-Medium **格式**的仓内子集（1 user / 1 session / 3 memory points / 2 QA），自建内容，非上游全量。

```bash
memory eval --adapter halumem --fixture
memory eval --adapter halumem --fixture --user fixture-user-0
```

全量：`memory eval fetch --adapter halumem --allow-net`（pin 见 `adapters/halumem.ts`）。
