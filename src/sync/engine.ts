import { normalizePath } from "obsidian";
import type { AnilistClient } from "../anilist/client";
import {
  flattenSummaryToMap,
} from "../anilist/queries";
import type { AnilistCharacterEdge, MediaDetail, MediaList } from "../types";
import { buildAll, buildArtifacts, SYNCED_AT_PLACEHOLDER } from "../notes/builder";
import { extractHashMarker, stripHashMarker, sha256Hex } from "./hash";
import { AnisyncCache, diffSummary } from "./cache";

export interface VaultAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface CacheStore {
  load(): Promise<AnisyncCache>;
  save(cache: AnisyncCache): Promise<void>;
}

export interface SyncEngineDeps {
  anilist: AnilistClient;
  vault: VaultAdapter;
  cacheStore: CacheStore;
  outputDir: string;
  username: string;
  cache: AnisyncCache;
  onLog?: (message: string) => void;
  onProgress?: (message: string, percent?: number) => void;
}

export interface SyncStats {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  planned: number;
  cancelled?: boolean;
}

const WRITE_CONCURRENCY = 8;
const DELETE_CONCURRENCY = 4;

export class SyncEngine {
  private anilist: AnilistClient;
  private vault: VaultAdapter;
  private cacheStore: CacheStore;
  private outputDir: string;
  private username: string;
  private cache: AnisyncCache;
  private onLog?: (message: string) => void;
  private onProgress?: (message: string, percent?: number) => void;
  private cancelled = false;
  private syncedAt: string;

  constructor(deps: SyncEngineDeps) {
    this.anilist = deps.anilist;
    this.vault = deps.vault;
    this.cacheStore = deps.cacheStore;
    this.outputDir = (deps.outputDir ?? "Ani-sync").replace(/^\/+|\/+$/g, "");
    this.username = deps.username;
    this.cache = deps.cache;
    this.onLog = deps.onLog;
    this.onProgress = deps.onProgress;
    this.syncedAt = new Date().toISOString();
  }

  async run(): Promise<SyncStats> {
    const onProgress = (m: string, p?: number) => this.onProgress?.(m, p);

    onProgress("Fetching viewer + summary...", 2);
    const [viewer, summary] = await Promise.all([
      this.anilist.fetchViewer(),
      this.anilist.fetchSummary(this.username),
    ]);
    onProgress(`Viewer: @${viewer.name} (id ${viewer.id})`, 5);

    const outputExists = await this.vault.exists(this.outputDir);
    if (!outputExists) {
      onProgress("Output directory missing — forcing full re-sync");
      this.cache = { version: 1, summary: {}, details: {}, noteHashes: {}, paths: {} };
    }

    const newSummary = flattenSummaryToMap(
      { lists: summary.animeLists },
      { lists: summary.mangaLists },
    );
    const oldSummary = this.cache?.summary ?? {};
    const diff = diffSummary(oldSummary, newSummary);
    const { changed, removed, unchanged } = diff;
    onProgress(`Summary: ${changed.length} changed, ${removed.length} removed, ${unchanged.length} unchanged`, 5);

    if (changed.length === 0 && removed.length === 0) {
      onProgress("No changes detected. Cache-only update, skipping list fetches and writes.", 100);
      const idleStats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: unchanged.length, failed: 0, planned: 0 };
      const detailsMap = new Map(Object.entries(this.cache?.details ?? {}));
      await this.updateCache(newSummary, detailsMap);
      return idleStats;
    }

    if (changed.length === 0 && removed.length > 0) {
      onProgress(`Only removals detected (${removed.length}). Skipping list fetches...`, 10);
      const removalStats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, planned: 0 };
      await this.handleRemovals(removed, removalStats);
      if (this.cancelled) {
        return this.cancelledStats();
      }
      const detailsMap = new Map(Object.entries(this.cache?.details ?? {}));
      for (const k of removed) detailsMap.delete(k);
      await this.updateCache(newSummary, detailsMap);
      onProgress("Done", 100);
      return removalStats;
    }

    onProgress(`Fetching full lists for ${changed.length} changed entry/entries...`, 7);
    const [fullAnimeLists, fullMangaLists] = await Promise.all([
      this.anilist.fetchFullList("ANIME", this.username),
      this.anilist.fetchFullList("MANGA", this.username),
    ]);
    const animeCount = countEntries(fullAnimeLists);
    const mangaCount = countEntries(fullMangaLists);
    const totalEntries = animeCount + mangaCount;
    onProgress(`anime: ${animeCount} / manga: ${mangaCount} entries`, 10);

    if (this.cancelled) return this.cancelledStats();

    const details = new Map<string, MediaDetail>();
    for (const k of Object.keys(this.cache?.details ?? {})) {
      if (newSummary[k] != null && !changed.includes(k)) {
        details.set(k, this.cache.details[k]);
      }
    }
    onProgress(`Reusing ${details.size}/${totalEntries} cached details`, 10 + (details.size / totalEntries) * 20);

    const toFetch: { id: number; type: "ANIME" | "MANGA" }[] = [];
    for (const key of changed) {
      const [type, idStr] = key.split(":");
      const id = Number(idStr);
      if ((type === "ANIME" || type === "MANGA") && Number.isFinite(id)) {
        toFetch.push({ id, type });
      }
    }
    onProgress(`Fetching ${toFetch.length} new/changed detail(s) in batch...`, 30);

    const byType: { ANIME: number[]; MANGA: number[] } = { ANIME: [], MANGA: [] };
    for (const m of toFetch) {
      const bucket = byType[m.type];
      if (bucket) bucket.push(m.id);
    }

    const [fetchedAnime, fetchedManga] = await Promise.all([
      byType.ANIME.length && !this.cancelled
        ? this.anilist.fetchDetails("ANIME", byType.ANIME)
        : Promise.resolve([] as MediaDetail[]),
      byType.MANGA.length && !this.cancelled
        ? this.anilist.fetchDetails("MANGA", byType.MANGA)
        : Promise.resolve([] as MediaDetail[]),
    ]);

    for (const m of fetchedAnime) if (m) details.set(`ANIME:${m.id}`, m);
    for (const m of fetchedManga) if (m) details.set(`MANGA:${m.id}`, m);

    // Check ALL entries (cached + fresh) for incomplete character data — fetch missing pages
    const needsMoreChars = [...details.values()].filter(m => {
      if (!m) return false;
      const chars = m.characters as { edges?: unknown[]; pageInfo?: { hasNextPage?: boolean } } | null | undefined;
      if (!chars?.edges) return false;
      return chars.pageInfo?.hasNextPage || (chars.pageInfo == null && chars.edges.length >= 50);
    });
    if (needsMoreChars.length > 0) {
      await pMapLimit(needsMoreChars, 4, async (m) => {
        if (this.cancelled) return;
        const rest = await this.anilist.fetchAllCharacters(m.id, m.type);
        const existing = m.characters?.edges ?? [];
        m.characters = { edges: [...existing, ...rest], pageInfo: { hasNextPage: false } } as typeof m.characters;
      });
    }

    const missing = toFetch.filter((m) => !details.has(`${m.type}:${m.id}`));
    if (missing.length) {
      onProgress(`  ! ${missing.length} detail(s) could not be fetched`);
      for (const m of missing) {
        onProgress(`    - ${m.type}:${m.id}`);
      }
    }
    onProgress(`Detail fetch complete: ${details.size} total`, 50);

    if (this.cancelled) return this.cancelledStats();

    const built = buildAll(viewer, fullAnimeLists, fullMangaLists, details);
    const artifacts = buildArtifacts(built, this.syncedAt);
    const totalFiles = artifacts.length;
    const totalFolders = new Set(artifacts.map(a => a.folder)).size;
    onProgress(`Artifacts planned: ${totalFiles} files, ${totalFolders} folders`, 55);

    onProgress("Pre-computing hashes...", 57);
    const prepared = await this.prepareArtifacts(artifacts);
    onProgress(`Hashes computed: ${prepared.length}`, 60);

    if (this.cancelled) return this.cancelledStats();

    const stats = await this.writeArtifacts(prepared, totalFolders, (filesDone, totalF, foldersDone) => {
      onProgress(`${filesDone}/${totalF} files (${foldersDone}/${totalFolders} folders)`, 60 + Math.round((filesDone / totalF) * 30));
    });

    if (this.cancelled) return stats;

    onProgress(`Removing ${removed.length} obsolete note(s)...`, 92);
    await this.handleRemovals(removed, stats);

    onProgress("Cleaning up legacy Voice-Actor files...", 94);
    await this.cleanupVoiceActorArtifacts(stats);

    onProgress("Cleaning up legacy character files...", 94);
    await this.cleanupLegacyCharacterArtifacts(stats);

    onProgress("Updating cache...", 95);
    await this.updateCache(newSummary, details);

    return stats;
  }

  cancel(): void {
    this.cancelled = true;
  }

  cancelledStats(): SyncStats {
    return { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, planned: 0, cancelled: true };
  }

  private async prepareArtifacts(artifacts: ReturnType<typeof buildArtifacts>): Promise<PreparedArtifact[]> {
    const stamped: PreparedArtifact[] = artifacts.map((a) => ({
      artifact: a,
      bodyForHash: stripHashMarker(a.body.split(SYNCED_AT_PLACEHOLDER).join(this.syncedAt)),
      noteHash: "",
    }));
    const hashes = await Promise.all(stamped.map((p) => sha256Hex(p.bodyForHash)));
    for (let i = 0; i < stamped.length; i += 1) stamped[i].noteHash = hashes[i];
    return stamped;
  }

  private async writeArtifacts(
    prepared: PreparedArtifact[],
    totalFolders: number,
    onWriteProgress?: (filesDone: number, totalFiles: number, foldersDone: number) => void,
  ): Promise<SyncStats> {
    const stats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, planned: prepared.length };
    const noteHashes = { ...(this.cache?.noteHashes ?? {}) };
    const paths = this.cache?.paths ?? {};
    const newPaths = { ...paths };

    const seenInFolder = new Map<string, Map<string, number>>();
    const resolved: { p: typeof prepared[number]; vaultPath: string }[] = [];
    for (const p of prepared) {
      const a = p.artifact;
      let folderMap = seenInFolder.get(a.folder);
      if (!folderMap) {
        folderMap = new Map();
        seenInFolder.set(a.folder, folderMap);
      }
      const count = folderMap.get(a.filename) ?? 0;
      folderMap.set(a.filename, count + 1);
      let filename = a.filename;
      if (count > 0) {
        const dot = a.filename.lastIndexOf(".");
        const base = dot >= 0 ? a.filename.slice(0, dot) : a.filename;
        const ext = dot >= 0 ? a.filename.slice(dot) : "";
        filename = `${base}-${count + 1}${ext}`;
      }
      const vaultPath = normalizePath(a.folder
        ? `${this.outputDir}/${a.folder}/${filename}`
        : `${this.outputDir}/${filename}`);
      resolved.push({ p, vaultPath });
    }

    let writtenCount = 0;
    const foldersWithWrites = new Set<string>();
    await pMapLimit(resolved, WRITE_CONCURRENCY, async ({ p, vaultPath }) => {
      if (this.cancelled) return;
      const a = p.artifact;
      const { noteHash, bodyForHash } = p;
      const cachedHash = noteHashes[a.uniqueKey];

      try {
        if (cachedHash === noteHash) {
          stats.skipped += 1;
          noteHashes[a.uniqueKey] = noteHash;
          newPaths[a.uniqueKey] = vaultPath;
          return;
        }

        if (cachedHash == null) {
          const finalContent = `${bodyForHash.replace(/\s+$/g, "")}\n\n<!-- anilist-hash: ${noteHash} -->\n`;
          await this.vault.write(vaultPath, finalContent);
          stats.created += 1;
          noteHashes[a.uniqueKey] = noteHash;
          newPaths[a.uniqueKey] = vaultPath;
          return;
        }

        const existing = await this.vault.read(vaultPath);
        if (existing != null && extractHashMarker(existing) === noteHash) {
          stats.skipped += 1;
          noteHashes[a.uniqueKey] = noteHash;
          newPaths[a.uniqueKey] = vaultPath;
          return;
        }

        const finalContent = `${bodyForHash.replace(/\s+$/g, "")}\n\n<!-- anilist-hash: ${noteHash} -->\n`;
        await this.vault.write(vaultPath, finalContent);
        stats[existing == null ? "created" : "updated"] += 1;
        noteHashes[a.uniqueKey] = noteHash;
        newPaths[a.uniqueKey] = vaultPath;
      } catch (e) {
        stats.failed += 1;
        this.onLog?.(`  ! write failed for ${vaultPath}: ${(e as Error)?.message ?? e}`);
      } finally {
        writtenCount += 1;
        foldersWithWrites.add(a.folder);
        if (onWriteProgress && writtenCount % 50 === 0) {
          onWriteProgress(writtenCount, prepared.length, foldersWithWrites.size);
        }
      }
    });

    onWriteProgress?.(prepared.length, prepared.length, foldersWithWrites.size);
    this.cache = { ...(this.cache ?? {}), noteHashes, paths: newPaths };
    return stats;
  }

  private async handleRemovals(removedKeys: string[], stats: SyncStats): Promise<void> {
    if (removedKeys.length === 0) return;
    const paths = this.cache?.paths ?? {};
    const noteHashes = this.cache?.noteHashes ?? {};
    const newPaths = { ...paths };

    const items: { k: string; vaultPath: string }[] = [];
    for (const k of removedKeys) {
      const vaultPath = paths[k];
      if (vaultPath) items.push({ k, vaultPath });
    }
    if (items.length === 0) return;

    this.onProgress?.(`Removing ${items.length} obsolete note(s)...`);

    let removed = 0;
    await pMapLimit(items, DELETE_CONCURRENCY, async ({ k, vaultPath }) => {
      if (this.cancelled) return;
      try {
        await this.vault.delete(vaultPath);
        stats.deleted += 1;
        delete noteHashes[k];
        delete newPaths[k];
        removed += 1;
      } catch (e) {
        if (/404/.test(String((e as Error)?.message))) {
          delete noteHashes[k];
          delete newPaths[k];
          return;
        }
        this.onProgress?.(`  ! delete failed for ${vaultPath}: ${(e as Error)?.message}`);
      }
    });

    if (removed) this.onProgress?.(`  removed: ${removed}`);
    this.cache = { ...(this.cache ?? {}), noteHashes, paths: newPaths };
  }

  private async cleanupVoiceActorArtifacts(stats: SyncStats): Promise<void> {
    const paths = this.cache?.paths ?? {};
    const noteHashes = this.cache?.noteHashes ?? {};
    const toDelete: { k: string; vaultPath: string }[] = [];

    for (const [key, vaultPath] of Object.entries(paths)) {
      if (key.startsWith("va:") && vaultPath.includes("/Voice-Actors/")) {
        toDelete.push({ k: key, vaultPath });
      }
    }

    if (toDelete.length === 0) return;

    const deletedKeys: string[] = [];
    let removed = 0;
    await pMapLimit(toDelete, DELETE_CONCURRENCY, async ({ k, vaultPath }) => {
      if (this.cancelled) return;
      try {
        await this.vault.delete(vaultPath);
        stats.deleted += 1;
        deletedKeys.push(k);
        removed += 1;
      } catch (e) {
        if (/404/.test(String((e as Error)?.message))) {
          deletedKeys.push(k);
          removed += 1;
        } else {
          this.onLog?.(`  ! cleanup failed for ${vaultPath}: ${(e as Error)?.message ?? e}`);
        }
      }
    });
    for (const k of deletedKeys) {
      delete noteHashes[k];
      delete paths[k];
    }

    if (removed) this.onProgress?.(`  Voice-Actor clean-up: removed ${removed} file(s)`);
    this.cache = { ...this.cache, noteHashes, paths };
  }

  private async cleanupLegacyCharacterArtifacts(stats: SyncStats): Promise<void> {
    const paths = this.cache?.paths ?? {};
    const noteHashes = this.cache?.noteHashes ?? {};
    const toDelete: { k: string; vaultPath: string }[] = [];

    for (const [key, vaultPath] of Object.entries(paths)) {
      if (key.startsWith("character:") && vaultPath.startsWith("Characters/")) {
        toDelete.push({ k: key, vaultPath });
      }
    }

    if (toDelete.length === 0) return;

    const deletedKeys: string[] = [];
    let removed = 0;
    await pMapLimit(toDelete, DELETE_CONCURRENCY, async ({ k, vaultPath }) => {
      if (this.cancelled) return;
      try {
        await this.vault.delete(vaultPath);
        stats.deleted += 1;
        deletedKeys.push(k);
        removed += 1;
      } catch (e) {
        if (/404/.test(String((e as Error)?.message))) {
          deletedKeys.push(k);
          removed += 1;
        } else {
          this.onLog?.(`  ! legacy character cleanup failed for ${vaultPath}: ${(e as Error)?.message ?? e}`);
        }
      }
    });
    for (const k of deletedKeys) {
      delete noteHashes[k];
      delete paths[k];
    }

    if (removed) this.onProgress?.(`  Legacy character clean-up: removed ${removed} file(s)`);
    this.cache = { ...this.cache, noteHashes, paths };
  }

  private async updateCache(
    newSummary: Record<string, number>,
    detailsMap: Map<string, MediaDetail>,
  ): Promise<void> {
    const newCache: AnisyncCache = {
      version: 1,
      summary: newSummary,
      details: Object.fromEntries(detailsMap),
      noteHashes: this.cache?.noteHashes ?? {},
      paths: this.cache?.paths ?? {},
    };
    await this.cacheStore.save(newCache);
    this.cache = newCache;
  }
}

interface PreparedArtifact {
  artifact: ReturnType<typeof buildArtifacts>[number];
  noteHash: string;
  bodyForHash: string;
}

function countEntries(lists: MediaList[]): number {
  return lists.reduce((acc, l) => acc + l.entries.length, 0);
}

async function pMapLimit<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const workers = Math.min(limit, items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}
