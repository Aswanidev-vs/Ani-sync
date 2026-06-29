import { TFile } from "obsidian";
import type { App } from "obsidian";

export interface VaultNode {
  id: string;
  type: "anime" | "manga" | "staff" | "studio" | "tag" | "profile" | "character" | "voiceactor";
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

const TYPE_MAP: Record<string, VaultNode["type"]> = {
  ANIME: "anime", MANGA: "manga", STAFF: "staff",
  STUDIO: "studio", TAG: "tag", PROFILE: "profile",
  CHARACTER: "character", VOICE_ACTOR: "voiceactor",
};

const TRIGRAM_SIZE = 3;

function buildTrigrams(text: string): Set<string> {
  const trigrams = new Set<string>();
  const lower = text.toLowerCase();
  for (let i = 0; i <= lower.length - TRIGRAM_SIZE; i++) {
    trigrams.add(lower.slice(i, i + TRIGRAM_SIZE));
  }
  return trigrams;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface IndexEntry {
  node: VaultNode;
  titleTrigrams: Set<string>;
  bodyTrigrams: Set<string>;
  titleTokens: string[];
  bodyTokens: string[];
  titleFreq: Map<string, number>;
  bodyFreq: Map<string, number>;
  totalTokens: number;
}

class SearchIndex {
  entries: IndexEntry[] = [];
  private df = new Map<string, number>();
  private totalDocs = 0;
  private maxDf = 0;

  build(nodes: VaultNode[]): void {
    this.entries = [];
    this.df.clear();
    this.totalDocs = nodes.length;
    this.maxDf = Math.floor(nodes.length * 0.75);

    for (const node of nodes) {
      const allText = `${node.title} ${node.frontmatter.name ?? ""} ${node.frontmatter.nativeName ?? ""} ${node.body}`;
      const titleTokens = tokenize(`${node.title} ${node.frontmatter.name ?? ""} ${node.frontmatter.nativeName ?? ""}`);
      const bodyTokens = tokenize(node.body);

      const titleFreq = new Map<string, number>();
      const bodyFreq = new Map<string, number>();
      for (const t of titleTokens) titleFreq.set(t, (titleFreq.get(t) ?? 0) + 1);
      for (const t of bodyTokens) bodyFreq.set(t, (bodyFreq.get(t) ?? 0) + 1);

      const titleTrigrams = buildTrigrams(node.title);
      const bodyTrigrams = buildTrigrams(allText);

      const allTokens = new Set([...titleTokens, ...bodyTokens]);
      for (const token of allTokens) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1);
      }

      this.entries.push({
        node,
        titleTrigrams,
        bodyTrigrams,
        titleTokens,
        bodyTokens,
        titleFreq,
        bodyFreq,
        totalTokens: bodyTokens.length,
      });
    }
  }

  private idf(term: string): number {
    const docFreq = this.df.get(term) ?? 0;
    if (docFreq === 0) return 0;
    return Math.log((this.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
  }

  bm25Score(entry: IndexEntry, queryTokens: string[], k1 = 1.5, b = 0.75): number {
    const avgDl = this.totalDocs > 0 ? this.entries.reduce((s, e) => s + e.totalTokens, 0) / this.totalDocs : 1;
    let score = 0;

    for (const term of queryTokens) {
      const tfTitle = entry.titleFreq.get(term) ?? 0;
      const tfBody = entry.bodyFreq.get(term) ?? 0;
      const idf = this.idf(term);
      if (idf === 0) continue;

      const titleScore = (tfTitle * (k1 + 1)) / (tfTitle + k1 * (1 - b + b * (entry.titleTokens.length / (avgDl || 1))));
      const bodyScore = (tfBody * (k1 + 1)) / (tfBody + k1 * (1 - b + b * (entry.totalTokens / (avgDl || 1))));
      score += idf * (titleScore * 3 + bodyScore);
    }
    return score;
  }

  search(query: string): VaultSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q || this.entries.length === 0) return [];

    const queryTrigrams = buildTrigrams(q);
    const queryTokens = tokenize(q);

    const scored: { entry: IndexEntry; score: number; matchedField: string }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      let matchedField = "";

      // Exact title match
      if (entry.node.title.toLowerCase() === q) {
        score = 100;
        matchedField = "title:exact";
      }
      // Exact ID match
      else if (entry.node.frontmatter.anilistId && String(entry.node.frontmatter.anilistId) === q) {
        score = 100;
        matchedField = "anilistId";
      }
      // Title contains query
      else if (entry.node.title.toLowerCase().includes(q)) {
        score = 80 + (q.length / entry.node.title.length) * 15;
        matchedField = "title:contains";
      }
      // Frontmatter name contains
      else if (entry.node.frontmatter.name && String(entry.node.frontmatter.name).toLowerCase().includes(q)) {
        score = 75;
        matchedField = "frontmatter:name";
      }
      // Native name contains
      else if (entry.node.frontmatter.nativeName && String(entry.node.frontmatter.nativeName).toLowerCase().includes(q)) {
        score = 70;
        matchedField = "nativeName";
      }

      // Trigram similarity
      if (score < 70) {
        const titleTrigramSim = jaccard(queryTrigrams, entry.titleTrigrams);
        const bodyTrigramSim = jaccard(queryTrigrams, entry.bodyTrigrams);
        const trigramScore = Math.max(titleTrigramSim, bodyTrigramSim) * 60;
        if (trigramScore > score) {
          score = trigramScore;
          matchedField = titleTrigramSim > bodyTrigramSim ? "trigram:title" : "trigram:body";
        }
      }

      // BM25 scoring
      if (queryTokens.length > 0 && score < 70) {
        const bm25 = this.bm25Score(entry, queryTokens);
        if (bm25 > 0) {
          const normalizedBm25 = Math.min(60, bm25 * 10);
          if (normalizedBm25 > score) {
            score = normalizedBm25;
            matchedField = "bm25";
          }
        }
      }

      // Fuzzy fallback
      if (score < 10 && q.length >= 3) {
        const fuzzyResult = this.fuzzySearch(entry.node, q);
        if (fuzzyResult.score > 0) {
          score = fuzzyResult.score;
          matchedField = fuzzyResult.field;
        }
      }

      if (score > 0) {
        scored.push({ entry, score, matchedField });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map(s => ({ node: s.entry.node, score: s.score, matchedField: s.matchedField }));
  }

  private fuzzySearch(node: VaultNode, query: string): { score: number; field: string } {
    const fields = [
      { text: node.title.toLowerCase(), weight: 40, field: "title" },
      { text: String(node.frontmatter.name ?? "").toLowerCase(), weight: 35, field: "name" },
      { text: String(node.frontmatter.nativeName ?? "").toLowerCase(), weight: 30, field: "nativeName" },
    ];

    let best = 0;
    let bestField = "";

    for (const f of fields) {
      if (!f.text) continue;
      // Subsequence match
      let tIdx = 0, qIdx = 0;
      while (tIdx < f.text.length && qIdx < query.length) {
        if (f.text[tIdx] === query[qIdx]) qIdx++;
        tIdx++;
      }
      if (qIdx === query.length) {
        const subScore = f.weight * 0.6;
        if (subScore > best) { best = subScore; bestField = f.field; }
      }
    }

    return { score: best, field: bestField };
  }
}

export class VaultContext {
  private app: App;
  private basePath: string;
  private nodes: VaultNode[] = [];
  private loaded = false;
  private index: SearchIndex | null = null;

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

    // Build search index after loading all nodes
    this.index = new SearchIndex();
    this.index.build(this.nodes);
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
      const normalizedType = TYPE_MAP[type] ?? type.toLowerCase() as VaultNode["type"];
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
      if (!line.trim()) continue;

      const indentMatch = line.match(/^(\s+)(\S.*)/);
      if (indentMatch && currentParent && currentObj) {
        const nested = indentMatch[2];
        const colonIdx = nested.indexOf(":");
        if (colonIdx > 0) {
          const key = nested.slice(0, colonIdx).trim();
          let value: unknown = nested.slice(colonIdx + 1).trim();
          if (typeof value === "string") {
            value = this.parseYamlValue(value);
          }
          currentObj[key] = value;
        }
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();

        if (value === "") {
          currentParent = key;
          currentObj = {};
          fm[key] = currentObj;
          continue;
        }

        currentParent = null;
        currentObj = null;

        if (typeof value === "string") {
          value = this.parseYamlValue(value);
        }
        fm[key] = value;
      }
    }
    const body = content.slice(match[0].length).trim();
    return { frontmatter: fm, body };
  }

  private parseYamlValue(value: string): unknown {
    // Inline array: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
    }
    // Quoted string
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    // Boolean
    if (value === "true") return true;
    if (value === "false") return false;
    // Number
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
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
    if (!this.index) return [];
    return this.index.search(query);
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
      if (n.frontmatter.language) lines.push(`  Language: ${n.frontmatter.language}`);

      const bodyLines = n.body.split("\n");
      let inSection = "";
      for (const line of bodyLines) {
        if (line.startsWith("## ")) inSection = line.slice(3).trim();
        else if (inSection && line.startsWith("- ")) {
          lines.push(`  ${inSection}: ${line.slice(2)}`);
        }
      }

      lines.push(`  Matched via: ${r.matchedField} (score: ${r.score.toFixed(1)})`);
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

// Keep fuzzyScore for context.ts compatibility
export function fuzzyScore(target: string, query: string): number {
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.8 + (q.length / t.length) * 0.15;

  let tIdx = 0, qIdx = 0;
  while (tIdx < t.length && qIdx < q.length) {
    if (t[tIdx] === q[qIdx]) qIdx++;
    tIdx++;
  }
  if (qIdx === q.length) return 0.6;
  return 0;
}
