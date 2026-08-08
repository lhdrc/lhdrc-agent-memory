# fixtures/mini

自建双 brain 小集（运行时由 harness / isolation_fuzz 生成，不提交真实密钥）。

期望结构：

```
brains/brain-a/sources/default/...   # 含唯一 secret A
brains/brain-b/sources/default/...   # 含唯一 secret B
shared/skills/...                    # 未 mount 时不可见
```

验收：

1. `brain-a` token 查询不含 secret B
2. 跨 brain path → `E_FORBIDDEN` / `E_NOT_FOUND`
3. 100 次 path 变异零泄漏
