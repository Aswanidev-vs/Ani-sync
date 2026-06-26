```ts
import { normalizePath } from "obsidian";
import type { AnilistClient } from "../anilist/client";
import {
  flattenSummaryToMap,
} from "../anilist/queries";
import type { MediaDetail, MediaList } from "../types";
import { buildAll, buildArtifacts, SYNCED_AT_PLACEHOLDER } from "../notes/builder";
import { extractHashMarker, stripHashMarker, sha256Hex } from "./hash";
import { AnisyncCache, diffSummary } from "./cache";

export interface VaultAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
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
  onProgress?: (message: string) => void;
}

export interface SyncStats {
  created: number;
  updated: number;
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
  private onProgress?: (message: string) => void;
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
    const onProgress = (m: string) => this.onProgress?.(m);

    onProgress("Fetching viewer + summary...");
    const [viewer, summary] = await Promise.all([
      this.anilist.fetchViewer(),
      this.anilist.fetchSummary(this.username),
    ]);
    onProgress(`Viewer: @${viewer.name} (id ${viewer.id})`);

    const newSummary = flattenSummaryToMap(
      { lists: summary.animeLists },
      { lists: summary.mangaLists },
    );
    const oldSummary = this.cache?.summary ?? {};
    const diff = diffSummary(oldSummary, newSummary);
    const { changed, removed, unchanged } = diff;
    onProgress(`Summary: ${changed.length} changed, ${removed.length} removed, ${unchanged.length} unchanged`);

    if (changed.length === 0 && removed.length === 0) {
      onProgress("No changes detected. Cache-only update, skipping list fetches and writes.");
      const idleStats: SyncStats = { created: 0, updated: 0, skipped: unchanged.length, failed: 0, planned: 0 };
      const detailsMap = new Map(Object.entries(this.cache?.details ?? {}));
      await this.updateCache(newSummary, detailsMap);
      return idleStats;
    }

    if (changed.length === 0 && removed.length > 0) {
      onProgress(`Only removals detected (${removed.length}). Skipping list fetches...`);
      const removalStats: SyncStats = { created: 0, updated: 0, skipped: 0, failed: 0, planned: 0 };
      await this.handleRemovals(removed, removalStats);
      if (this.cancelled) {
        return this.cancelledStats();
      }
      const detailsMap = new Map(Object.entries(this.cache?.details ?? {}));
      for (const k of removed) detailsMap.delete(k);
      await this.updateCache(newSummary, detailsMap);
      return removalStats;
    }

    onProgress(`Fetching full lists for ${changed.length} changed entry/entries...`);
    const [fullAnimeLists, fullMangaLists] = await Promise.all([
      this.anilist.fetchFullList("ANIME", this.username),
      this.anilist.fetchFullList("MANGA", this.username),
    ]);
    onProgress(`  anime lists: ${countEntries(fullAnimeLists)} entries`);
    onProgress(`  manga lists: ${countEntries(fullMangaLists)} entries`);

    if (this.cancelled) return this.cancelledStats();

    const details = new Map<string, MediaDetail>();
    for (const k of Object.keys(this.cache?.details ?? {})) {
      if (newSummary[k] != null && !changed.includes(k)) {
        details.set(k, this.cache.details[k]);
      }
    }
    onProgress(`Reusing ${details.size} cached details`);

    const toFetch: { id: number; type: "ANIME" | "MANGA" }[] = [];
    for (const key of changed) {
      const [type, idStr] = key.split(":");
      const id = Number(idStr);
      if ((type === "ANIME" || type === "MANGA") && Number.isFinite(id)) {
        toFetch.push({ id, type });
      }
    }
    onProgress(`Fetching ${toFetch.length} new/changed detail(s) in batch...`);

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

    const missing = toFetch.filter((m) => !details.has(`${m.type}:${m.id}`));
    if (missing.length) {
      onProgress(`  ! ${missing.length} detail(s) could not be fetched`);
      for (const m of missing) {
        onProgress(`    - ${m.type}:${m.id}`);
      }
    }
    onProgress(`Detail fetch complete: ${details.size} total`);

    if (this.cancelled) return this.cancelledStats();

    const built = buildAll(viewer, fullAnimeLists, fullMangaLists, details);
    const artifacts = buildArtifacts(built, this.syncedAt);
    onProgress(`Artifacts planned: ${artifacts.length}`);

    onProgress("Pre-computing hashes...");
    const prepared = await this.prepareArtifacts(artifacts);
    onProgress(`Hashes computed: ${prepared.length}`);

    if (this.cancelled) return this.cancelledStats();

    const stats = await this.writeArtifacts(prepared);

    if (this.cancelled) return stats;

    await this.handleRemovals(removed, stats);

    await this.updateCache(newSummary, details);

    return stats;
  }

  cancel(): void {
    this.cancelled = true;
  }

  cancelledStats(): SyncStats {
    return { created: 0, updated: 0, skipped: 0, failed: 0, planned: 0, cancelled: true };
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

  private async writeArtifacts(prepared: PreparedArtifact[]): Promise<SyncStats> {
    const stats: SyncStats = { created: 0, updated: 0, skipped: 0, failed: 0, planned: prepared.length };
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
      }
    });

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
        stats.updated += 1;
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
```
