# Ani-sync

<p align="center">
  <img src="assets/logo.png" alt="Ani-sync Logo" width="120" height="120"/>
</p>

An Obsidian plugin that syncs your [AniList](https://anilist.co/) anime & manga lists into your vault as wikilinked markdown notes, so they show up in Obsidian's graph view. Includes an AI-powered chat assistant to query your library using natural language.

## Features

- **One-click AniList OAuth** via a small GitHub Pages callback page.
- **Incremental, idempotent syncs** — SHA-256-based change detection means a steady-state sync takes ~3 GraphQL calls and 0 writes in under a second.
- **Manual + periodic triggers** — ribbon icon, command palette (with hotkeys), settings button, or a configurable auto-sync interval.
- **Drift-free** — entries you remove from AniList are also removed from your vault.
- **Read-only with respect to AniList** — your AniList list is the source of truth.
- **Works on mobile** — `isDesktopOnly: false`.
- **AI Chat Assistant** — Ask questions about your anime/manga library using natural language, powered by OpenRouter LLMs.
- **Hybrid Search Engine** — 7-layer search combining BM25, Trigrams, Vector Search (TF-IDF), Synonyms, Metadata Index, Heading Index, and Link Graph.
- **Performance Optimized** — Incremental indexing, lazy vector build, disk caching for instant reloads.
- **Chat History** — Persistent chat sessions with dropdown selector and delete functionality.
- **Live Typewriter Animation** — Responses stream character-by-character with a blinking cursor.
- **Smart Context Extraction** — Only relevant sections sent to LLM, reducing token usage.
- **Numeric Range Queries** — Filter by episodes, duration, year, score ranges.
- **Graph Colors** — Customize node colors for each note type in Obsidian's Graph View.
- **Characters & Voice Actors** — Characters synced per-anime with inlined VA data and wikilink tags.

## What gets synced

| Note type | Folder | Notes per user |
|-----------|--------|---------------|
| Anime | `Ani-sync/Anime/` | One per anime on the list |
| Manga | `Ani-sync/Manga/` | One per manga on the list |
| Characters | `Ani-sync/Characters/` | One per anime series, with voice actor data inlined |
| Studios | `Ani-sync/Studios/` | Referenced by Anime notes |
| Staff | `Ani-sync/Staff/` | Referenced by Anime notes (with images) |
| Tags / Genres | `Ani-sync/Tags/` | Referenced by Anime & Manga notes |
| Profile | `Ani-sync/Profile.md` | One summary note |
| Voice Actors | `Ani-sync/Voice-Actors.md` | Map of all voice actors to their characters |

Every Anime/Manga note links out to studios, staff, characters, tags, and relations with `[[Wiki Links]]`, so they all show up as connected nodes in Obsidian's graph view.

## Requirements

- Obsidian 1.4.0 or later
- An [AniList](https://anilist.co/) account
- A GitHub Pages site hosting this plugin's OAuth callback page (see `docs/`)

## Installation (manual)

1. Download `Ani-sync.zip` from the [latest release](https://github.com/agniveshtm/Ani-sync/releases/latest).
2. Extract the zip — you'll get an `Ani-sync/` folder containing `main.js`, `manifest.json`, and `styles.css`.
3. Copy the `Ani-sync/` folder into `<your-vault>/.obsidian/plugins/`.
4. In Obsidian: **Settings → Community plugins → Installed plugins**, enable **Ani-sync**.

## Installation (developer mode)

1. `npm install` to fetch dev dependencies.
2. `npm run build` to produce `main.js`.
3. Copy `main.js`, `manifest.json`, and `styles.css` from this folder into `<your-vault>/.obsidian/plugins/ani-sync/`.
4. In Obsidian: **Settings → Community plugins → Installed plugins**, enable **Ani-sync**.

## AniList setup (one-time)

1. Host the `docs/` folder of this repo on GitHub Pages.
2. In Obsidian: open **Settings → Ani-sync**:
   - Type your AniList username.
   - Click **Connect to AniList** → a browser tab opens → approve on AniList → AniList registers the **Ani-sync** app under your account → tab auto-closes → status turns to **Connected**.

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| AniList username | _(empty)_ | Auto-detected after OAuth |
| Output folder | `Ani-sync` | Created automatically with subfolders |
| Enable auto-sync | `true` | Runs while Obsidian is open |
| Poll interval | `30` (seconds, min 30) | Used when auto-sync is enabled |
| OpenRouter API key | _(empty)_ | Required for AI chat feature |
| OpenRouter model | _(empty)_ | Select from fetched models list |
| Graph Colors | 6 defaults | Per-type colors for Obsidian Graph View |

## Usage

- **Ribbon icons**:
  - (database) — sync now.
  - (message-circle) — open AI chat sidebar.
- **Command palette** (all with hotkeys):
  - `Ani-sync: Sync now` — `Ctrl+Shift+S`
  - `Ani-sync: Disconnect AniList` — `Ctrl+Shift+D`
  - `Ani-sync: Clear sync cache` — `Ctrl+Shift+C`
  - `Ani-sync: Open Ani-sync Chat` — `Ctrl+Shift+O`
- **Settings tab**:
  - **Sync now** / **Clear sync cache** buttons.
  - **OpenRouter AI** section — configure API key and model.
  - **Graph Colors** section — color pickers for each node type.

A toast notice reports `created N, updated M, skipped K, failed F` after each sync.

## How sync works

1. **Summary query** — fetches `id + updatedAt` for every entry (2 GraphQL calls, ANIME and MANGA in parallel).
2. **Diff against cache** — if nothing changed, exit in ~1 s with 0 detail fetches and 0 writes.
3. **Full lists + detail batch** — only changed entries' full Media details are fetched (AniList's `Page(perPage: 50)` query).
4. **Character fetch** — per-media, 4 concurrent, paginated (50 per page). Voice actors filtered to Japanese by preference with fallback.
5. **Build notes** — `builder.ts` formats each entity with wikilinked frontmatter + body (characters get inline VA data + tags).
6. **SHA-256 hash check** — only notes whose hash changed are written; stale file paths are cleaned up on rename.
7. **Removals** — entries removed from AniList are deleted from the vault.

The cache lives in `data.json` (Obsidian's plugin data file). AniList rate limits are respected (700ms minimum between requests, 3-attempt retry on 429 / 5xx with exponential backoff). Character fetch is rate-limited at 4 concurrent requests.

## AI Chat

The plugin includes an AI-powered chat sidebar that lets you query your synced AniList library using natural language.

### Setup

1. Get an API key from [OpenRouter](https://openrouter.ai/).
2. Open **Settings → Ani-sync → OpenRouter AI**.
3. Enter your API key and click **Fetch models**.
4. Select a model from the dropdown (free models are tagged).

### Hybrid Search Engine

The chat uses a **7-layer hybrid search** that combines multiple algorithms for maximum accuracy:

```
┌─────────────────────────────────────────────────────────────────┐
│                    HYBRID SEARCH SYSTEM                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │   BM25      │  │  Trigrams   │  │   Vector    │            │
│  │  (Fast)     │  │  (Fuzzy)    │  │  (Semantic) │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│                 ┌─────────────────┐                             │
│                 │  Score Fusion   │                             │
│                 │  (Weighted)     │                             │
│                 └─────────────────┘                             │
│                          │                                      │
│  ┌─────────────┐  ┌──────┴──────┐  ┌─────────────┐            │
│  │  Synonyms   │  │  Metadata   │  │   Heading   │            │
│  │  (Smart)    │  │  (Filters)  │  │  (O(1))     │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Algorithm | Purpose | Speed |
|-------|-----------|---------|-------|
| **BM25** | TF-IDF with field weighting | Statistical relevance ranking | ~5ms |
| **Trigrams** | 3-char n-gram Jaccard | Typo-tolerant fuzzy matching | ~5ms |
| **Vector Search** | TF-IDF + cosine similarity | Semantic understanding | ~15ms |
| **Synonyms** | Domain-specific expansion | "kid" → "son", "who voices" → "voice actor" | ~1ms |
| **Metadata Index** | Frontmatter field indexing | Filter by genre, status, score, studio | ~1ms |
| **Heading Index** | `##` heading HashMap (O(1)) | Instant character/section lookup | ~2ms |
| **Link Graph** | Wikilink traversal | Follows `[[links]]` to related files | ~2ms |

### Search Features

| Feature | Description |
|---------|-------------|
| **Exact Match** | Title/ID exact lookup |
| **Substring Match** | Title contains query |
| **Fuzzy Matching** | Trigram matching handles typos |
| **Semantic Search** | Vector search understands meaning |
| **Synonym Expansion** | Domain-specific term expansion |
| **Metadata Filtering** | Genre, status, score, studio filters |
| **Numeric Ranges** | Episode count, duration, year, score ranges |
| **Smart Context** | Extracts only relevant sections |

### Numeric Query Support

The search supports numeric range queries:

| Query Type | Examples |
|------------|----------|
| **Score ranges** | "score above 3", "score below 8", "score of 5" |
| **Episode ranges** | "more than 100 episodes", "less than 12 episodes" |
| **Duration ranges** | "more than 60 min", "less than 30 min" |
| **Year ranges** | "in 2024", "from 2020 to 2024", "after 2019" |

### Performance Optimizations

| Optimization | Impact | Description |
|--------------|--------|-------------|
| **Incremental Indexing** | 90% faster re-open | Only re-index changed files |
| **Lazy Vector Build** | 1s faster load | Defer TF-IDF computation to first query |
| **Disk Caching** | Instant reload | Save index to `.anisync-search-cache.json` |
| **Memory Caching** | 5-min instant | In-memory cache with TTL |

### Performance Metrics

| Metric | 100 files | 1000 files | 5000 files |
|--------|-----------|------------|------------|
| **First load** | ~1s | ~3s | ~10s |
| **Second load** | ~0.1s | ~0.5s | ~1s |
| **After restart** | ~0.1s | ~0.5s | ~1s |
| **Query time** | ~10ms | ~25ms | ~50ms |
| **Memory usage** | ~5MB | ~30MB | ~150MB |

### Chat History

Chat sessions are automatically saved as JSON in `data.json`. Features include:

- **Dropdown selector** — Click the history icon (⏱) to see past conversations
- **Individual delete** — Hover over a session to reveal delete button
- **Batch delete** — "Delete all history" button at bottom
- **Timestamps** — Each message shows the time it was sent
- **Persistent storage** — History survives Obsidian restarts

### Response Pipeline

```
User query → Quick response? → Static reply (greetings/bye/help)
            → No → Preflight check (API key + model)
                 → Vault index search (hybrid 7-layer)
                 → Smart context extraction (relevant sections only)
                 → Token budget check (max 24K chars)
                 → sendChatStream(OpenRouter)
                 → Typewriter animation (throttled 200ms)
                 → Final render (no cursor)
```

### Example Queries

**Entity Queries:**
- "What is Frieren about?"
- "Who is Hyakkimaru?"
- "Tell me about Dororo"

**Rating/Status Queries:**
- "Anime with score 5"
- "Best anime I watched"
- "Anime I'm currently watching"
- "Romance anime completed"

**Studio/Staff Queries:**
- "Anime by Ufotable"
- "Studio Bones anime"
- "Directed by Mamoru Hosoda"

**Relationship Queries:**
- "Name of Ichigo and Orihime's kid"
- "Renji and Rukia's child"
- "Who voices Tanjirou?"

**Numeric Range Queries:**
- "Anime with more than 100 episodes"
- "Score above 3"
- "Anime from 2020 to 2024"
- "Movies less than 30 min"

**Complex Queries:**
- "Fantasy anime with female protagonist"
- "Action anime with demons tag"
- "Manga completed with score 5"

## Graph Colors

Customize the color of each note type in Obsidian's Graph View via **Settings → Ani-sync → Graph Colors**.

| Type | Default Color |
|------|--------------|
| Anime | `#02a9ff` (blue) |
| Manga | `#8b5cf6` (purple) |
| Staff | `#4ade80` (green) |
| Studios | `#f59e0b` (amber) |
| Tags | `#f87171` (red) |
| Characters | `#fbbf24` (yellow) |

Colors are applied via Obsidian's `.obsidian/graph.json` color groups, targeting files by path prefix.

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        ANI-SYNC SYSTEM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 ANILIST API                              │   │
│  │  OAuth → GraphQL Queries → Rate Limiting → Retry        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 SYNC ENGINE                              │   │
│  │  Diff → Fetch → Build → Hash → Write/Delete             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 VAULT (.md files)                        │   │
│  │  Frontmatter + Wikilinks + SHA-256 markers              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 CACHE LAYER                              │   │
│  │  Memory Cache (5min) → Disk Cache (1hr) → Full Load     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 HYBRID SEARCH                            │   │
│  │  BM25 + Trigrams + Vector + Synonyms + Metadata         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 LLM PROMPT                               │   │
│  │  Smart Context → Token Budget → OpenRouter API           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 CHAT UI                                  │   │
│  │  Typewriter Animation → Markdown Render → History        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
AniList API
  → SyncEngine (diff + fetch + hash + write, 700ms rate limit, 8 concurrent writes)
    → Vault (.md files with frontmatter + wikilinks + SHA-256 markers)
    → data.json (summary map, detail cache, note hashes, file paths, chat history)
      → ChatView onOpen() → preloadVaultContext()
        → VaultContext.load()
          → Disk Cache Check → Memory Cache Check → Full Load
          → SearchIndex.build() (BM25 + Trigrams + Heading + Metadata)
          → VectorSearch.setNodes() (lazy build on first query)
            → handleSend() → buildContextForQuery()
              → Hybrid Search (7 layers)
              → Smart Context Extraction
              → sendChatStream(OpenRouter)
              → Typewriter animation → rendered markdown
```

### Concurrency

- Sync writes: 8 concurrent
- Sync deletes: 4 concurrent
- Character fetches: 4 concurrent
- Search index: built once, reused across queries (concurrency-safe via shared promise)
- Vector search: lazy-built on first query
- Typewriter render: lock-flagged to prevent overlapping renders

## Security

- Your AniList token is stored in Obsidian's `data.json` (not synced to git).
- The hosted callback page is static; the Client ID is hardcoded.
- The plugin's settings tab verifies `event.origin === 'https://agniveshtm.github.io'` before trusting the OAuth `postMessage`.
- Your OpenRouter API key is stored in `data.json` and sent only to OpenRouter's API endpoint.
- Session IDs use `crypto.randomUUID()` (cryptographically secure) instead of `Math.random()`.

## Project layout

```
.
├── manifest.json                Obsidian plugin manifest
├── main.js                      Built/bundled output
├── styles.css                   Custom styles (chat, settings, progress, cursor)
├── assets/logo.png              Plugin logo
├── package.json                 devDeps: obsidian, esbuild, typescript, …
├── esbuild.config.mjs           bundles src/main.ts → main.js
├── tsconfig.json                strict TS
├── src/
│   ├── main.ts                  Plugin class, ribbon, commands, sync orchestration, graph colors
│   ├── settings.ts              AnisyncSettings + DEFAULT_SETTINGS + GraphColors
│   ├── settingsTab.ts           Settings tab UI (6 sections, safe-rendered)
│   ├── types.ts                 AniList GraphQL response types (including Character, VoiceActor)
│   ├── auth/
│   │   ├── constants.ts         OAuth URLs, client ID, origin validation
│   │   └── implicit.ts          OAuth implicit flow via postMessage
│   ├── anilist/
│   │   ├── client.ts            GraphQL client (rate-limiter, retry, character fetch)
│   │   └── queries.ts           All GraphQL operations (6 queries)
│   ├── notes/
│   │   ├── builder.ts           Note artifact builder (7 types, character+VA inlining)
│   │   └── slugify.ts           Filename sanitization
│   ├── sync/
│   │   ├── engine.ts            Sync orchestrator (diff → fetch → build → hash → write/delete)
│   │   ├── hash.ts              SHA-256 via crypto.subtle + marker extract/strip
│   │   └── cache.ts             Cache schema + diff algorithm
│   ├── chat/
│   │   ├── view.ts              Chat UI (typewriter, markdown, history dropdown, timestamps)
│   │   ├── vaultContext.ts       7-layer hybrid search (BM25, Trigram, Vector, Synonyms, Metadata, Heading, LinkGraph)
│   │   └── logo.ts              Logo data URL for welcome screen
│   └── openrouter/
│       ├── client.ts            OpenRouter API (models list + streaming chat completions)
│       └── types.ts             OpenRouter API types
├── docs/                        Host on GitHub Pages for OAuth callback
│   ├── index.html               Callback page with postMessage
│   ├── style.css
│   └── script.js
└── .github/workflows/
    ├── test.yml                 CI: typecheck + build
    ├── deploy-docs.yml          Deploy docs/ to GitHub Pages
    └── release.yml              Build + create release with zip
```

## See also

- `solution.md` — Technical notes and improvement log.

## License

MIT
