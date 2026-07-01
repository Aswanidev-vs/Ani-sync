import { TFile } from "obsidian";
import type { App } from "obsidian";

export interface VaultNode {
  id: string;
  type: "anime" | "manga" | "staff" | "studio" | "tag" | "profile" | "character" | "media_characters" | "voice_actor_index";
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
  CHARACTER: "character", MEDIA_CHARACTERS: "media_characters",
  VOICE_ACTOR_INDEX: "voice_actor_index",
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
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    // CJK characters: split individually
    const c = lower.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7AF)) {
      tokens.push(lower[i]);
      i++;
      continue;
    }
    // Alphanumeric sequences
    if (/[a-z0-9]/.test(lower[i])) {
      let word = "";
      while (i < lower.length && /[a-z0-9]/.test(lower[i])) { word += lower[i]; i++; }
      if (word.length > 0) tokens.push(word);
      continue;
    }
    i++;
  }
  return tokens;
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

interface LinkInfo {
  sourceId: string;
  targetFile: string;
  text: string;
}

class SearchIndex {
  entries: IndexEntry[] = [];
  private df = new Map<string, number>();
  private totalDocs = 0;
  // Heading index: lowercase heading → list of node ids
  private headingIndex = new Map<string, string[]>();
  // Link graph: node id → outgoing wikilinks
  private linkGraph = new Map<string, LinkInfo[]>();
  // Metadata index: frontmatter field name → value → set of node ids
  private metaIndex = new Map<string, Map<string, Set<string>>>();

  build(nodes: VaultNode[]): void {
    this.entries = [];
    this.df.clear();
    this.headingIndex.clear();
    this.linkGraph.clear();
    this.metaIndex.clear();
    this.totalDocs = nodes.length;

    // Pre-compute token frequencies for IDF
    const tokenDocCount = new Map<string, number>();

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

      const allTokens = new Set([...titleTokens, ...bodyTokens]);
      for (const token of allTokens) {
        tokenDocCount.set(token, (tokenDocCount.get(token) ?? 0) + 1);
      }

      // Extract ## headings for heading index
      const lines = node.body.split("\n");
      for (const line of lines) {
        if (line.startsWith("## ")) {
          const headingLower = line.slice(3).trim().toLowerCase();
          if (headingLower.length >= 2) {
            if (!this.headingIndex.has(headingLower)) this.headingIndex.set(headingLower, []);
            this.headingIndex.get(headingLower)!.push(node.id);
          }
        }
      }

      // Link graph
      const links: LinkInfo[] = [];
      for (const line of lines) {
        const linkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
        let match;
        while ((match = linkRegex.exec(line)) !== null) {
          links.push({ sourceId: node.id, targetFile: match[1].trim(), text: match[2]?.trim() ?? match[1].trim() });
        }
      }
      if (links.length > 0) this.linkGraph.set(node.id, links);

      // Metadata index
      const metaFields: [string, string][] = [];
      if (node.frontmatter.type) metaFields.push(["type", String(node.frontmatter.type).toLowerCase()]);
      if (node.frontmatter.mediaType) metaFields.push(["mediaType", String(node.frontmatter.mediaType).toLowerCase()]);
      if (node.frontmatter.status) metaFields.push(["status", String(node.frontmatter.status).toLowerCase()]);
      if (Array.isArray(node.frontmatter.voiceActors)) {
        for (const va of node.frontmatter.voiceActors) metaFields.push(["voiceActor", String(va).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.genres)) {
        for (const g of node.frontmatter.genres) metaFields.push(["genre", String(g).toLowerCase()]);
      }
      for (const [field, value] of metaFields) {
        if (!this.metaIndex.has(field)) this.metaIndex.set(field, new Map());
        const valMap = this.metaIndex.get(field)!;
        if (!valMap.has(value)) valMap.set(value, new Set());
        valMap.get(value)!.add(node.id);
      }

      this.entries.push({
        node, titleTrigrams, bodyTrigrams,
        titleTokens, bodyTokens, titleFreq, bodyFreq,
        totalTokens: bodyTokens.length,
      });
    }

    this.df = tokenDocCount;
  }

  findHeading(query: string): string[] {
    const q = query.toLowerCase().trim();
    // Exact heading match
    if (this.headingIndex.has(q)) return this.headingIndex.get(q)!;
    // Return ALL partial heading matches
    const allIds = new Set<string>();
    for (const [heading, ids] of this.headingIndex) {
      if (heading.includes(q) && q.length >= 3) {
        for (const id of ids) allIds.add(id);
      }
    }
    return [...allIds];
  }

  // Like findHeading but prefers word-boundary matches over substring-inside-word matches
  findHeadingSmart(query: string): string[] {
    const q = query.toLowerCase().trim();
    // Exact match first
    if (this.headingIndex.has(q)) return this.headingIndex.get(q)!;
    // Check for word-boundary match (heading starts with word, or contains " word")
    const wordBoundaryIds = new Set<string>();
    const substringIds = new Set<string>();
    for (const [heading, ids] of this.headingIndex) {
      if (heading === q || heading.startsWith(q + " ") || heading.startsWith(q + ",") || heading.includes(" " + q) || heading.includes(" " + q + ",") || heading.includes(" " + q + "'") || heading.includes(" " + q + "-")) {
        for (const id of ids) wordBoundaryIds.add(id);
      } else if (heading.includes(q) && q.length >= 3) {
        for (const id of ids) substringIds.add(id);
      }
    }
    // Prefer word-boundary matches; fall back to substring if none
    return wordBoundaryIds.size > 0 ? [...wordBoundaryIds] : [...substringIds];
  }

  findLinks(nodeId: string): string[] {
    const links = this.linkGraph.get(nodeId) ?? [];
    return links.map(l => l.targetFile);
  }

  metaFilter(field: string, value: string): Set<string> {
    return this.metaIndex.get(field)?.get(value.toLowerCase()) ?? new Set();
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

    // Detect query intent: if user asks about voice/voiced/character, boost those types
    const vaIntent = /voice|voiced|voiced by|speaks|language|va|seiyuu|japanese|caste|act(e|or|ress)/i.test(q);
    const charIntent = /character|personagem|personaje|char/i.test(q);
    const whoIntent = /who\s+(is|was|voices|voiced|plays|played|acts|acted|portrays|portrayed)/i.test(q);

    const scored: { entry: IndexEntry; score: number; matchedField: string }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      let matchedField = "";

      if (entry.node.title.toLowerCase() === q) { score = 100; matchedField = "title:exact"; }
      else if (entry.node.frontmatter.anilistId && String(entry.node.frontmatter.anilistId) === q) { score = 100; matchedField = "anilistId"; }
      else if (entry.node.frontmatter.mediaId && String(entry.node.frontmatter.mediaId) === q) { score = 100; matchedField = "mediaId"; }
      else if (entry.node.title.toLowerCase().includes(q)) { score = 80 + (q.length / (entry.node.title.length || 1)) * 15; matchedField = "title:contains"; }
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
        let norm = Math.min(65, bm25 * 12);
        // Boost if query intent matches node type
        if (vaIntent && (entry.node.type === "media_characters" || entry.node.type === "voice_actor_index")) norm += 15;
        if (charIntent && entry.node.type === "media_characters") norm += 10;
        if (whoIntent && entry.node.type === "media_characters") norm += 12;
        if (norm > score) { score = norm; matchedField = "bm25"; }
      }

      if (score < 15 && q.length >= 3) {
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

  private loadingPromise: Promise<void> | null = null;

  invalidate(): void {
    this.nodes = [];
    this.index = null;
    this.loaded = false;
    this.loadingPromise = null;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const folder = this.app.vault.getAbstractFileByPath(this.basePath);
      if (!folder) return;

      const files = this.getAllMarkdownFiles(folder);
      // Parallel file reads (batch of 20)
      const BATCH = 20;
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const nodes = await Promise.all(batch.map(f => this.parseFile(f)));
        for (const node of nodes) {
          if (node) this.nodes.push(node);
        }
      }
      this.loaded = true;
      this.index = new SearchIndex();
      this.index.build(this.nodes);
    })();

    return this.loadingPromise;
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
      if (!frontmatter?.anilistId && !frontmatter?.mediaId && frontmatter?.type !== "VOICE_ACTOR_INDEX") return null;

      const type = frontmatter.type as string;
      const normalizedType = TYPE_MAP[type] ?? type.toLowerCase() as VaultNode["type"];
      const entityId = frontmatter.anilistId ?? frontmatter.mediaId;
      const id = `${normalizedType}:${entityId}`;
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
    return h1 ? h1[1] : String(fm.anilistId ?? fm.mediaId ?? "unknown");
  }

  getLoadedCount(): number { return this.nodes.length; }
  getLoadedTitles(): string[] { return this.nodes.map((n) => n.title).sort(); }

  search(query: string): VaultSearchResult[] {
    if (!this.index) return [];
    const results = this.index.search(query);

    // Heading index: find the best heading match for any word in the query
    const queryWords = query.toLowerCase().trim().split(/[\s,.\-!?()]+/).filter(w => w.length > 2);
    if (queryWords.length > 0) {
      const headingHits: VaultSearchResult[] = [];
      const seenIds = new Set<string>();
      for (const word of queryWords) {
        const ids = this.index.findHeadingSmart(word);
        for (const id of ids) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          // Calculate match quality: prefer whole-word matches over substring matches
          const node = this.nodes.find(n => n.id === id);
          if (!node) continue;
          // Find the exact heading that matched for score quality
          const nodeHeadings = this.index.findHeading(word);
          const matchesWell = nodeHeadings.some(hid => hid === id);
          headingHits.push({ node, score: matchesWell ? 95 : 85, matchedField: `heading:${word}` });
        }
      }
      if (headingHits.length > 0) {
        // Link graph: also include files linked from matched files
        const linkedIds = new Set<string>();
        for (const h of headingHits) {
          for (const linked of this.index.findLinks(h.node.id)) {
            const linkedNode = this.nodes.find(n =>
              n.title.toLowerCase().includes(linked.toLowerCase()) ||
              n.path.toLowerCase().includes(linked.toLowerCase())
            );
            if (linkedNode && !headingHits.some(hh => hh.node.id === linkedNode.id)) linkedIds.add(linkedNode.id);
          }
        }
        for (const id of linkedIds) {
          const node = this.nodes.find(n => n.id === id);
          if (node) headingHits.push({ node, score: 65, matchedField: `link:${queryWords[0]}` });
        }
        return headingHits.slice(0, 10);
      }
    }

    // Metadata filter: detect type-specific queries
    const typeFilter = /anime|manga/i.test(query) ? (query.toLowerCase().includes("manga") ? "manga" : "anime") : null;
    const filteredResults = results.filter(r => {
      if (!typeFilter) return true;
      const nodeType = String(r.node.frontmatter.type ?? "").toLowerCase();
      const mediaType = String(r.node.frontmatter.mediaType ?? "").toLowerCase();
      return nodeType === typeFilter || mediaType === typeFilter || r.node.type === typeFilter;
    });

    // Multi-term fallback: when search gives low scores, find nodes containing ALL query terms
    const needsFallback = filteredResults.length === 0 || filteredResults[0].score < 30;
    if (needsFallback) {
      const tokens = query.toLowerCase().trim().split(/[\s,.\-!?()]+/).filter(t => t.length > 2);
      const jpTokens = [...query.toLowerCase()].filter(c => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(c));
      const allTerms = [...tokens, ...jpTokens];
      if (allTerms.length >= 2) {
        const fallback: VaultSearchResult[] = [];
        for (const node of this.nodes) {
          const allText = `${node.title} ${node.frontmatter.name ?? ""} ${node.frontmatter.nativeName ?? ""} ${node.frontmatter.voiceActors ?? ""} ${node.body}`.toLowerCase();
          const matchCount = allTerms.filter(t => allText.includes(t)).length;
          const ratio = matchCount / allTerms.length;
          if (ratio >= 0.5) {
            fallback.push({
              node,
              score: Math.round(40 + ratio * 40),
              matchedField: `multi:${allTerms.slice(0, 3).join("+")}${allTerms.length > 3 ? "..." : ""}`,
            });
          }
        }
        if (fallback.length > 0) {
          fallback.sort((a, b) => b.score - a.score);
          return fallback.slice(0, 20);
        }
      }
    }

    return results;
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

    for (const r of results.slice(0, 10)) {
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

      // Full body content — no truncation, no block selection
      const bodyLines = n.body.split("\n");
      for (const line of bodyLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("![") || trimmed.startsWith("|")) continue;
        lines.push(`  ${trimmed}`);
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
