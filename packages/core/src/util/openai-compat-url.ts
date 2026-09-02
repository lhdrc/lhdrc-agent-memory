/** openai-compatible 网关：`https://api.openai.com` 或已带 `/v1` 的 URL。 */
export function openaiCompatUrl(baseUrl: string, rest: "chat/completions" | "embeddings"): string {
  const b = baseUrl.replace(/\/+$/, "");
  const root = b.endsWith("/v1") ? b : `${b}/v1`;
  return `${root}/${rest}`;
}
