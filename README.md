# Ani-sync

An Obsidian plugin that syncs your [AniList](https://anilist.co/) anime & manga lists into your vault as wikilinked markdown notes, so they show up in Obsidian's graph view. Includes an AI-powered chat assistant to query your library.

## Features

- **One-click AniList OAuth** via a small GitHub Pages callback page.
- **Incremental, idempotent syncs** — sha256-based change detection means a steady-state sync is ~3 GraphQL calls and 0 writes in ~1 s.
- **Manual + periodic triggers** — ribbon icon, command palette command, settings button, or a configurable auto-sync interval.
- **Drift-free** — entries you remove from AniList are also removed from your vault.
- **Read-only with respect to AniList** — your AniList list is the source of truth.
- **Works on mobile** — `isDesktopOnly: false`.
- **AI Chat Assistant** — Ask questions about your anime/manga library using natural language, powered by OpenRouter LLMs.
- **Live Typewriter Animation** — Responses stream character-by-character with a blinking cursor, just like ChatGPT.
- **Markdown Rendering** — Full support for bold, italic, code blocks, tables, lists, blockquotes, and more in chat responses.

## What gets synced

| Note type | Folder | Notes per user |
|---|---|---|
| Anime | `Ani-sync/Anime/` | One per anime on the list |
| Manga | `Ani-sync/Manga/` | One per manga on the list |
| Studios | `Ani-sync/Studios/` | Referenced by Anime notes |
| Staff | `Ani-sync/Staff/` | Referenced by Anime notes (with images) |
| Tags / Genres | `Ani-sync/Tags/` | Referenced by Anime & Manga notes |
| Profile | `Ani-sync/Profile.md` | One summary note |

Every Anime/Manga note links out to studios, staff, tags, and relations with `[[Wiki Links]]`, so they all show up as connected nodes in Obsidian's graph view.

## Requirements

- Obsidian 1.4.0 or later
- An AniList account
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
|---|---|---|
| AniList username | _(empty)_ | Required |
| Output folder | `Ani-sync` | Created automatically with `Anime/`, `Manga/`, `Studios/`, `Staff/`, `Tags/` subfolders |
| Enable auto-sync | `true` | Runs every N minutes while Obsidian is open |
| Poll interval | `30` (seconds, min 30) | Used when auto-sync is enabled |
| OpenRouter API key | _(empty)_ | Required for AI chat feature |
| OpenRouter model | _(empty)_ | Select from fetched models list |

## Usage

- **Ribbon icons**:
  - (database) — click to sync now.
  - (message-circle) — open AI chat sidebar.
- **Command palette**:
  - `Ani-sync: Sync now`
  - `Ani-sync: Disconnect AniList`
  - `Ani-sync: Clear sync cache (force full re-sync)`
  - `Ani-sync: Open Ani-sync Chat`
- **Settings tab**:
  - **Sync now** button (same as the ribbon icon).
  - **Clear sync cache** button — next sync re-fetches every entry.
  - **OpenRouter AI** section — configure API key and model for chat.

A toast notice reports `created N, updated M, skipped K, failed F` after each sync.

## How sync works

1. **Summary query** — fetches `id + updatedAt` for every entry (2 GraphQL calls, ANIME and MANGA in parallel).
2. **Diff against cache** — if nothing changed, exit in ~1 s with 0 detail fetches and 0 writes.
3. **Full lists + detail batch** — only the changed entries' full Media details are fetched (AniList's `Page(perPage: 50)` query).
4. **Build notes** — `note-builder.ts` formats each entity with wikilinked frontmatter + body.
5. **sha256 hash check** — only notes whose hash actually changed are written to the vault.
6. **Removals** — entries removed from AniList are removed from the vault.

The cache lives in `data.json` (Obsidian's plugin data file). AniList rate limits are respected (700ms minimum between requests, 3-attempt retry on 429 / 5xx with exponential backoff).

## AI Chat

The plugin includes an AI-powered chat sidebar that lets you query your synced AniList library using natural language.

### Setup

1. Get an API key from [OpenRouter](https://openrouter.ai/)
2. Open **Settings → Ani-sync → OpenRouter AI**
3. Enter your API key and click **Fetch models**
4. Select a model from the dropdown (free models are tagged)

### Features

- **Natural language queries** — Ask questions like "What anime have I rated 10?" or "Show me all anime by MAPPA"
- **Markdown responses** — Full support for bold, italic, code blocks, tables, lists, and blockquotes
- **Live streaming** — Responses appear character-by-character with a typing cursor
- **Fuzzy search** — Finds relevant media by title, staff, studio, genres, tags, or description
- **Vault-based context** — Answers are grounded in your actual synced data

### Example queries

- "What's my highest rated anime?"
- "Show me all anime I've completed"
- "What genres do I watch most?"
- "List all anime by studio Ufotable"
- "What's the staff for Attack on Titan?"

## Project layout

## Security

- Your AniList token is stored in Obsidian's `data.json` (not synced to git if you ignore it).
- The hosted callback page is static; the Client ID is hardcoded.
- The plugin's settings tab verifies `event.origin === 'https://agniveshtm.github.io'` before trusting the OAuth `postMessage`.

## Project layout

```
.
├── manifest.json              Obsidian plugin manifest
├── main.js                    Built/bundled output
├── styles.css                 Custom styles for settings UI
├── package.json               devDeps: obsidian, esbuild, typescript, …
├── esbuild.config.mjs         bundles src/main.ts → main.js
├── tsconfig.json              strict TS
├── src/
│   ├── main.ts                Plugin class, ribbon, commands, sync orchestration
│   ├── settings.ts            AnisyncSettings + DEFAULT_SETTINGS
│   ├── settingsTab.ts         Settings tab UI
│   ├── types.ts               AniList response types
│   ├── auth/
│   │   ├── constants.ts       ANILIST_AUTHORIZE_URL, ALLOWED_OAUTH_ORIGIN
│   │   └── implicit.ts        Popup + postMessage listener + token probe
│   ├── anilist/
│   │   ├── client.ts          GraphQL client (requestUrl, rate-limit, retry)
│   │   └── queries.ts         All GraphQL operations
│   ├── notes/
│   │   ├── builder.ts         Note template, frontmatter, wikilinks
│   │   └── slugify.ts         Filename slugs
│   ├── sync/
│   │   ├── engine.ts          Orchestrator (summary → diff → write/delete)
│   │   ├── hash.ts            sha256 + hash marker extract/strip
│   │   └── cache.ts           AnisyncCache schema + diffSummary
│   ├── chat/
│   │   ├── view.ts            Chat UI with markdown rendering + typewriter animation
│   │   ├── context.ts         Cache-based search + prompt building
│   │   └── vaultContext.ts    Vault markdown parsing + fuzzy search
│   └── openrouter/
│       ├── client.ts          OpenRouter API (models + streaming chat)
│       └── types.ts           OpenRouter API types
├── docs/                      Host this on GitHub Pages
│   ├── index.html
│   ├── style.css
│   └── script.js
└── .github/workflows/
    ├── test.yml               CI: typecheck + build
    ├── deploy-docs.yml        Deploy docs/ to GitHub Pages
    └── release.yml            Build + create release with zip
```

## License

MIT
