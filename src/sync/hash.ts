const HASH_MARKER_RE = /<!-- anilist-hash:\s*([a-f0-9]{64})\s*-->\s*$/m;

export function extractHashMarker(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null;
  const m = content.match(HASH_MARKER_RE);
  return m && m[1] ? m[1] : null;
}

export function stripHashMarker(content: string | null | undefined): string {
  if (typeof content !== "string") return "";
  return content.replace(HASH_MARKER_RE, "").replace(/\s+$/g, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export async function appendHashMarker(body: string): Promise<string> {
  const trimmed = body.replace(/\s+$/g, "");
  const hash = await sha256Hex(trimmed);
  return `${trimmed}\n\n<!-- anilist-hash: ${hash} -->\n`;
}
