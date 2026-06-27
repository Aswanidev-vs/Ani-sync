import { TFile } from "obsidian";
import type { App } from "obsidian";

export interface VaultNode {
  id: string;
  type: "anime" | "manga" | "staff" | "studio" | "tag" | "profile";
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
}

export interface VaultSearchResult {
  node: VaultNode;
  score: number;
  matchedField: string;
}

export class VaultContext {
  private app: App;
  private basePath: string;
  private nodes: VaultNode[] = [];
  private loaded = false;

  constructor(app: App, basePath: string) {
    this.app = app;
    this.basePath = basePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const folder = this.app.vault.getAbstractFileByPath(this.basePath);
    if (!folder) return;

    const files = this.getAllMarkdownFiles(folder);
    for (const file of files) {
      const node = await this.parseFile(file);
      if (node) this.nodes.push(node);
    }
    this.loaded = true;
  }

  private getAllMarkdownFiles(folder: any): TFile[] {
    const files: TFile[] = [];
    const children = folder.children ?? [];
    for (const child of children) {
      if (child instanceof TFile && child.extension === "md") {
        files.push(child);
      } else if (child.children) {
        files.push(...this.getAllMarkdownFiles(child));
      }
    }
    return files;
  }

  private async parseFile(file: TFile): Promise<VaultNode | null> {
    try {
      const content = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(content);
      if (!frontmatter?.anilistId) return null;

      const type = frontmatter.type as string;
      const normalizedType = type === "ANIME" ? "anime" : type === "MANGA" ? "manga" : type.toLowerCase();
      const id = `${normalizedType}:${frontmatter.anilistId}`;
      const title = this.extractTitle(frontmatter, body);

      return { id, type: normalizedType as VaultNode["type"], title, frontmatter, body, path: file.path };
    } catch (e) {
      console.error("[VaultContext] Failed to parse", file.path, e);
      return null;
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { frontmatter: {}, body: content };
    const fm: Record<string, unknown> = {};
    let currentParent: string | null = null;
    let currentObj: Record<string, unknown> | null = null;

    for (const line of match[1].split(/\r?\n/)) {
      // Skip empty lines
      if (!line.trim()) continue;

      // Check if line is indented (nested key)
      const indentMatch = line.match(/^(\s+)(\S.*)/);
      if (indentMatch && currentParent && currentObj) {
        const nested = indentMatch[2];
        const colonIdx = nested.indexOf(":");
        if (colonIdx > 0) {
          const key = nested.slice(0, colonIdx).trim();
          let value: unknown = nested.slice(colonIdx + 1).trim();
          if (typeof value === "string") {
            const v = value as string;
            if (v.startsWith("'") && v.endsWith("'")) value = v.slice(1, -1);
            else if (v.startsWith('"') && v.endsWith('"')) value = v.slice(1, -1);
            else if (v === "true") value = true;
            else if (v === "false") value = false;
            else if (/^-?\d+$/.test(v)) value = Number(v);
          }
          currentObj[key] = value;
        }
        continue;
      }

      // Top-level key
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();

        // If value is empty, this might be a parent for nested keys
        if (value === "") {
          currentParent = key;
          currentObj = {};
          fm[key] = currentObj;
          continue;
        }

        // Reset parent tracking
        currentParent = null;
        currentObj = null;

        if (typeof value === "string") {
          const v = value as string;
          if (v.startsWith("'") && v.endsWith("'")) value = v.slice(1, -1);
          else if (v.startsWith('"') && v.endsWith('"')) value = v.slice(1, -1);
          else if (v === "true") value = true;
          else if (v === "false") value = false;
          else if (/^-?\d+$/.test(v)) value = Number(v);
        }
        fm[key] = value;
      }
    }
    const body = content.slice(match[0].length).trim();
    return { frontmatter: fm, body };
  }

  private extractTitle(fm: Record<string, unknown>, body: string): string {
    if (fm.title) {
      const t = fm.title as Record<string, unknown>;
      return (t.romaji as string) || (t.english as string) || (t.native as string) || String(fm.anilistId);
    }
    const h1 = body.match(/^#\s+(.+)/m);
    return h1 ? h1[1] : String(fm.anilistId);
  }

  getLoadedCount(): number {
    return this.nodes.length;
  }

  getLoadedTitles(): string[] {
    return this.nodes.map((n) => n.title).sort();
  }

  search(query: string): VaultSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const stopWords = new Set([
      "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at",
      "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
      "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further",
      "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
      "i", "if", "in", "into", "is", "it", "its", "me", "more", "most", "my", "myself",
      "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
      "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "with", "you", "your", "yours", "yourself", "yourselves",
      "name", "author", "creator", "writer", "artist", "illustrator", "score", "tell", "info", "information", "list", "show", "details", "find", "search", "give", "who is", "what is", "tell me"
    ]);

    const words = q.split(/[\s,.\-!?()]+/).filter(w => w.length >= 2 && !stopWords.has(w));
    const keywords = words.length > 0 ? words : q.split(/\s+/).filter(Boolean);

    const results: VaultSearchResult[] = [];
    for (const node of this.nodes) {
      let bestScore = 0;
      let matchedField = "";

      // 1. Direct whole-phrase matches (highest priority)
      if (node.title.toLowerCase().includes(q)) {
        bestScore = Math.max(bestScore, node.title.toLowerCase() === q ? 100 : 80);
        matchedField = "title";
      }

      const fmName = node.frontmatter.name;
      if (fmName && String(fmName).toLowerCase().includes(q)) {
        bestScore = Math.max(bestScore, 90);
        matchedField = "frontmatter:name";
      }

      if (node.frontmatter.nativeName && String(node.frontmatter.nativeName).toLowerCase().includes(q)) {
        bestScore = Math.max(bestScore, 85);
        matchedField = "nativeName";
      }

      const fmTitle = node.frontmatter.title;
      if (fmTitle && typeof fmTitle === "object") {
        const t = fmTitle as Record<string, unknown>;
        for (const [, val] of Object.entries(t)) {
          if (typeof val === "string" && val.toLowerCase().includes(q)) {
            bestScore = Math.max(bestScore, 85);
            matchedField = "frontmatter:title";
          }
        }
      }

      if (node.frontmatter.anilistId && String(node.frontmatter.anilistId) === q) {
        bestScore = Math.max(bestScore, 100);
        matchedField = "anilistId";
      }

      if (node.body.toLowerCase().includes(q)) {
        bestScore = Math.max(bestScore, 30);
        matchedField = matchedField || "body";
      }

      // 2. Keyword-based matching (for conversational queries with fuzzy scoring)
      let keywordScore = 0;
      let matchedKeywordsCount = 0;
      const matchedFieldsList: string[] = [];

      for (const word of keywords) {
        let bestWordScore = 0;
        let bestWordField = "";

        const titleFuzzy = fuzzyScore(node.title, word);
        if (titleFuzzy > bestWordScore) {
          bestWordScore = titleFuzzy * 40;
          bestWordField = "title";
        }

        if (fmName) {
          const nameFuzzy = fuzzyScore(String(fmName), word);
          if (nameFuzzy > bestWordScore) {
            bestWordScore = nameFuzzy * 35;
            bestWordField = "name";
          }
        }

        if (node.frontmatter.nativeName) {
          const nativeFuzzy = fuzzyScore(String(node.frontmatter.nativeName), word);
          if (nativeFuzzy > bestWordScore) {
            bestWordScore = nativeFuzzy * 30;
            bestWordField = "nativeName";
          }
        }

        if (fmTitle && typeof fmTitle === "object") {
          const t = fmTitle as Record<string, unknown>;
          for (const [, val] of Object.entries(t)) {
            if (typeof val === "string") {
              const valFuzzy = fuzzyScore(val, word);
              if (valFuzzy > bestWordScore) {
                bestWordScore = valFuzzy * 30;
                bestWordField = "titleObj";
              }
            }
          }
        }

        if (node.body.toLowerCase().includes(word)) {
          if (10 > bestWordScore) {
            bestWordScore = 10;
            bestWordField = "body";
          }
        }

        if (bestWordScore > 0) {
          keywordScore += bestWordScore;
          matchedKeywordsCount++;
          matchedFieldsList.push(bestWordField);
        }
      }

      if (keywords.length > 0 && matchedKeywordsCount > 0) {
        const matchRatio = matchedKeywordsCount / keywords.length;
        // Boost score based on keyword match ratio
        const finalKeywordScore = keywordScore * matchRatio;
        // Cap keyword score to 95 so exact full matches still take priority
        bestScore = Math.max(bestScore, Math.min(95, finalKeywordScore));
        if (matchedFieldsList.length > 0 && !matchedField) {
          matchedField = `keywords(${Array.from(new Set(matchedFieldsList)).slice(0, 2).join(",")})`;
        }
      }

      if (bestScore > 0) {
        results.push({ node, score: bestScore, matchedField });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 20);
  }

  getAllMedia(): VaultNode[] {
    return this.nodes.filter((n) => n.type === "anime" || n.type === "manga");
  }

  getStaffWorks(name: string): VaultNode[] {
    const q = name.toLowerCase().trim();
    if (!q) return [];
    return this.nodes.filter((n) =>
      n.body.toLowerCase().includes(q) && (n.type === "anime" || n.type === "manga")
    );
  }

  buildPromptContext(results: VaultSearchResult[]): string {
    if (results.length === 0) return "No matching data found in your AniList library.";

    const parts = [
      "The following data is from the user's synced AniList library (vault). Answer ONLY from this information.",
      "---",
    ];

    for (const r of results) {
      const n = r.node;
      const lines: string[] = [];

      lines.push(`${n.type.toUpperCase()}: "${n.title}"`);
      if (n.frontmatter.type) lines.push(`  Media Type: ${n.frontmatter.type}`);
      if (n.frontmatter.format) lines.push(`  Format: ${n.frontmatter.format}`);
      if (n.frontmatter.status) lines.push(`  Status: ${n.frontmatter.status}`);
      if (n.frontmatter.averageScore != null) lines.push(`  Score: ${n.frontmatter.averageScore}`);
      if (n.frontmatter.episodes != null) lines.push(`  Episodes: ${n.frontmatter.episodes}`);
      if (n.frontmatter.chapters != null) lines.push(`  Chapters: ${n.frontmatter.chapters} | Volumes: ${n.frontmatter.volumes ?? "?"}`);
      if (n.frontmatter.genres) lines.push(`  Genres: ${Array.isArray(n.frontmatter.genres) ? n.frontmatter.genres.join(", ") : n.frontmatter.genres}`);

      const bodyLines = n.body.split("\n");
      let inSection = "";
      for (const line of bodyLines) {
        if (line.startsWith("## ")) inSection = line.slice(3).trim();
        else if (inSection && line.startsWith("- ")) {
          lines.push(`  ${inSection}: ${line.slice(2)}`);
        }
      }

      lines.push(`  Matched via: ${r.matchedField}`);
      parts.push(lines.join("\n"));
      parts.push("---");
    }

    return parts.join("\n");
  }

  async buildContextForQuery(query: string): Promise<string> {
    await this.load();
    const results = this.search(query);
    return this.buildPromptContext(results);
  }
}

export function fuzzyScore(target: string, query: string): number {
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.8 + (q.length / t.length) * 0.15;

  let tIdx = 0;
  let qIdx = 0;
  while (tIdx < t.length && qIdx < q.length) {
    if (t[tIdx] === q[qIdx]) {
      qIdx++;
    }
    tIdx++;
  }
  if (qIdx === q.length) {
    return 0.6;
  }

  if (q.length >= 4) {
    const dist = levenshteinDistance(q, t);
    const maxLen = Math.max(q.length, t.length);
    const score = 1 - dist / maxLen;
    if (score > 0.7) return score * 0.5;
  }

  return 0;
}

export function levenshteinDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }
  return matrix[a.length][b.length];
}