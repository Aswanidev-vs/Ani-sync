import { TFile } from "obsidian";
import type { App } from "obsidian";

export interface VaultNode {
  id: string;
  type: "anime" | "manga" | "staff" | "studio" | "tag" | "profile" | "character";
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
  CHARACTER: "character",
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
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
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

  build(nodes: VaultNode[]): void {
    this.entries = [];
    this.df.clear();
    this.totalDocs = nodes.length;

    for (const node of nodes) {
      const titleStr = `${node.title} ${node.frontmatter.name ?? ""} ${node.frontmatter.nativeName ?? ""}`;
      const titleTokens = tokenize(titleStr);
      const bodyTokens = tokenize(node.body);

      const titleFreq = new Map<string, number>();
      const bodyFreq = new Map<string, number>();
      for (const t of titleTokens) titleFreq.set(t, (titleFreq.get(t) ?? 0) + 1);
      for (const t of bodyTokens) bodyFreq.set(t, (bodyFreq.get(t) ?? 0) + 1);

      const titleTrigrams = buildTrigrams(titleStr);
      const bodyTrigrams = buildTrigrams(`${titleStr} ${node.body}`);

      for (const token of new Set([...titleTokens, ...bodyTokens])) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1);
      }

      this.entries.push({
        node, titleTrigrams, bodyTrigrams,
        titleTokens, bodyTokens, titleFreq, bodyFreq,
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

      if (entry.node.title.toLowerCase() === q) { score = 100; matchedField = "title:exact"; }
      else if (entry.node.frontmatter.anilistId && String(entry.node.frontmatter.anilistId) === q) { score = 100; matchedField = "anilistId"; }
      else if (entry.node.title.toLowerCase().includes(q)) { score = 80 + (q.length / entry.node.title.length) * 15; matchedField = "title:contains"; }
      else if (entry.node.frontmatter.name && String(entry.node.frontmatter.name).toLowerCase().includes(q)) { score = 75; matchedField = "frontmatter:name"; }
      else if (entry.node.frontmatter.nativeName && String(entry.node.frontmatter.nativeName).toLowerCase().includes(q)) { score = 70; matchedField = "nativeName"; }

      if (score < 70) {
        const titleSim = jaccard(queryTrigrams, entry.titleTrigrams);
        const bodySim = jaccard(queryTrigrams, entry.bodyTrigrams);
        const triScore = Math.max(titleSim, bodySim) * 60;
        if (triScore > score) { score = triScore; matchedField = titleSim > bodySim ? "trigram:title" : "trigram:body"; }
      }

      if (queryTokens.length > 0 && score < 70) {
        const bm25 = this.bm25Score(entry, queryTokens);
        const norm = Math.min(60, bm25 * 10);
        if (norm > score) { score = norm; matchedField = "bm25"; }
      }

      if (score < 10 && q.length >= 3) {
        const fields = [
          { text: entry.node.title.toLowerCase(), w: 40, f: "title" },
          { text: String(entry.node.frontmatter.name ?? "").toLowerCase(), w: 35, f: "name" },
          { text: String(entry.node.frontmatter.nativeName ?? "").toLowerCase(), w: 30, f: "nativeName" },
        ];
        for (const f of fields) {
          if (!f.text) continue;
          let tI = 0, qI = 0;
          while (tI < f.text.length && qI < q.length) { if (f.text[tI] === q[qI]) qI++; tI++; }
          if (qI === q.length) { const s = f.w * 0.6; if (s > score) { score = s; matchedField = f.f; } }
        }
      }

      if (score > 0) scored.push({ entry, score, matchedField });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map(s => ({ node: s.entry.node, score: s.score, matchedField: s.matchedField }));
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

    this.index = new SearchIndex();
    this.index.build(this.nodes);
  }

  private getAllMarkdownFiles(folder: any): TFile[] {
    const files: TFile[] = [];
    const children = folder.children ?? [];
    for (const child of children) {
      if (child instanceof TFile && child.extension === "md") files.push(child);
      else if (child.children) files.push(...this.getAllMarkdownFiles(child));
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
          if (typeof value === "string") value = this.parseYamlValue(value);
          currentObj[key] = value;
        }
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();
        if (value === "") { currentParent = key; currentObj = {}; fm[key] = currentObj; continue; }
        currentParent = null; currentObj = null;
        if (typeof value === "string") value = this.parseYamlValue(value);
        fm[key] = value;
      }
    }
    return { frontmatter: fm, body: content.slice(match[0].length).trim() };
  }

  private parseYamlValue(value: string): unknown {
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value === "true") return true;
    if (value === "false") return false;
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

  getLoadedCount(): number { return this.nodes.length; }
  getLoadedTitles(): string[] { return this.nodes.map((n) => n.title).sort(); }

  search(query: string): VaultSearchResult[] {
    if (!this.index) return [];
    return this.index.search(query);
  }

  getAllMedia(): VaultNode[] { return this.nodes.filter((n) => n.type === "anime" || n.type === "manga"); }

  getStaffWorks(name: string): VaultNode[] {
    const q = name.toLowerCase().trim();
    if (!q) return [];
    return this.nodes.filter((n) => n.body.toLowerCase().includes(q) && (n.type === "anime" || n.type === "manga"));
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
      if (n.frontmatter.tags && Array.isArray(n.frontmatter.tags)) lines.push(`  Tags: ${n.frontmatter.tags.join(", ")}`);

      const bodyLines = n.body.split("\n");
      let inSection = "";
      for (const line of bodyLines) {
        if (line.startsWith("## ")) inSection = line.slice(3).trim();
        else if (inSection && line.startsWith("- ")) lines.push(`  ${inSection}: ${line.slice(2)}`);
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

export function fuzzyScore(target: string, query: string): number {
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.8 + (q.length / t.length) * 0.15;
  let tIdx = 0, qIdx = 0;
  while (tIdx < t.length && qIdx < q.length) { if (t[tIdx] === q[qIdx]) qIdx++; tIdx++; }
  if (qIdx === q.length) return 0.6;
  return 0;
}

export function levenshteinDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + 1);
    }
  }
  return matrix[a.length][b.length];
}
