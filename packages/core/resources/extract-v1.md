# Extract facts v1 (stub)

Given a markdown note body, extract concise factual statements as JSON array:

```json
[{ "text": "..." }]
```

Rules:
- Prefer list items and section headings as fact candidates.
- Do not rewrite or summarize the source body.
- Each fact text must be non-empty and ≤2000 characters.
