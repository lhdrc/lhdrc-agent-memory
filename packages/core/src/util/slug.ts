export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

export function isSlugLike(value: string): boolean {
  return SLUG_RE.test(value);
}

export function titleToSlug(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "untitled";
}
