import { normalizePath } from "obsidian";
import type { AnilistClient } from "../anilist/client";
import {
  flattenSummaryToMap,
} from "../anilist/queries";
import type { AnilistCharacterConnection, AnilistCharacterEdge, AnilistVoiceActor, MediaDetail, MediaList } from "../types";
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
    this.onLog?.(`Authenticated as @${viewer.name} (ID: ${viewer.id})`);

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
    const cachedDetails = new Map(Object.entries(this.cache?.details ?? {}));
    const diff = diffSummary(oldSummary, newSummary);
    const { changed, removed, unchanged } = diff;
    const staleCharacterDetails = [...cachedDetails.entries()]
      .filter(([key, detail]) => newSummary[key] != null && this.needsCharacterRefresh(detail))
      .map(([key]) => key);
    onProgress(`Summary: ${changed.length} changed, ${removed.length} removed, ${unchanged.length} unchanged`, 5);
    this.onLog?.(`Summary diff: ${changed.length} changed, ${removed.length} removed, ${unchanged.length} unchanged`);

    if (changed.length === 0 && removed.length === 0 && staleCharacterDetails.length === 0) {
      onProgress("No changes detected. Cache-only update, skipping list fetches and writes.", 100);
      this.onLog?.("No changes detected - sync complete (cache-only update)");
      const idleStats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: unchanged.length, failed: 0, planned: 0 };
      await this.updateCache(newSummary, cachedDetails);
      return idleStats;
    }

    if (changed.length === 0 && removed.length > 0) {
      onProgress(`Only removals detected (${removed.length}). Cleaning up...`, 10);
      this.onLog?.(`Processing ${removed.length} removal(s) only`);
      const removalStats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, planned: 0 };
      await this.handleRemovals(removed, removalStats);
      if (this.cancelled) {
        return this.cancelledStats();
      }

      // Build details map from cached details for remaining entries
      const detailsMap = new Map(cachedDetails);
      for (const k of removed) detailsMap.delete(k);

      // Extract currently active studios/staff directly from remaining cached details
      const currentStudioIds = new Set<number>();
      const currentStaffIds = new Set<number>();
      for (const detail of detailsMap.values()) {
        for (const edge of detail.studios?.edges ?? []) {
          if (edge?.node) currentStudioIds.add(edge.node.id);
        }
        for (const edge of detail.staff?.edges ?? []) {
          if (edge?.node) currentStaffIds.add(edge.node.id);
        }
      }

      // Clean up orphaned studio/staff artifacts
      await this.cleanupSharedArtifacts(removalStats, currentStudioIds, "studio:", "Studio");
      await this.cleanupSharedArtifacts(removalStats, currentStaffIds, "staff:", "Staff");

      await this.updateCache(newSummary, detailsMap);
      onProgress("Done", 100);
      return removalStats;
    }

    const fetchKeys = [...new Set([...changed, ...staleCharacterDetails])];
    onProgress(`Fetching full lists for ${fetchKeys.length} changed/incomplete entry/entries...`, 7);
    this.onLog?.(`Fetching full lists for ${fetchKeys.length} changed/incomplete entries`);
    const [fullAnimeLists, fullMangaLists] = await Promise.all([
      this.anilist.fetchFullList("ANIME", this.username),
      this.anilist.fetchFullList("MANGA", this.username),
    ]);
    const animeCount = countEntries(fullAnimeLists);
    const mangaCount = countEntries(fullMangaLists);
    const totalEntries = animeCount + mangaCount;
    onProgress(`anime: ${animeCount} / manga: ${mangaCount} entries`, 10);
    this.onLog?.(`Lists fetched: ${animeCount} anime, ${mangaCount} manga entries`);

    if (this.cancelled) return this.cancelledStats();

    const details = new Map<string, MediaDetail>();
    for (const [k, detail] of cachedDetails) {
      if (newSummary[k] != null && !fetchKeys.includes(k)) {
        details.set(k, detail);
      }
    }
    onProgress(`Reusing ${details.size}/${totalEntries} cached details`, 10 + (details.size / totalEntries) * 20);

    const toFetch: { id: number; type: "ANIME" | "MANGA" }[] = [];
    for (const key of fetchKeys) {
      const [type, idStr] = key.split(":");
      const id = Number(idStr);
      if ((type === "ANIME" || type === "MANGA") && Number.isFinite(id)) {
        toFetch.push({ id, type });
      }
    }
    onProgress(`Fetching ${toFetch.length} new/changed detail(s) in batch...`, 30);
    this.onLog?.(`Reusing ${details.size} cached details, fetching ${toFetch.length} new/changed`);

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

    for (const m of fetchedAnime) if (m) details.set(`ANIME:${m.id}`, this.mergeMediaDetail(cachedDetails.get(`ANIME:${m.id}`), m));
    for (const m of fetchedManga) if (m) details.set(`MANGA:${m.id}`, this.mergeMediaDetail(cachedDetails.get(`MANGA:${m.id}`), m));

    // Collect keys of freshly fetched media — always re-fetch their characters
    // because the batch query can truncate character data due to complexity limits
    const freshlyFetchedKeys = new Set<string>();
    for (const m of fetchedAnime) if (m) freshlyFetchedKeys.add(`ANIME:${m.id}`);
    for (const m of fetchedManga) if (m) freshlyFetchedKeys.add(`MANGA:${m.id}`);

    const detailsNeedingCharacters = [...details.entries()].filter(([key, m]) => {
      // Always re-fetch characters for freshly fetched media (batch query may have truncated them)
      if (freshlyFetchedKeys.has(key)) return true;
      // For cached entries, only re-fetch if the character list looks incomplete
      return this.needsCharacterRefresh(m);
    }).map(([, m]) => m);

    if (detailsNeedingCharacters.length > 0) {
      this.onLog?.(`  character fetch needed for ${detailsNeedingCharacters.length} media entries (${freshlyFetchedKeys.size} freshly fetched, ${detailsNeedingCharacters.length - freshlyFetchedKeys.size} cache refresh)`);
      for (const m of detailsNeedingCharacters) {
        const existing = m.characters?.edges?.length ?? 0;
        this.onLog?.(`    -> ${m.type}:${m.id} ("${m.title?.userPreferred ?? m.title?.romaji ?? "?"}") [${existing} existing chars]`);
      }
      await pMapLimit(detailsNeedingCharacters, 4, async (m) => {
        if (this.cancelled) return;
        try {
          const fetchedEdges = await this.anilist.fetchAllCharacters(m.id, m.type, 1);
          this.onLog?.(`  ${m.type}:${m.id}: fetched ${fetchedEdges.length} characters total`);
          m.characters = {
            edges: fetchedEdges,
            pageInfo: { hasNextPage: false },
          };
        } catch (err) {
          this.onLog?.(`  ! character fetch failed for ${m.type}:${m.id}: ${(err as Error)?.message ?? String(err)}`);
          m.characters = undefined;
        }
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
    this.onLog?.(`Detail fetch complete: ${details.size} total details loaded`);

    if (this.cancelled) return this.cancelledStats();

    const built = buildAll(viewer, fullAnimeLists, fullMangaLists, details);
    const { mediaToStudios, mediaToStaff, mediaToTags } = built;
    const artifacts = buildArtifacts(built, this.syncedAt);
    const totalFiles = artifacts.length;
    const totalFolders = new Set(artifacts.map(a => a.folder)).size;
    onProgress(`Artifacts planned: ${totalFiles} files, ${totalFolders} folders`, 55);
    this.onLog?.(`Artifacts: ${totalFiles} files across ${totalFolders} folders`);

    onProgress("Pre-computing hashes...", 57);
    const changedKeys = new Set(changed);
    const prepared = await this.prepareArtifacts(artifacts, changedKeys, mediaToStudios, mediaToStaff, mediaToTags);
    const skippedCount = prepared.filter(p => p.skipped).length;
    const toProcess = prepared.length - skippedCount;
    onProgress(`Hashes computed: ${toProcess} new/changed (${skippedCount} cached)`, 60);
    this.onLog?.(`Hashes computed for ${toProcess} artifacts (${skippedCount} unchanged, skipped)`);

    if (this.cancelled) return this.cancelledStats();

    const stats = await this.writeArtifacts(prepared, totalFolders, (filesDone, totalF, foldersDone) => {
      onProgress(`${filesDone}/${totalF} files (${foldersDone}/${totalFolders} folders)`, 60 + Math.round((filesDone / totalF) * 30));
    });

    if (this.cancelled) {
      this.onLog?.("Sync cancelled by user");
      return stats;
    }

    this.onLog?.(`Write complete: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.failed} problems`);

    onProgress(`Removing ${removed.length} obsolete note(s)...`, 92);
    this.onLog?.(`Removing ${removed.length} obsolete note(s)`);
    await this.handleRemovals(removed, stats);

    // Clean up orphaned studio/staff artifacts
    const currentStudioIds = new Set(built.studios.keys());
    const currentStaffIds = new Set(built.staff.keys());
    await this.cleanupSharedArtifacts(stats, currentStudioIds, "studio:", "Studio");
    await this.cleanupSharedArtifacts(stats, currentStaffIds, "staff:", "Staff");

    onProgress("Cleaning up legacy Voice-Actor files...", 94);
    await this.cleanupVoiceActorArtifacts(stats);

    onProgress("Cleaning up legacy character files...", 94);
    await this.cleanupLegacyCharacterArtifacts(stats);

    onProgress("Updating cache...", 95);
    await this.updateCache(newSummary, details);
    this.onLog?.("Cache updated successfully");

    this.onLog?.("Sync complete");
    return stats;
  }

  cancel(): void {
    this.cancelled = true;
  }

  cancelledStats(): SyncStats {
    return { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, planned: 0, cancelled: true };
  }

  private needsCharacterRefresh(detail: MediaDetail): boolean {
    const conn = detail.characters;
    if (!conn) return true;
    const edges = conn.edges;
    if (!Array.isArray(edges)) return true;
    if (edges.length === 0) return !!conn.pageInfo?.hasNextPage;
    if (conn.pageInfo?.hasNextPage) return true;
    return edges.some((edge) => !edge?.node?.id);
  }

  private mergeMediaDetail(existing: MediaDetail | undefined, incoming: MediaDetail): MediaDetail {
    if (!existing) return incoming;
    return {
      ...existing,
      ...incoming,
      title: { ...existing.title, ...incoming.title },
      coverImage: { ...existing.coverImage, ...incoming.coverImage },
      characters: this.mergeCharacterConnections(existing.characters, incoming.characters),
    };
  }

  private mergeCharacterConnections(
    existing: AnilistCharacterConnection | null | undefined,
    incoming: AnilistCharacterConnection | null | undefined,
  ): AnilistCharacterConnection | undefined {
    const existingEdges = existing?.edges ?? [];
    const incomingEdges = incoming?.edges ?? [];
    if (existingEdges.length === 0 && incomingEdges.length === 0) {
      return incoming ?? existing ?? undefined;
    }

    const merged = new Map<string, AnilistCharacterEdge>();
    for (const edge of [...existingEdges, ...incomingEdges]) {
      if (!edge?.node?.id) continue;
      const key = `${edge.node.id}:${edge.role ?? ""}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, {
          ...edge,
          voiceActors: [...(edge.voiceActors ?? [])],
        });
        continue;
      }
      merged.set(key, {
        ...prev,
        ...edge,
        node: {
          ...prev.node,
          ...edge.node,
          name: { ...prev.node.name, ...edge.node.name },
          image: { ...prev.node.image, ...edge.node.image },
        },
        voiceActors: this.mergeVoiceActors(prev.voiceActors ?? [], edge.voiceActors ?? []),
      });
    }

    return {
      pageInfo: { hasNextPage: !!existing?.pageInfo?.hasNextPage || !!incoming?.pageInfo?.hasNextPage },
      edges: [...merged.values()],
    };
  }

  private mergeVoiceActors(existing: AnilistVoiceActor[], incoming: AnilistVoiceActor[]): AnilistVoiceActor[] {
    const byId = new Map<number, AnilistVoiceActor>();
    const byName = new Map<string, AnilistVoiceActor>();
    for (const va of [...existing, ...incoming]) {
      if (!va) continue;
      const name = this.normalizeName(va.name?.full);
      if (va.id != null) {
        const prev = byId.get(va.id);
        byId.set(va.id, prev ? this.pickRicherVoiceActor(prev, va) : va);
      } else if (name) {
        const prev = byName.get(name);
        byName.set(name, prev ? this.pickRicherVoiceActor(prev, va) : va);
      }
    }
    return [...byId.values(), ...[...byName.values()].filter((va) => va.id == null)];
  }

  private pickRicherVoiceActor(a: AnilistVoiceActor, b: AnilistVoiceActor): AnilistVoiceActor {
    const score = (va: AnilistVoiceActor) => {
      let n = 0;
      if (va.name?.full) n += 2;
      if (va.name?.native) n += 1;
      if (va.language) n += 1;
      if (va.image?.large) n += 2;
      if (va.image?.medium) n += 1;
      return n;
    };

    return score(b) >= score(a)
      ? { ...a, ...b, name: { ...a.name, ...b.name }, image: { ...a.image, ...b.image } }
      : a;
  }

  private normalizeName(name: string | null | undefined): string {
    return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  private async prepareArtifacts(
    artifacts: ReturnType<typeof buildArtifacts>,
    changedKeys: Set<string>,
    mediaToStudios: Map<string, Set<number>>,
    mediaToStaff: Map<string, Set<number>>,
    mediaToTags: Map<string, Set<number>>,
  ): Promise<PreparedArtifact[]> {
    const cachedHashes = this.cache?.noteHashes ?? {};
    const needsHash: { a: ReturnType<typeof buildArtifacts>[number]; bodyForHash: string; idx: number }[] = [];
    const result: (PreparedArtifact | null)[] = new Array(artifacts.length).fill(null);

    // Pre-compute changed entity IDs for O(1) lookups
    const changedStudioIds = new Set<number>();
    const changedStaffIds = new Set<number>();
    const changedTagIds = new Set<number>();
    for (const changedKey of changedKeys) {
      const studios = mediaToStudios.get(changedKey);
      if (studios) for (const id of studios) changedStudioIds.add(id);
      const staff = mediaToStaff.get(changedKey);
      if (staff) for (const id of staff) changedStaffIds.add(id);
      const tags = mediaToTags.get(changedKey);
      if (tags) for (const id of tags) changedTagIds.add(id);
    }

    for (let i = 0; i < artifacts.length; i++) {
      const a = artifacts[i];
      const cachedHash = cachedHashes[a.uniqueKey];

      // Skip hashing if: has cached hash AND source not changed
      if (cachedHash != null && !artifactNeedsUpdate(a.uniqueKey, changedKeys, changedStudioIds, changedStaffIds, changedTagIds)) {
        result[i] = { artifact: a, bodyForHash: "", noteHash: cachedHash, skipped: true };
        continue;
      }

      const bodyForHash = stripHashMarker(a.body.split(SYNCED_AT_PLACEHOLDER).join(this.syncedAt));
      needsHash.push({ a, bodyForHash, idx: i });
    }

    // Hash only the ones that need it
    const hashes = await Promise.all(needsHash.map((p) => sha256Hex(p.bodyForHash)));

    for (let i = 0; i < needsHash.length; i++) {
      const { a, bodyForHash, idx } = needsHash[i];
      result[idx] = { artifact: a, bodyForHash, noteHash: hashes[i] };
    }

    return result as PreparedArtifact[];
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
    const activeCount = resolved.filter(({ p }) => !p.skipped).length;
    await pMapLimit(resolved, WRITE_CONCURRENCY, async ({ p, vaultPath }) => {
      if (this.cancelled) return;

      // Skip artifacts that were determined to be unchanged in prepareArtifacts
      if (p.skipped) {
        stats.skipped += 1;
        return;
      }

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
          onWriteProgress(writtenCount, activeCount, foldersWithWrites.size);
        }
      }
    });

    onWriteProgress?.(activeCount, activeCount, foldersWithWrites.size);
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

  private async cleanupSharedArtifacts(
    stats: SyncStats,
    activeIds: Set<number>,
    prefix: "studio:" | "staff:",
    label: string,
  ): Promise<void> {
    const paths = this.cache?.paths ?? {};
    const noteHashes = this.cache?.noteHashes ?? {};
    const toDelete: { k: string; vaultPath: string }[] = [];

    for (const [key, vaultPath] of Object.entries(paths)) {
      if (key.startsWith(prefix)) {
        const id = Number(key.slice(prefix.length));
        if (!activeIds.has(id)) {
          toDelete.push({ k: key, vaultPath });
        }
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
          this.onLog?.(`  ! ${label.toLowerCase()} cleanup failed for ${vaultPath}: ${(e as Error)?.message ?? e}`);
        }
      }
    });
    for (const k of deletedKeys) {
      delete noteHashes[k];
      delete paths[k];
    }

    if (removed) this.onProgress?.(`  ${label} clean-up: removed ${removed} file(s)`);
    this.cache = { ...this.cache, noteHashes, paths };
  }

  private cacheCharacterPages(mediaId: number, type: string, hasCharacters: boolean): void {
    if (!this.cache.characterPages) {
      this.cache.characterPages = {};
    }
    const key = `${type}:${mediaId}`;
    this.cache.characterPages[key] = hasCharacters;
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
      characterPages: this.cache?.characterPages ?? {},
    };
    await this.cacheStore.save(newCache);
    this.cache = newCache;
  }
}

interface PreparedArtifact {
  artifact: ReturnType<typeof buildArtifacts>[number];
  noteHash: string;
  bodyForHash: string;
  skipped?: boolean;
}

function countEntries(lists: MediaList[]): number {
  return lists.reduce((acc, l) => acc + l.entries.length, 0);
}

function artifactNeedsUpdate(
  uniqueKey: string,
  changedKeys: Set<string>,
  changedStudioIds: Set<number>,
  changedStaffIds: Set<number>,
  changedTagIds: Set<number>,
): boolean {
  // Media artifacts: uniqueKey IS the media key
  if (changedKeys.has(uniqueKey)) return true;

  // Character artifacts: "media-characters:{id}" or "media-characters:{slug}"
  if (uniqueKey.startsWith("media-characters:")) {
    const source = uniqueKey.slice("media-characters:".length);
    // Numeric ID — check if source media changed
    if (/^\d+$/.test(source)) {
      return changedKeys.has(`ANIME:${source}`) || changedKeys.has(`MANGA:${source}`);
    }
    // Slug-based — can't directly match, re-process to be safe
    return true;
  }

  // Profile and voice-actor-index: always process
  if (uniqueKey === "profile" || uniqueKey === "voice-actor-index") return true;

  // Studio artifacts: studio:{id}
  if (uniqueKey.startsWith("studio:")) {
    const studioId = Number(uniqueKey.slice("studio:".length));
    return changedStudioIds.has(studioId);
  }

  // Staff artifacts: staff:{id}
  if (uniqueKey.startsWith("staff:")) {
    const staffId = Number(uniqueKey.slice("staff:".length));
    return changedStaffIds.has(staffId);
  }

  // Tag artifacts: tag:{id} or tag:-{hash}
  if (uniqueKey.startsWith("tag:")) {
    const tagId = Number(uniqueKey.slice("tag:".length));
    if (!Number.isFinite(tagId)) return true; // synthetic tag
    return changedTagIds.has(tagId);
  }

  return false;
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
