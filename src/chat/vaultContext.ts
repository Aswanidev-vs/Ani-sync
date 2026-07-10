import { TFile, parseYaml } from "obsidian";
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
  matchedHeading?: string;
  matchedSection?: string;
}

type QueryMode = "entity" | "summary" | "report";

const TYPE_MAP: Record<string, VaultNode["type"]> = {
  ANIME: "anime", MANGA: "manga", STAFF: "staff",
  STUDIO: "studio", TAG: "tag", PROFILE: "profile",
  CHARACTER: "character", MEDIA_CHARACTERS: "media_characters",
  VOICE_ACTOR_INDEX: "voice_actor_index",
};

const TRIGRAM_SIZE = 3;

// Simple synonym expansion for common anime/manga terms
const SYNONYM_MAP: Record<string, string[]> = {
  "manga": ["novel", "light novel", "web novel", "ln"],
  "anime": ["tv", "ova", "ona", "movie", "film"],
  "finished": ["completed", "done"],
  "completed": ["finished"],
  "watching": ["current", "in progress"],
  "reading": ["current", "in progress"],
  "dropped": ["abandoned"],
  "best": ["highest rated", "top rated", "favorite"],
  "worst": ["lowest rated", "bottom rated"],
  "popular": ["trending", "most viewed"],
  "voice actor": ["seiyuu", "va", "cast"],
  "actor": ["seiyuu", "voice actor"],
  // Family relationships
  "kid": ["son", "daughter", "child", "children"],
  "child": ["son", "daughter", "kid", "children"],
  "children": ["son", "daughter", "kid", "child"],
  "son": ["kid", "child", "children"],
  "daughter": ["kid", "child", "children"],
  "father": ["dad", "parent"],
  "mother": ["mom", "parent"],
  "parent": ["father", "mother", "dad", "mom"],
  "husband": ["spouse", "partner"],
  "wife": ["spouse", "partner"],
  "sibling": ["brother", "sister"],
  "brother": ["sibling", "bro"],
  "sister": ["sibling", "sis"],
};

const QUERY_STOP_WORDS = new Set([
  "who", "what", "when", "where", "why", "how",
  "is", "was", "are", "were", "do", "does", "did",
  "tell", "me", "about", "the", "a", "an", "of",
  "in", "on", "at", "to", "from", "for", "and",
  "or", "please", "by", "series",
]);

// Stop words excluded from indexing to improve IDF discriminative power
const INDEX_STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "from", "for", "and", "or",
  "is", "was", "are", "were", "do", "does", "did", "has", "have", "had",
  "it", "its", "this", "that", "with", "by", "as", "but", "not", "be",
]);

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
    // Alphanumeric sequences (include hyphens and underscores as part of words)
    if (/[a-z0-9]/.test(lower[i])) {
      let word = "";
      while (i < lower.length && /[a-z0-9_\-]/.test(lower[i])) { word += lower[i]; i++; }
      // Trim trailing hyphens/underscores
      word = word.replace(/[-_]+$/, "");
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

function expandQuery(query: string): string {
  const q = query.toLowerCase();
  const words = q.split(/\s+/);
  const expanded = new Set<string>(words);

  // Check multi-word phrases first (longer matches take priority)
  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (key.includes(" ") && q.includes(key)) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }

  // Then check single words
  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }
  return [...expanded].join(" ");
}

function extractEntityCandidates(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  const candidates = new Set<string>();

  const patterns = [
    /who\s+is\s+(.+)/i,
    /tell\s+me\s+about\s+(.+)/i,
    /who\s+voices\s+(.+)/i,
    /who\s+voiced\s+(.+)/i,
    /what\s+is\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1]
        .trim()
        .replace(/\b(and|also|tell|about|use|series|anime|manga)\b.*$/i, "")
        .replace(/[?.!,]+$/g, "");
      if (cleaned) candidates.add(cleaned.toLowerCase());
    }
  }

  const tokens = tokenize(normalized).filter((token) => !QUERY_STOP_WORDS.has(token));
  if (tokens.length > 0) {
    candidates.add(tokens.join(" "));
  }
  if (tokens.length > 1) {
    for (let i = 0; i < tokens.length - 1; i++) {
      candidates.add(tokens.slice(i).join(" "));
      candidates.add(tokens.slice(0, tokens.length - i).join(" "));
    }
  }

  return [...candidates].filter((candidate) => candidate.length >= 2);
}

function detectQueryMode(query: string): QueryMode {
  const q = query.toLowerCase().trim();

  if (/(report|analysis|analyze|compare|comparison|overview|list all|all of|group by|breakdown|table|stats|statistics|trend|trends)/i.test(q)) {
    return "report";
  }

  if (/(tell me about|describe|details on|details about|summary of|summarize|what can you tell me about)/i.test(q)) {
    return "summary";
  }

  if (/(who is|who are|who voices|who voiced|what is)/i.test(q)) {
    return "entity";
  }

  return "entity";
}

function parseConstraints(query: string): ParsedConstraints {
  const q = query.toLowerCase();
  const statuses: string[] = [];
  if (/\bcompleted|finished\b/i.test(q)) statuses.push("completed");
  if (/\bwatching|current|in progress\b/i.test(q)) statuses.push("current");
  if (/\bplanned|plan to watch|plan to read\b/i.test(q)) statuses.push("planned");
  if (/\bdropped\b/i.test(q)) statuses.push("dropped");
  if (/\bpaused\b/i.test(q)) statuses.push("paused");
  if (/\brepeating|rewatching|rereading\b/i.test(q)) statuses.push("repeating");

  const collectAfter = (patterns: RegExp[]): string[] => {
    const out = new Set<string>();
    for (const pattern of patterns) {
      const match = query.match(pattern);
      if (match?.[1]) out.add(match[1].trim().replace(/[?.!,]+$/g, "").toLowerCase());
    }
    return [...out].filter(Boolean);
  };

  const genreKeywords = ["romance", "action", "comedy", "drama", "fantasy", "slice of life", "thriller", "mystery", "horror", "sports", "sci fi", "supernatural"];
  const genres = genreKeywords.filter((genre) => q.includes(genre));
  const scoreMatch = query.match(/\b(?:score|rated?|rating)\s*(?:above|over|>=|at least)?\s*(\d{1,2})\b/i);

  return {
    typeFilter: /\banime\b/i.test(q) ? "anime" : /\bmanga\b/i.test(q) ? "manga" : null,
    statuses,
    genres,
    tags: collectAfter([/\btag(?:s)?\s+(?:is|are|of|like)?\s*(.+)/i]),
    studios: collectAfter([/\bstudio\s+(.+)/i, /\bby studio\s+(.+)/i]),
    voiceActors: collectAfter([/\bvoic(?:e|ed) actor\s+(.+)/i, /\bseiyuu\s+(.+)/i, /\bvoiced by\s+(.+)/i]),
    characters: collectAfter([/\bcharacter\s+(.+)/i]),
    minScore: scoreMatch ? Number(scoreMatch[1]) : null,
  };
}

function extractAliases(node: VaultNode): string[] {
  const aliases = new Set<string>();
  aliases.add(node.title);

  if (node.frontmatter.name) aliases.add(String(node.frontmatter.name));
  if (node.frontmatter.nativeName) aliases.add(String(node.frontmatter.nativeName));

  const fmTitle = node.frontmatter.title as Record<string, unknown> | undefined;
  if (fmTitle) {
    for (const key of ["romaji", "english", "native"]) {
      const value = fmTitle[key];
      if (typeof value === "string" && value.trim()) aliases.add(value.trim());
    }
  }

  const mediaTitle = node.frontmatter.mediaTitle;
  if (typeof mediaTitle === "string" && mediaTitle.trim()) aliases.add(mediaTitle.trim());

  return [...aliases].filter((alias) => alias.trim().length > 0);
}

interface IndexEntry {
  node: VaultNode;
  titleTrigrams: Set<string>;
  bodyTrigrams: Set<string>;
  titleTokens: string[];
  bodyTokens: string[];
  aliases: string[];
  aliasTokens: string[][];
  headings: string[];
  headingTokens: string[][];
  titleFreq: Map<string, number>;
  bodyFreq: Map<string, number>;
  totalTokens: number;
  sections: SectionEntry[];
}

interface SectionEntry {
  heading: string;
  content: string;
  tokens: string[];
  trigrams: Set<string>;
  freq: Map<string, number>;
}

interface LinkInfo {
  sourceId: string;
  targetFile: string;
  text: string;
}

interface ParsedConstraints {
  typeFilter: "anime" | "manga" | null;
  statuses: string[];
  genres: string[];
  tags: string[];
  studios: string[];
  voiceActors: string[];
  characters: string[];
  minScore: number | null;
}

class SearchIndex {
  entries: IndexEntry[] = [];
  private df = new Map<string, number>();
  private totalDocs = 0;
  private avgDl = 1;
  private avgTitleLength = 1;
  // Heading index: lowercase heading → list of node ids
  private headingIndex = new Map<string, string[]>();
  // Link graph: node id → outgoing wikilinks
  private linkGraph = new Map<string, LinkInfo[]>();
  // Metadata index: frontmatter field name → value → set of node ids
  private metaIndex = new Map<string, Map<string, Set<string>>>();
  // Node lookup map for O(1) access
  private nodeMap = new Map<string, VaultNode>();
  // Title and path lookup maps for O(1) link graph resolution
  private titleMap = new Map<string, VaultNode>();
  private pathMap = new Map<string, VaultNode>();

  build(nodes: VaultNode[]): void {
    this.entries = [];
    this.df.clear();
    this.headingIndex.clear();
    this.linkGraph.clear();
    this.metaIndex.clear();
    this.nodeMap.clear();
    this.titleMap.clear();
    this.pathMap.clear();
    this.totalDocs = nodes.length;

    // Pre-compute token frequencies for IDF (excluding stop words)
    const tokenDocCount = new Map<string, number>();

    for (const node of nodes) {
      const titleStr = `${node.title} ${node.frontmatter.name ?? ""} ${node.frontmatter.nativeName ?? ""}`;
      const titleTokens = tokenize(titleStr);
      const bodyTokens = tokenize(node.body);

      const titleFreq = new Map<string, number>();
      const bodyFreq = new Map<string, number>();
      for (const t of titleTokens) titleFreq.set(t, (titleFreq.get(t) ?? 0) + 1);
      for (const t of bodyTokens) {
        if (!INDEX_STOP_WORDS.has(t)) {
          bodyFreq.set(t, (bodyFreq.get(t) ?? 0) + 1);
        }
      }

      const titleTrigrams = buildTrigrams(titleStr);
      const bodyTrigrams = buildTrigrams(node.body);
      const aliases = extractAliases(node);
      const aliasTokens = aliases.map((alias) => tokenize(alias));

      // Only count non-stop-word tokens for IDF
      const allTokens = new Set([...titleTokens, ...bodyTokens.filter(t => !INDEX_STOP_WORDS.has(t))]);
      for (const token of allTokens) {
        tokenDocCount.set(token, (tokenDocCount.get(token) ?? 0) + 1);
      }

      // Extract ## headings for heading index
      const lines = node.body.split("\n");
      const headings: string[] = [];
      for (const line of lines) {
        if (line.startsWith("## ")) {
          const headingRaw = line.slice(3).trim();
          const headingLower = headingRaw.toLowerCase();
          if (headingLower.length >= 2) {
            headings.push(headingRaw);
            if (!this.headingIndex.has(headingLower)) this.headingIndex.set(headingLower, []);
            this.headingIndex.get(headingLower)!.push(node.id);
          }
        }
      }
      const headingTokens = headings.map((heading) => tokenize(heading));
      const sections = this.extractSections(node.body);

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

      // Metadata index — index key fields for direct lookup
      const metaFields: [string, string][] = [];
      if (node.frontmatter.type) metaFields.push(["type", String(node.frontmatter.type).toLowerCase()]);
      if (node.frontmatter.mediaType) metaFields.push(["mediaType", String(node.frontmatter.mediaType).toLowerCase()]);
      if (node.frontmatter.status) metaFields.push(["status", String(node.frontmatter.status).toLowerCase()]);
      if (node.frontmatter.format) metaFields.push(["format", String(node.frontmatter.format).toLowerCase()]);
      if (node.frontmatter.listName) metaFields.push(["listName", String(node.frontmatter.listName).toLowerCase()]);
      if (node.frontmatter.score != null) metaFields.push(["score", String(node.frontmatter.score)]);
      if (node.frontmatter.averageScore != null) metaFields.push(["averageScore", String(node.frontmatter.averageScore)]);
      if (Array.isArray(node.frontmatter.voiceActors)) {
        for (const va of node.frontmatter.voiceActors) metaFields.push(["voiceActor", String(va).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.characters)) {
        for (const c of node.frontmatter.characters) metaFields.push(["character", String(c).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.studios)) {
        for (const s of node.frontmatter.studios) metaFields.push(["studio", String(s).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.staff)) {
        for (const p of node.frontmatter.staff) metaFields.push(["staff", String(p).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.genres)) {
        for (const g of node.frontmatter.genres) metaFields.push(["genre", String(g).toLowerCase()]);
      }
      if (Array.isArray(node.frontmatter.animeTags)) {
        for (const t of node.frontmatter.animeTags) metaFields.push(["tag", String(t).toLowerCase()]);
      }
      for (const [field, value] of metaFields) {
        if (!this.metaIndex.has(field)) this.metaIndex.set(field, new Map());
        const valMap = this.metaIndex.get(field)!;
        if (!valMap.has(value)) valMap.set(value, new Set());
        valMap.get(value)!.add(node.id);
      }

      this.entries.push({
        node, titleTrigrams, bodyTrigrams,
        titleTokens, bodyTokens, aliases, aliasTokens, headings, headingTokens, titleFreq, bodyFreq,
        totalTokens: bodyTokens.length,
        sections,
      });
    }

    this.df = tokenDocCount;

    // Pre-compute average document length, title length, and node maps
    this.avgDl = this.totalDocs > 0 ? this.entries.reduce((s, e) => s + e.totalTokens, 0) / this.totalDocs : 1;
    this.avgTitleLength = this.totalDocs > 0 ? this.entries.reduce((s, e) => s + e.titleTokens.length, 0) / this.totalDocs : 1;
    for (const entry of this.entries) {
      this.nodeMap.set(entry.node.id, entry.node);
      this.titleMap.set(entry.node.title.toLowerCase(), entry.node);
      const cleanPath = entry.node.path.toLowerCase().endsWith(".md")
        ? entry.node.path.toLowerCase().slice(0, -3)
        : entry.node.path.toLowerCase();
      this.pathMap.set(cleanPath, entry.node);
    }
  }

  private extractSections(body: string): SectionEntry[] {
    const lines = body.split("\n");
    const sections: SectionEntry[] = [];
    let currentHeading: string | null = null;
    let currentLines: string[] = [];

    const pushSection = () => {
      if (!currentHeading) return;
      const content = currentLines.join("\n").trim();
      const combined = `${currentHeading}\n${content}`.trim();
      const tokens = tokenize(combined);
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      sections.push({
        heading: currentHeading,
        content,
        tokens,
        trigrams: buildTrigrams(combined),
        freq,
      });
    };

    for (const line of lines) {
      if (line.startsWith("## ")) {
        pushSection();
        currentHeading = line.slice(3).trim();
        currentLines = [];
      } else if (currentHeading) {
        currentLines.push(line);
      }
    }
    pushSection();
    return sections;
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
      if (heading === q || heading.startsWith(q + " ") || heading.startsWith(q + ",") || heading.includes(" " + q) || heading.includes(" " + q + ",") || heading.includes(" " + q + "'")) {
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

  getNodeById(id: string): VaultNode | undefined {
    return this.nodeMap.get(id);
  }

  getNodeByTitle(title: string): VaultNode | undefined {
    return this.titleMap.get(title.toLowerCase());
  }

  getNodeByPath(path: string): VaultNode | undefined {
    return this.pathMap.get(path.toLowerCase());
  }

  metaFilter(field: string, value: string): Set<string> {
    return this.metaIndex.get(field)?.get(value.toLowerCase()) ?? new Set();
  }

  metaFilterContains(field: string, value: string): Set<string> {
    const fieldMap = this.metaIndex.get(field);
    if (!fieldMap) return new Set();
    const needle = value.toLowerCase();
    const out = new Set<string>();
    for (const [candidate, ids] of fieldMap) {
      // Word-boundary matching: needle must match as a complete word/phrase
      const parts = candidate.split(/[\s,]+/);
      if (parts.some(part => part === needle) || candidate === needle) {
        for (const id of ids) out.add(id);
      }
    }
    return out;
  }

  private idf(term: string): number {
    const docFreq = this.df.get(term) ?? 0;
    if (docFreq === 0) return 0;
    return Math.log((this.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
  }

  bm25Score(entry: IndexEntry, queryTokens: string[], k1 = 1.5, b = 0.75): number {
    let score = 0;
    for (const term of queryTokens) {
      const tfTitle = entry.titleFreq.get(term) ?? 0;
      const tfBody = entry.bodyFreq.get(term) ?? 0;
      const idf = this.idf(term);
      if (idf === 0) continue;
      const titleScore = (tfTitle * (k1 + 1)) / (tfTitle + k1 * (1 - b + b * (entry.titleTokens.length / (this.avgTitleLength || 1))));
      const bodyScore = (tfBody * (k1 + 1)) / (tfBody + k1 * (1 - b + b * (entry.totalTokens / (this.avgDl || 1))));
      score += idf * (titleScore * 3 + bodyScore);
    }
    return score;
  }

  search(query: string): VaultSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q || this.entries.length === 0) return [];

    // Expand query with synonyms
    const expandedQuery = expandQuery(q);
    const queryTrigrams = buildTrigrams(expandedQuery);
    const queryTokens = tokenize(expandedQuery);
    const entityCandidates = extractEntityCandidates(query);

    // Detect query intent: if user asks about voice/voiced/character, boost those types
    const vaIntent = /voice|voiced|voiced by|speaks|language|va|seiyuu|japanese|caste|act(e|or|ress)/i.test(q);
    const charIntent = /character|personagem|personaje|char/i.test(q);
    const whoIntent = /who\s+(is|was|voices|voiced|plays|played|acts|acted|portrays|portrayed)/i.test(q);

    const scored: { entry: IndexEntry; score: number; matchedField: string }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      let matchedField = "";

      // Exact match on title or IDs
      if (entry.node.title.toLowerCase() === q) { score = 100; matchedField = "title:exact"; }
      else if (entry.node.frontmatter.anilistId && String(entry.node.frontmatter.anilistId) === q) { score = 100; matchedField = "anilistId"; }
      else if (entry.node.frontmatter.mediaId && String(entry.node.frontmatter.mediaId) === q) { score = 100; matchedField = "mediaId"; }
      else if (entry.node.title.toLowerCase().includes(q)) { score = 80 + (q.length / (entry.node.title.length || 1)) * 15; matchedField = "title:contains"; }
      else if (entry.node.frontmatter.name && String(entry.node.frontmatter.name).toLowerCase().includes(q)) { score = 75; matchedField = "frontmatter:name"; }
      else if (entry.node.frontmatter.nativeName && String(entry.node.frontmatter.nativeName).toLowerCase().includes(q)) { score = 70; matchedField = "nativeName"; }

      // Also check expanded synonyms against title
      if (score < 70) {
        for (const word of expandedQuery.split(/\s+/)) {
          if (word !== q && entry.node.title.toLowerCase().includes(word)) {
            score = Math.max(score, 65);
            matchedField = "synonym:title";
          }
        }
      }

      if (score < 78) {
        for (const alias of entry.aliases) {
          const aliasLower = alias.toLowerCase();
          if (aliasLower === q) {
            score = Math.max(score, 96);
            matchedField = "alias:exact";
            break;
          }
          if (aliasLower.includes(q) || q.includes(aliasLower)) {
            score = Math.max(score, 82);
            matchedField = "alias:contains";
          }
        }
      }

      if (score < 70) {
        for (const section of entry.sections) {
          const overlap = queryTokens.filter((term) => section.tokens.includes(term)).length;
          if (overlap === 0) continue;
          const coverage = overlap / Math.max(1, queryTokens.length);
          const tri = jaccard(queryTrigrams, section.trigrams);
          const sectionScore = 68 + coverage * 12 + tri * 10;
          if (sectionScore > score) {
            score = sectionScore;
            matchedField = `section:${section.heading}`;
          }
        }

        for (let i = 0; i < entry.headingTokens.length; i++) {
          const headingTokens = entry.headingTokens[i];
          const matchedTerms = queryTokens.filter((term) => headingTokens.includes(term));
          if (matchedTerms.length === 0) continue;

          const coverage = matchedTerms.length / Math.max(1, queryTokens.length);
          const headingLengthPenalty = Math.min(1, matchedTerms.length / Math.max(1, headingTokens.length));
          const headingScore = 72 + coverage * 18 + headingLengthPenalty * 6;

          if (headingScore > score) {
            score = headingScore;
            matchedField = `heading_phrase:${entry.headings[i]}`;
          }
        }

        for (const entity of entityCandidates) {
          const entityTokens = tokenize(entity);
          if (entityTokens.length === 0) continue;
          for (let i = 0; i < entry.headingTokens.length; i++) {
            const headingTokens = entry.headingTokens[i];
            const exactCoverage = entityTokens.filter((term) => headingTokens.includes(term)).length;
            if (exactCoverage === 0) continue;

            const coverage = exactCoverage / entityTokens.length;
            const tightness = exactCoverage / Math.max(1, headingTokens.length);
            const exactPhrase = entry.headings[i].toLowerCase() === entity;
            const candidateScore = (exactPhrase ? 98 : 0) + 76 + coverage * 16 + tightness * 6;

            if (candidateScore > score) {
              score = candidateScore;
              matchedField = `heading_entity:${entry.headings[i]}`;
            }
          }
        }

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
          // Check for substring match first (most reliable)
          if (f.text.includes(q)) {
            const s = f.w * 0.8;
            if (s > score) { score = s; matchedField = `subseq:${f.f}`; }
            break;
          }
        }
      }
      
      if (score > 0) scored.push({ entry, score, matchedField });
    }

    scored.sort((a, b) => b.score - a.score);

    const reranked = scored.slice(0, 30).map((candidate) => {
      let rerankBoost = 0;
      for (const aliasTokens of candidate.entry.aliasTokens) {
        const overlap = queryTokens.filter((token) => aliasTokens.includes(token)).length;
        if (overlap > 0) {
          rerankBoost = Math.max(rerankBoost, overlap * 4 + (overlap === queryTokens.length ? 8 : 0));
        }
      }
      if (candidate.entry.node.type === "media_characters" && entityCandidates.length > 0) rerankBoost += 4;
      if (candidate.matchedField.startsWith("alias:")) rerankBoost += 6;
      return { ...candidate, score: candidate.score + rerankBoost };
    });

    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, 20).map((s) => {
      let matchedHeading: string | undefined;
      let matchedSection: string | undefined;
      if (s.matchedField.startsWith("heading_phrase:")) {
        matchedHeading = s.matchedField.slice("heading_phrase:".length);
      } else if (s.matchedField.startsWith("heading_entity:")) {
        matchedHeading = s.matchedField.slice("heading_entity:".length);
      } else if (s.matchedField.startsWith("section:")) {
        matchedHeading = s.matchedField.slice("section:".length);
      }
      if (matchedHeading) {
        const matched = s.entry.sections.find((section) => section.heading.toLowerCase() === matchedHeading!.toLowerCase());
        matchedSection = matched ? `## ${matched.heading}\n${matched.content}`.trim() : undefined;
      }
      return { node: s.entry.node, score: s.score, matchedField: s.matchedField, matchedHeading, matchedSection };
    });
  }
 }
export class VaultContext {
  private app: App;
  private basePath: string;
  private nodes: VaultNode[] = [];
  private loaded = false;
  private index: SearchIndex | null = null;
  private loadGeneration = 0;

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
    this.loadGeneration++;
  }

  async load(onProgress?: (msg: string) => void): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    const generation = ++this.loadGeneration;
    this.loadingPromise = (async () => {
      try {
        const folder = this.app.vault.getAbstractFileByPath(this.basePath);
        if (!folder) { onProgress?.("Folder not found"); return; }

        const files = this.getAllMarkdownFiles(folder);
        onProgress?.(`Found ${files.length} files`);
        // Parallel file reads (batch of 20)
        const BATCH = 20;
        const newNodes: VaultNode[] = [];
        for (let i = 0; i < files.length; i += BATCH) {
          // Check if this load was invalidated
          if (generation !== this.loadGeneration) return;
          const batch = files.slice(i, i + BATCH);
          const nodes = await Promise.all(batch.map(f => this.parseFile(f)));
          for (const node of nodes) {
            if (node) newNodes.push(node);
          }
          onProgress?.(`Read ${Math.min(i + BATCH, files.length)}/${files.length} files (${newNodes.length} indexed)`);
        }
        // Check if this load was invalidated before finalizing
        if (generation !== this.loadGeneration) return;
        this.nodes = newNodes;
        onProgress?.("Building search index...");
        this.index = new SearchIndex();
        this.index.build(this.nodes);
        this.loaded = true;
        onProgress?.("Index ready — " + this.nodes.length + " entries indexed");
      } finally {
        if (generation === this.loadGeneration) this.loadingPromise = null;
      }
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
      const mediaIds = Array.isArray(frontmatter?.mediaIds) ? frontmatter.mediaIds : [];
      const hasEntityId = frontmatter?.anilistId != null || frontmatter?.mediaId != null || mediaIds.length > 0;
      if (!hasEntityId && frontmatter?.type !== "VOICE_ACTOR_INDEX") return null;

      const type = frontmatter.type as string;
      const normalizedType = TYPE_MAP[type] ?? type.toLowerCase() as VaultNode["type"];
      const entityId = frontmatter.anilistId ?? frontmatter.mediaId ?? mediaIds.join(",") ?? file.path;
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
    try {
      const fm = parseYaml(match[1]) ?? {};
      return { frontmatter: fm, body: content.slice(match[0].length).trim() };
    } catch {
      return { frontmatter: {}, body: content.slice(match[0].length).trim() };
    }
  }

  private extractTitle(fm: Record<string, unknown>, body: string): string {
    if (fm.title) {
      if (typeof fm.title === "string") return fm.title;
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
    const constraints = parseConstraints(query);

    // Heading index: find the best heading match for any word in the query
    const queryWords = query.toLowerCase().trim().split(/[\s,.\-!?()]+/).filter(w => w.length > 2);
    const entityCandidates = extractEntityCandidates(query);
    const headingHits: VaultSearchResult[] = [];
    if (queryWords.length > 0) {
      const seenIds = new Set<string>();
      const headingScores = new Map<string, { score: number; heading: string; field: string }>();

      for (const candidate of entityCandidates) {
        const candidateTokens = tokenize(candidate);
        if (candidateTokens.length === 0) continue;

        for (const node of this.nodes) {
          const sections = node.body.split("\n").filter((line) => line.startsWith("## "));
          for (const section of sections) {
            const heading = section.slice(3).trim();
            const headingTokens = tokenize(heading);
            const overlap = candidateTokens.filter((token) => headingTokens.includes(token)).length;
            if (overlap === 0) continue;

            const exact = heading.toLowerCase() === candidate;
            const coverage = overlap / candidateTokens.length;
            const compactness = overlap / Math.max(1, headingTokens.length);
            const score = (exact ? 99 : 82) + coverage * 10 + compactness * 4;
            const prev = headingScores.get(node.id);
            if (!prev || score > prev.score) {
              headingScores.set(node.id, { score, heading, field: exact ? `heading:exact:${candidate}` : `heading:entity:${candidate}` });
            }
          }
        }
      }

      for (const [nodeId, info] of headingScores) {
        const node = this.index.getNodeById(nodeId);
        if (!node) continue;
        seenIds.add(node.id);
        headingHits.push({ node, score: info.score, matchedField: info.field, matchedHeading: info.heading });
      }

      for (const word of queryWords) {
        const ids = this.index.findHeadingSmart(word);
        for (const id of ids) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const node = this.index.getNodeById(id);
          if (!node) continue;
          const nodeHeadings = this.index.findHeading(word);
          const matchesWell = nodeHeadings.some(hid => hid === id);
          headingHits.push({ node, score: matchesWell ? 95 : 85, matchedField: `heading:${word}`, matchedHeading: word });
        }
      }

      // Link graph: also include files linked from matched files
      if (headingHits.length > 0) {
        const linkedIds = new Set<string>();
        for (const h of headingHits) {
          for (const linked of this.index.findLinks(h.node.id)) {
            // O(1) lookup via titleMap/pathMap instead of O(N) linear scan
            const linkedNode = this.index.getNodeByTitle(linked) ?? this.index.getNodeByPath(linked);
            if (linkedNode && !headingHits.some(hh => hh.node.id === linkedNode.id)) linkedIds.add(linkedNode.id);
          }
        }
        for (const id of linkedIds) {
          const node = this.index.getNodeById(id);
          if (node) headingHits.push({ node, score: 65, matchedField: `link:${queryWords[0]}`, matchedHeading: queryWords[0] });
        }
      }
    }

    // Merge heading hits with main search results (heading hits get a boost)
    let allResults = [...results];
    if (headingHits.length > 0) {
      const existingIds = new Set(results.map(r => r.node.id));
      for (const hit of headingHits) {
        if (existingIds.has(hit.node.id)) {
          // Boost existing result
          const existing = allResults.find(r => r.node.id === hit.node.id);
          if (existing) {
            existing.score = Math.max(existing.score, hit.score);
            if (hit.matchedHeading) existing.matchedHeading = hit.matchedHeading;
          }
        } else {
          allResults.push(hit);
        }
      }
    }

    // Metadata filter: detect type-specific and structured queries
    let filteredResults = allResults.filter(r => {
      if (!constraints.typeFilter) return true;
      const nodeType = String(r.node.frontmatter.type ?? "").toLowerCase();
      const mediaType = String(r.node.frontmatter.mediaType ?? "").toLowerCase();
      return nodeType === constraints.typeFilter || mediaType === constraints.typeFilter || r.node.type === constraints.typeFilter;
    });

    const constrainedIds = new Set<string>();
    const addConstraintMatches = (field: string, values: string[]) => {
      for (const value of values) {
        for (const id of this.index!.metaFilterContains(field, value)) constrainedIds.add(id);
      }
    };
    addConstraintMatches("genre", constraints.genres);
    addConstraintMatches("tag", constraints.tags);
    addConstraintMatches("studio", constraints.studios);
    addConstraintMatches("voiceActor", constraints.voiceActors);
    addConstraintMatches("character", constraints.characters);
    if (constraints.statuses.length > 0) addConstraintMatches("status", constraints.statuses);

    if (constrainedIds.size > 0) {
      filteredResults = filteredResults
        .filter((r) => constrainedIds.has(r.node.id) || r.score >= 80)
        .map((r) => ({
          ...r,
          score: constrainedIds.has(r.node.id) ? r.score + 18 : r.score,
          matchedField: constrainedIds.has(r.node.id) ? `${r.matchedField}+meta` : r.matchedField,
        }));
    }

    if (constraints.minScore != null) {
      filteredResults = filteredResults.filter((r) => {
        const userScore = Number(r.node.frontmatter.score ?? -1);
        return !Number.isNaN(userScore) && userScore >= constraints.minScore!;
      });
    }

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

    return filteredResults.length > 0 ? filteredResults : allResults;
  }

  getAllMedia(): VaultNode[] { return this.nodes.filter((n) => n.type === "anime" || n.type === "manga"); }

  getStaffWorks(name: string): VaultNode[] {
    const q = name.toLowerCase().trim();
    if (!q) return [];
    return this.nodes.filter((n) => n.body.toLowerCase().includes(q) && (n.type === "anime" || n.type === "manga"));
  }

  buildPromptContext(results: VaultSearchResult[], mode: QueryMode = "entity"): string {
    if (results.length === 0) return "No matching data found in your AniList library.";

    // Token budget: ~4 chars per token, cap at ~6000 tokens for context safety
    const MAX_CHARS = 24000;
    let totalChars = 0;

    const header = mode === "report"
      ? "The following data is from the user's synced AniList library (vault). Build a structured, comprehensive answer only from this information. Aggregate across results when needed."
      : mode === "summary"
        ? "The following data is from the user's synced AniList library (vault). Give a concise but complete answer using only this information."
        : "The following data is from the user's synced AniList library (vault). Answer ONLY from this information. Do not say you can only answer from this information - just answer directly.";
    totalChars += header.length + 5; // +5 for "---\n"

    const parts = [header, "---"];
    const limit = mode === "report" ? 15 : mode === "summary" ? 8 : 10;

    for (const r of results.slice(0, limit)) {
      const n = r.node;
      const lines: string[] = [];
      lines.push(`${n.type.toUpperCase()}: "${n.title}"`);
      if (n.frontmatter.type) lines.push(`  Media Type: ${n.frontmatter.type}`);
      if (n.frontmatter.format) lines.push(`  Format: ${n.frontmatter.format}`);
      if (n.frontmatter.status) lines.push(`  Status: ${n.frontmatter.status}`);
      if (n.frontmatter.score != null) lines.push(`  User Score: ${n.frontmatter.score}/10`);
      if (n.frontmatter.averageScore != null) lines.push(`  Average Score: ${n.frontmatter.averageScore}/100`);
      if (n.frontmatter.episodes != null) lines.push(`  Episodes: ${n.frontmatter.episodes}`);
      if (n.frontmatter.chapters != null) lines.push(`  Chapters: ${n.frontmatter.chapters} | Volumes: ${n.frontmatter.volumes ?? "?"}`);
      if (n.frontmatter.duration) lines.push(`  Duration: ${n.frontmatter.duration} min`);
      if (n.frontmatter.genres) lines.push(`  Genres: ${Array.isArray(n.frontmatter.genres) ? n.frontmatter.genres.join(", ") : n.frontmatter.genres}`);
      if (n.frontmatter.language) lines.push(`  Language: ${n.frontmatter.language}`);
      if (n.frontmatter.animeTags && Array.isArray(n.frontmatter.animeTags)) lines.push(`  Tags: ${n.frontmatter.animeTags.join(", ")}`);
      if (n.frontmatter.listName) lines.push(`  List: ${n.frontmatter.listName}`);
      if (n.frontmatter.progress != null) lines.push(`  Progress: ${n.frontmatter.progress}`);
      if (n.frontmatter.anilistUrl) lines.push(`  URL: ${n.frontmatter.anilistUrl}`);

      const bodyLines = this.extractRelevantBodyLines(n.body, r.matchedHeading, r.matchedSection, mode);
      for (const line of bodyLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("![") || trimmed.startsWith("|")) continue;
        lines.push(`  ${trimmed}`);
      }

      const entry = lines.join("\n");
      totalChars += entry.length + 5; // +5 for "---\n"
      if (totalChars > MAX_CHARS) break;
      parts.push(entry);
      parts.push("---");
    }
    return parts.join("\n");
  }

  async buildContextForQuery(query: string): Promise<string> {
    await this.load();
    const mode = detectQueryMode(query);
    const results = this.selectResultsForMode(query, mode);
    return this.buildPromptContext(results, mode);
  }

  private selectResultsForMode(query: string, mode: QueryMode): VaultSearchResult[] {
    const baseResults = this.search(query);
    if (mode === "entity") return baseResults;

    if (mode === "summary") {
      const deduped = new Map<string, VaultSearchResult>();
      for (const result of baseResults) {
        if (!deduped.has(result.node.id)) deduped.set(result.node.id, result);
      }
      return [...deduped.values()].slice(0, 8);
    }

    const queryTokens = tokenize(expandQuery(query));
    const media = this.getAllMedia();
    const reportResults: VaultSearchResult[] = [];
    const seen = new Set<string>();

    for (const result of baseResults) {
      if (!seen.has(result.node.id)) {
        reportResults.push(result);
        seen.add(result.node.id);
      }
    }

    for (const node of media) {
      if (seen.has(node.id)) continue;
      const text = `${node.title} ${node.body} ${JSON.stringify(node.frontmatter)}`.toLowerCase();
      const overlap = queryTokens.filter((token) => text.includes(token)).length;
      if (overlap >= Math.max(1, Math.min(2, queryTokens.length))) {
        reportResults.push({
          node,
          score: 35 + overlap * 8,
          matchedField: "report:aggregate",
        });
        seen.add(node.id);
      }
      if (reportResults.length >= 15) break;
    }

    reportResults.sort((a, b) => b.score - a.score);
    return reportResults.slice(0, 15);
  }

  private extractRelevantBodyLines(body: string, matchedHeading?: string, matchedSection?: string, mode: QueryMode = "entity"): string[] {
    const lines = body.split("\n");
    if (mode === "report") {
      return lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return trimmed.startsWith("#")
          || trimmed.startsWith("**Status:**")
          || trimmed.startsWith("**Score:**")
          || trimmed.startsWith("**Progress:**")
          || trimmed.startsWith("## Synopsis")
          || trimmed.startsWith("## Genres")
          || trimmed.startsWith("## Tags")
          || trimmed.startsWith("## Studios")
          || trimmed.startsWith("## Staff")
          || trimmed.startsWith("- ");
      }).slice(0, 80);
    }

    if (mode === "summary" && !matchedSection && !matchedHeading) {
      return lines.filter((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith("#")
          || trimmed.startsWith("**Status:**")
          || trimmed.startsWith("**Score:**")
          || trimmed.startsWith("**Progress:**")
          || trimmed.startsWith("## ")
          || trimmed.startsWith("- ");
      }).slice(0, 50);
    }

    if (matchedSection) {
      const prelude = lines.slice(0, Math.min(lines.length, 10)).filter((line) => line.startsWith("# ") || line.startsWith("**Status:**") || line.startsWith("**Score:**"));
      return [...prelude, "", ...matchedSection.split("\n")];
    }
    if (!matchedHeading) return lines;

    const normalizedHeading = matchedHeading.toLowerCase().trim();
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ") && line.slice(3).trim().toLowerCase().includes(normalizedHeading)) {
        start = i;
        break;
      }
    }

    if (start === -1) return lines;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        end = i;
        break;
      }
    }

    const prelude = lines.slice(0, Math.min(lines.length, 10)).filter((line) => line.startsWith("# ") || line.startsWith("**Status:**") || line.startsWith("**Score:**"));
    return [...prelude, "", ...lines.slice(start, end)];
  }
}
