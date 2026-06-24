export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

export function pickTitle(t: { userPreferred?: string | null; english?: string | null; romaji?: string | null } | null | undefined): string {
  return t?.userPreferred ?? t?.english ?? t?.romaji ?? "(untitled)";
}
