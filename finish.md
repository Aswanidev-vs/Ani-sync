# Ani-sync — Implementation & Changes Log

## Overview

An Obsidian plugin that syncs AniList anime/manga lists into vault as wikilinked markdown notes + AI chat assistant with hybrid search engine.

---

## Implemented Features

### 1. Sync Engine (`src/sync/engine.ts` — cousin's implementation)
- Incremental sync via updatedAt diff
- SHA-256 content hashing for idempotent writes
- Concurrent writes (8) / deletes (4) / character fetches (4)
- Orphan file cleanup on rename (old path deleted before new write)
- Character/folder progress tracking
- Cache in `data.json` (summary, details, noteHashes, paths)

### 2. Note Builder (`src/notes/builder.ts` — cousin's implementation)
- **7 artifact types:** Anime, Manga, Characters (per-anime), Studios, Staff, Tags, Profile, Voice-Actors MOC
- **Per-anime character files:** `Characters/<slug>.md` — all characters + VAs per series in one file
- **VoiceActors MOC:** `Voice-Actors.md` — all VAs mapped to their character files
- **Merged character artifacts:** Same-slug media (e.g., Naruto S1 + S2) merged into one character file
- Character frontmatter: `voiceActors: [...]` tag array, `mediaType`
- Wikilinks between all entities for graph view
- Frontmatter with full metadata (score, progress, episodes, status)

### 3. AniList GraphQL Client (`src/anilist/client.ts` — cousin's with our Japanese VA filter)
- **Adaptive rate limiting:** 400ms/700ms/1500ms tiers based on `x-ratelimit-remaining` header
- **Japanese VA filtering:** Fetches all VAs, keeps only Japanese-tagged ones, falls back to all if none tagged
- Retry logic: 3 attempts on 429 (respects Retry-After) and 5xx (exponential backoff)
- Character fetch with pagination (50 per page, up to 50 pages)

### 4. Graph Colors (`src/main.ts` — cousin's implementation)
- Writes color groups to `.obsidian/graph.json`
- Folder-based queries: `path:Ani-sync/Anime/`
- 6 node types with hex color pickers in Settings
- Apply button to update graph.json

### 5. OAuth (`src/auth/`)
- Implicit OAuth flow via GitHub Pages callback
- Token received via postMessage
- Auto-verify connection by fetching viewer
- Origin validation for security

### 6. Search Engine (`src/chat/vaultContext.ts` — our implementation)
**Hybrid search with 5 layers:**

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Exact match | Title, anilistId, mediaId | Instant for known names/IDs |
| Substring | Title, name, nativeName contains query | Quick partial lookup |
| Trigram Jaccard | 3-char subsequence overlap | Typo-tolerant matching |
| BM25 ranking | TF-IDF with field weighting (title 3x body) | Statistical relevance |
| Multi-term fallback | Word-level intersection across all nodes | Relationship queries |

**Key features:**
- **Full body indexing:** Reads entire .md file content (not just frontmatter)
- **Full body in LLM context:** All body text sent to LLM (no bullet-point-only truncation)
- **Concurrency-safe loading:** Uses shared promise to prevent double-initialization
- **Cache invalidation:** `invalidate()` clears index after sync
- **Indexes all types:** Including cousin's `Characters/*.md` (via `mediaId`), `Voice-Actors.md`, anime/manga/staff/studios/tags/profile

### 7. Chat UI (`src/chat/view.ts` — our implementation)
- **Typewriter animation:** Character-by-character via requestAnimationFrame, batched rendering
- **Blinking cursor:** Shown during streaming, removed on completion
- **Quick response system:** Greetings/thanks/bye/help replied instantly without API call
- **Error handling:** User-friendly messages for DNS failure, 401, 429, timeout
- **Pre-loading:** Vault context loaded in background when chat opens
- **Logo:** Displayed as background image in welcome screen, removed on first message
- **Markdown rendering:** Full markdown via Obsidian's MarkdownRenderer

### 8. Settings (`src/settingsTab.ts` — cousin's with our OpenRouter)
- AniList Connection (OAuth status, connect/disconnect)
- Sync info (username, last sync stats)
- Sync settings (output folder, auto-sync interval)
- OpenRouter AI (API key, model selector, fetch models)
- Graph Colors (6 color pickers + Apply button)
- Actions (sync now, clear cache)

---

## Changes from Previous Architecture

### What was removed
- **Per-character files:** Old per-character approach replaced by per-anime character files
- **Voice-Actors folder:** Separate VA files removed, merged into character files or Voice-Actors.md MOC
- **CSS-injected graph colors:** Replaced by graph.json-based coloring
- **context.ts:** Dead code removed
- **voiceactor VaultNode type:** Removed since no separate VA files

### What was added
- **Characters/<slug>.md:** Per-anime character files with all VAs inlined
- **Voice-Actors.md:** Root-level MOC listing all VAs with links to character files
- **Merged character artifacts:** Same-slug media merged into one character file
- **mediaId support:** vaultContext.indexes files with mediaId (character files)
- **Adaptive rate limiting:** Dynamic interval based on API response headers

### What was kept (our LLM improvements)
- Trigram + BM25 + FTS search engine
- Full body reading and context
- Typewriter animation
- Quick response system
- Error handling
- Pre-loading
- Multi-term fallback search

---

## Files Modified

| File | Change |
|------|--------|
| `src/chat/vaultContext.ts` | Added `media_characters`, `voice_actor_index` types; parseFile accepts `mediaId` filter; search handles `mediaId` |
| `src/chat/view.ts` | Logo import from logo.ts; backgroundImage in welcome; removeWelcome clears background |
| `src/main.ts` | applyGraphColors via graph.json; invalidateChatContext; orphan VA cleanup in sync |
| `src/settingsTab.ts` | GraphColors section with Apply button |
| `src/settings.ts` | DEFAULT_GRAPH_COLORS extracted |
| `src/notes/builder.ts` | Per-anime character files; merged artifacts; Voice-Actors.md MOC |
| `src/sync/engine.ts` | Character fetch for all cached entries; orphan VA cleanup |
| `src/anilist/client.ts` | Adaptive rate limiting; Japanese VA filter |
| `src/anilist/queries.ts` | Removed language: JAPANESE filter from query |
| `src/openrouter/client.ts` | Minor |
| `src/chat/logo.ts` | New — logo data URL |
| `assets/logo.png` | New — logo asset |

---

## Architecture Flow

```
AniList API
  → SyncEngine (adaptive rate limit, concurrent fetch)
    → notes/builder.ts (7 artifact types, per-anime characters)
      → Vault (.md files with frontmatter + wikilinks + SHA-256)
        → data.json (cache + settings + graph colors)
          → ChatView onOpen() → preloadVaultContext()
            → vaultContext.load() → SearchIndex.build() (trigrams + BM25)
              → handleSend() → search() → buildPromptContext(full body)
                → sendChatStream(OpenRouter) → typewriter animation → rendered markdown
```

## Platform Support

- Windows, macOS, Linux
- Mobile (not desktop only)
- Requires Obsidian v1.4.0+
- Internet required for initial OAuth, sync, and OpenRouter API calls
- Search works fully offline after sync
