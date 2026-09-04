/** openai-compatible 网关：`https://api.openai.com` 或已带 `/v1` 的 URL。 */
export function openaiCompatUrl(
  baseUrl: string,
  rest: "chat/completions" | "embeddings" | "responses",
): string {
  const b = baseUrl.replace(/\/+$/, "");
  // 已是完整 responses 端点（如 https://opencode.ai/zen/v1/responses）则直用。
  if (rest === "responses" && /\/responses$/.test(b)) return b;
  const root = b.endsWith("/v1") ? b : `${b}/v1`;
  return `${root}/${rest}`;
}

/** Zen Responses 端点：muse-spark 系列走 `/v1/responses`（非 chat/completions）。 */
export function zenResponsesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/responses$/.test(b)) return b;
  if (b.includes("opencode.ai/zen")) {
    const root = b.endsWith("/v1") ? b : `${b}/v1`;
    // b 可能已是 .../zen/v1/chat 之类，统一收敛到 /zen/v1/responses
    if (root.endsWith("/v1")) return `${root}/responses`;
    return "https://opencode.ai/zen/v1/responses";
  }
  return openaiCompatUrl(b, "responses");
}
