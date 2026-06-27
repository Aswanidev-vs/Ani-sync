import type { AnisyncCache } from "../sync/cache";
import type { MediaDetail } from "../types";
import { fuzzyScore } from "./vaultContext";

export interface SearchResult {
  key: string;
  media: MediaDetail;
  score: number;
  matchedField: string;
}

export function searchNodes(query: string, cache: AnisyncCache): SearchResult[] {
  const q = query.toLowerCase().trim();
  if (!q || !cache.details) return [];

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

  const results: SearchResult[] = [];

  for (const [key, media] of Object.entries(cache.details)) {
    if (!media) continue;
    let bestScore = 0;
    let matchedField = "";

    // 1. Direct whole-phrase matches
    const titleFields = [media.title?.romaji, media.title?.english, media.title?.native, media.title?.userPreferred];
    for (const t of titleFields) {
      if (!t) continue;
      const tl = t.toLowerCase();
      if (tl === q) {
        bestScore = 100;
        matchedField = "title:exact";
        break;
      }
      if (tl.includes(q) && q.length >= 2) {
        const score = Math.min(90, 50 + (q.length / tl.length) * 40);
        if (score > bestScore) {
          bestScore = score;
          matchedField = "title:partial";
        }
      }
    }

    if (bestScore < 100) {
      const staffEdges = media.staff?.edges ?? [];
      for (const edge of staffEdges) {
        const name = edge?.node?.name;
        const full = name?.full ?? "";
        const native = name?.native ?? "";
        const role = edge?.role ?? "";
        if (full.toLowerCase().includes(q) || native.toLowerCase().includes(q)) {
          const s = Math.max(bestScore, 70);
          if (s > bestScore) {
            bestScore = s;
            matchedField = `staff:${role || full}`;
          }
        }
      }

      const studioEdges = media.studios?.edges ?? [];
      for (const edge of studioEdges) {
        const name = edge?.node?.name ?? "";
        if (name.toLowerCase().includes(q)) {
          const s = Math.max(bestScore, 60);
          if (s > bestScore) {
            bestScore = s;
            matchedField = `studio:${name}`;
          }
        }
      }

      const genres = media.genres ?? [];
      for (const genre of genres) {
        if (genre.toLowerCase().includes(q)) {
          const s = Math.max(bestScore, 40);
          if (s > bestScore) {
            bestScore = s;
            matchedField = `genre:${genre}`;
          }
        }
      }

      const tags = media.tags ?? [];
      for (const tag of tags) {
        if (tag?.name?.toLowerCase().includes(q)) {
          const s = Math.max(bestScore, 35);
          if (s > bestScore) {
            bestScore = s;
            matchedField = `tag:${tag.name}`;
          }
        }
      }

      if (media.description?.toLowerCase().includes(q)) {
        const s = Math.max(bestScore, 20);
        if (s > bestScore) {
          bestScore = s;
          matchedField = "description";
        }
      }
    }

    // 2. Keyword-based matching
    let keywordScore = 0;
    let matchedKeywordsCount = 0;
    const matchedFieldsList: string[] = [];

    for (const word of keywords) {
      let bestWordScore = 0;
      let bestWordField = "";

      // Title keyword check
      for (const t of titleFields) {
        if (t) {
          const tFuzzy = fuzzyScore(t, word);
          if (tFuzzy > bestWordScore) {
            bestWordScore = tFuzzy * 40;
            bestWordField = "title";
          }
        }
      }

      // Staff keyword check
      const staffEdges = media.staff?.edges ?? [];
      for (const edge of staffEdges) {
        const name = edge?.node?.name;
        if (name) {
          const full = name.full ?? "";
          const native = name.native ?? "";
          const fullFuzzy = fuzzyScore(full, word);
          const nativeFuzzy = fuzzyScore(native, word);
          const maxFuzzy = Math.max(fullFuzzy, nativeFuzzy);
          if (maxFuzzy > bestWordScore) {
            bestWordScore = maxFuzzy * 30;
            bestWordField = "staff";
          }
        }
      }

      // Studio keyword check
      const studioEdges = media.studios?.edges ?? [];
      for (const edge of studioEdges) {
        const name = edge?.node?.name ?? "";
        const studioFuzzy = fuzzyScore(name, word);
        if (studioFuzzy > bestWordScore) {
          bestWordScore = studioFuzzy * 25;
          bestWordField = "studio";
        }
      }

      // Genre keyword check
      const genres = media.genres ?? [];
      for (const genre of genres) {
        const genreFuzzy = fuzzyScore(genre, word);
        if (genreFuzzy > bestWordScore) {
          bestWordScore = genreFuzzy * 15;
          bestWordField = "genre";
        }
      }

      // Tag keyword check
      const tags = media.tags ?? [];
      for (const tag of tags) {
        const name = tag?.name ?? "";
        const tagFuzzy = fuzzyScore(name, word);
        if (tagFuzzy > bestWordScore) {
          bestWordScore = tagFuzzy * 15;
          bestWordField = "tag";
        }
      }

      // Description keyword check
      if (media.description?.toLowerCase().includes(word)) {
        if (10 > bestWordScore) {
          bestWordScore = 10;
          bestWordField = "description";
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
      const finalKeywordScore = keywordScore * matchRatio;
      bestScore = Math.max(bestScore, Math.min(95, finalKeywordScore));
      if (matchedFieldsList.length > 0 && !matchedField) {
        matchedField = `keywords(${Array.from(new Set(matchedFieldsList)).slice(0, 2).join(",")})`;
      }
    }

    if (bestScore > 0) {
      results.push({ key, media, score: bestScore, matchedField });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 15);
}

export function buildPromptContext(results: SearchResult[]): string {
  if (results.length === 0) return "No matching data found in your AniList library.";

  const parts: string[] = [
    "The following data is from the user's synced AniList library. Answer the user's question using ONLY this information.",
    "---",
  ];

  for (const r of results) {
    const m = r.media;
    const lines: string[] = [];

    const title = m.title?.userPreferred || m.title?.romaji || m.title?.english || "Unknown";
    lines.push(`Media: "${title}" (ID: ${m.id})`);
    lines.push(`  Type: ${m.type}  |  Format: ${m.format ?? "?"}  |  Status: ${m.status ?? "?"}`);
    if (m.averageScore != null) lines.push(`  Score: ${m.averageScore}  |  Popularity: ${m.popularity ?? "?"}`);
    if (m.episodes != null) lines.push(`  Episodes: ${m.episodes}`);
    if (m.chapters != null) lines.push(`  Chapters: ${m.chapters}  |  Volumes: ${m.volumes ?? "?"}`);
    if (m.genres && m.genres.length > 0) lines.push(`  Genres: ${m.genres.join(", ")}`);
    if (m.tags && m.tags.length > 0) {
      const tagNames = m.tags.filter((t) => t?.name).map((t) => t.name);
      lines.push(`  Tags: ${tagNames.join(", ")}`);
    }

    const staffEdges = m.staff?.edges ?? [];
    if (staffEdges.length > 0) {
      const staffList = staffEdges
        .filter((e) => e?.node?.name)
        .map((e) => `${e.node.name.full ?? e.node.name.native} (${e.role ?? "staff"})`);
      lines.push(`  Staff: ${staffList.join("; ")}`);
    }

    const studioEdges = m.studios?.edges ?? [];
    if (studioEdges.length > 0) {
      const studioNames = studioEdges
        .filter((e) => e?.node?.name)
        .map((e) => e.node.name);
      lines.push(`  Studios: ${studioNames.join(", ")}`);
    }

    const relationEdges = m.relations?.edges ?? [];
    if (relationEdges.length > 0) {
      const relList = relationEdges
        .filter((e) => e?.node?.title)
        .map((e) => {
          const rt = e.node.title.userPreferred ?? e.node.title.romaji ?? "?";
          return `${e.relationType} → "${rt}"`;
        });
      lines.push(`  Relations: ${relList.join("; ")}`);
    }

    lines.push(`  Matched via: ${r.matchedField}`);
    parts.push(lines.join("\n"));
    parts.push("---");
  }

  return parts.join("\n");
}

export function getStaffWorks(name: string, cache: AnisyncCache): { key: string; media: MediaDetail; role: string }[] {
  const q = name.toLowerCase().trim();
  if (!q || !cache.details) return [];

  const results: { key: string; media: MediaDetail; role: string }[] = [];

  for (const [key, media] of Object.entries(cache.details)) {
    if (!media) continue;
    const staffEdges = media.staff?.edges ?? [];
    for (const edge of staffEdges) {
      const full = edge?.node?.name?.full ?? "";
      const native = edge?.node?.name?.native ?? "";
      if (full.toLowerCase().includes(q) || native.toLowerCase().includes(q)) {
        results.push({ key, media, role: edge?.role ?? "staff" });
      }
    }
  }

  return results;
}
