function normalizeInput(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(input: string): string {
  return normalizeInput(input)
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 120)
    .trim();
}

export function slugifyTag(input: string): string {
  return normalizeInput(input)
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120)
    .replace(/^-|-$/g, "");
}

export function slugifyAnchor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'"]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function pickTitle(t: { userPreferred?: string | null; english?: string | null; romaji?: string | null } | null | undefined): string {
  return t?.userPreferred ?? t?.english ?? t?.romaji ?? "(untitled)";
}
