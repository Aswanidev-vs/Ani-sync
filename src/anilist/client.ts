import { requestUrl, RequestUrlResponse } from "obsidian";
import type { MediaDetail, Viewer, MediaList, MediaListCollection, AnilistVoiceActor } from "../types";
import {
  VIEWER_QUERY,
  MEDIA_LIST_COLLECTION_QUERY,
  MEDIA_DETAIL_QUERY,
  MEDIA_DETAILS_BATCH_QUERY,
  SUMMARY_QUERY,
  CHARACTERS_PAGE_QUERY,
  SummaryCollection,
} from "./queries";
import type { AnilistCharacterEdge } from "../types";

const ENDPOINT = "https://graphql.anilist.co";
const FAST_INTERVAL_MS = 400;
const MODERATE_INTERVAL_MS = 700;
const SLOW_INTERVAL_MS = 1500;
const BATCH_PAGE_SIZE = 50;
const BATCH_PAGE_SAFETY_CAP = 50;

// Token bucket config
const TOKEN_BUCKET_CAPACITY = 90;
const TOKEN_BUCKET_REFILL_RATE = 90; // tokens per 60 seconds
const TOKEN_BUCKET_REFILL_INTERVAL = 60000; // 60s

export interface RetryInfo {
  attempt: number;
  waitMs: number;
  reason: string;
}

export interface AnilistClientOptions {
  onLog?: (message: string) => void;
  onRetry?: (info: RetryInfo) => void;
}

export interface RateLimitState {
  tokens: number;
  maxTokens: number;
  currentInterval: number;
  nextAllowedAt: number;
  lastRefill: number;
  requestCount: number;
}

export class AnilistClient {
  private token: string;
  private nextAllowedAt = 0;
  private currentInterval = MODERATE_INTERVAL_MS;
  private onLog?: (message: string) => void;
  private onRetry?: (info: RetryInfo) => void;

  // Token bucket fields
  private tokens: number = TOKEN_BUCKET_CAPACITY;
  private lastRefill: number = Date.now();
  private requestCount = 0;

  constructor(token: string, options: AnilistClientOptions = {}) {
    this.token = token;
    this.onLog = options.onLog;
    this.onRetry = options.onRetry;
  }

  getRateLimitState(): RateLimitState {
    return {
      tokens: this.tokens,
      maxTokens: TOKEN_BUCKET_CAPACITY,
      currentInterval: this.currentInterval,
      nextAllowedAt: this.nextAllowedAt,
      lastRefill: this.lastRefill,
      requestCount: this.requestCount,
    };
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= TOKEN_BUCKET_REFILL_INTERVAL) {
      const refill = Math.floor(elapsed / TOKEN_BUCKET_REFILL_INTERVAL) * TOKEN_BUCKET_REFILL_RATE;
      this.tokens = Math.min(TOKEN_BUCKET_CAPACITY, this.tokens + refill);
      this.lastRefill += Math.floor(elapsed / TOKEN_BUCKET_REFILL_INTERVAL) * TOKEN_BUCKET_REFILL_INTERVAL;
    }
  }

  private consumeToken(): void {
    this.refillTokens();
    if (this.tokens > 0) {
      this.tokens -= 1;
    }
  }

  private getTokenWaitMs(): number {
    this.refillTokens();
    if (this.tokens > 0) return 0;
    return Math.max(0, TOKEN_BUCKET_REFILL_INTERVAL - (Date.now() - this.lastRefill));
  }

  async request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.runWithRetry(async () => {
      this.consumeToken();
      this.requestCount += 1;

      const queryName = query.match(/query\s+(\w+)/)?.[1] ?? "Unknown";
      const varSummary = variables ? JSON.stringify(variables).slice(0, 120) : "{}";
      this.onLog?.(`  -> [req #${this.requestCount}] ${queryName} ${varSummary} | bucket: ${this.tokens}/${TOKEN_BUCKET_CAPACITY} tokens, interval: ${this.currentInterval}ms`);

      const response: RequestUrlResponse = await requestUrl({
        url: ENDPOINT,
        method: "POST",
        throw: false,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });

      const remaining = Number(response.headers["x-ratelimit-remaining"] ?? "-1");
      const reset = Number(response.headers["x-ratelimit-reset"] ?? "0");
      this.onLog?.(`  <- [res] status=${response.status} | ratelimit: remaining=${remaining}, reset=${reset > 0 ? new Date(reset * 1000).toISOString().slice(11, 19) : "n/a"}`);

      if (response.status === 429) {
        const ra = Number(response.headers["retry-after"] ?? "60");
        const err = new Error("rate-limited") as Error & { status: number; retryAfter: number };
        err.status = 429;
        err.retryAfter = Number.isFinite(ra) ? ra : 60;
        this.onLog?.(`  !! 429 rate-limited, Retry-After: ${err.retryAfter}s`);
        throw err;
      }

      const json = (typeof response.json === "object" && response.json !== null
        ? response.json
        : JSON.parse(response.text)) as { data?: T; errors?: { message: string }[] };

      if (json.errors && json.errors.length > 0) {
        const errMsg = json.errors[0]?.message ?? "AniList error";
        const err = new Error(errMsg) as Error & { status: number };
        err.status = response.status;

        if (response.status === 400 && /(cost|complexity|too ?complex)/i.test(errMsg)) {
          this.onLog?.(`  !! 400 complexity error: ${errMsg}`);
        }

        throw err;
      }

      if (!json.data) {
        throw new Error(`AniList returned no data (status ${response.status})`);
      }

      this.updateRateLimit(remaining, reset);
      return json.data;
    });
  }

  private async reserveSlot(): Promise<void> {
    const now = Date.now();
    const reservedAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = reservedAt + this.currentInterval;
    const wait = reservedAt - now;

    const bucketWait = this.getTokenWaitMs();
    const totalWait = Math.max(wait, bucketWait);

    if (totalWait > 0) {
      this.onLog?.(`  .. waiting ${totalWait}ms (slot: ${wait}ms, bucket: ${bucketWait}ms)`);
      await sleep(totalWait);
    }
  }

  private updateRateLimit(remaining: number, resetEpoch: number): void {
    const prevInterval = this.currentInterval;
    if (Number.isFinite(remaining) && remaining >= 0) {
      if (remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
        const resetMs = resetEpoch * 1000;
        if (resetMs > Date.now()) {
          this.nextAllowedAt = resetMs;
          this.currentInterval = MODERATE_INTERVAL_MS;
          this.onLog?.(`  .. rate limit: 0 remaining, pausing until reset at ${new Date(resetMs).toISOString().slice(11, 19)}`);
          return;
        }
      }
      if (remaining > 10) {
        this.currentInterval = FAST_INTERVAL_MS;
      } else if (remaining > 5) {
        this.currentInterval = MODERATE_INTERVAL_MS;
      } else {
        this.currentInterval = SLOW_INTERVAL_MS;
      }
    }
    if (this.currentInterval !== prevInterval) {
      this.onLog?.(`  .. rate limit: interval ${prevInterval}ms -> ${this.currentInterval}ms (remaining: ${remaining})`);
    }
  }

  private async runWithRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
    await this.reserveSlot();
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & { status?: number; retryAfter?: number };
      const errMsg = e?.message ?? "";

      // 429 rate-limited: retry up to 3 times
      if (e?.status === 429 && attempt <= 3) {
        const waitMs = (e.retryAfter ?? 60) * 1000;
        this.currentInterval = SLOW_INTERVAL_MS;
        this.tokens = 0; // drain bucket on 429
        this.onRetry?.({ attempt, waitMs, reason: "rate-limited" });
        this.onLog?.(`  !! retry #${attempt} for 429, sleeping ${Math.round(waitMs / 1000)}s, interval -> ${SLOW_INTERVAL_MS}ms`);
        await sleep(waitMs);
        this.nextAllowedAt = Date.now() + this.currentInterval;
        return this.runWithRetry(fn, attempt + 1);
      }

      // 400 complexity error: retry once
      if (e?.status === 400 && /(cost|complexity|too ?complex)/i.test(errMsg) && attempt <= 2) {
        const waitMs = 2000 * attempt;
        this.onRetry?.({ attempt, waitMs, reason: "complexity-400" });
        this.onLog?.(`  !! retry #${attempt} for 400 complexity, sleeping ${waitMs}ms`);
        await sleep(waitMs);
        this.nextAllowedAt = Date.now() + this.currentInterval;
        return this.runWithRetry(fn, attempt + 1);
      }

      // 5xx server errors: retry up to 3 times with exponential backoff
      if (e?.status && e.status >= 500 && attempt <= 3) {
        const waitMs = 1000 * 2 ** (attempt - 1);
        this.onRetry?.({ attempt, waitMs, reason: `server ${e.status}` });
        this.onLog?.(`  !! retry #${attempt} for ${e.status}, sleeping ${waitMs}ms`);
        await sleep(waitMs);
        return this.runWithRetry(fn, attempt + 1);
      }

      throw err;
    }
  }

  async fetchViewer(): Promise<Viewer> {
    const data = await this.request<{ Viewer: Viewer }>(VIEWER_QUERY);
    const v = data?.Viewer;
    if (!v) throw new Error("Viewer query returned null — check your AniList token.");
    return v;
  }

  async fetchSummary(username: string): Promise<{ animeLists: SummaryCollection["lists"]; mangaLists: SummaryCollection["lists"] }> {
    const [a, m] = await Promise.all([
      this.request<{ MediaListCollection: { lists?: SummaryCollection["lists"] } }>(SUMMARY_QUERY, {
        userName: username,
        type: "ANIME",
      }),
      this.request<{ MediaListCollection: { lists?: SummaryCollection["lists"] } }>(SUMMARY_QUERY, {
        userName: username,
        type: "MANGA",
      }),
    ]);
    return {
      animeLists: a?.MediaListCollection?.lists ?? [],
      mangaLists: m?.MediaListCollection?.lists ?? [],
    };
  }

  async fetchFullList(type: "ANIME" | "MANGA", username: string): Promise<MediaList[]> {
    const data = await this.request<{ MediaListCollection: MediaListCollection }>(
      MEDIA_LIST_COLLECTION_QUERY,
      { userName: username, type },
    );
    return (data?.MediaListCollection?.lists ?? []);
  }

  async fetchDetail(type: "ANIME" | "MANGA", id: number): Promise<MediaDetail | null> {
    const data = await this.request<{ Media: MediaDetail | null }>(MEDIA_DETAIL_QUERY, { id, type });
    return data?.Media ?? null;
  }

  async fetchDetails(type: "ANIME" | "MANGA", ids: number[]): Promise<MediaDetail[]> {
    const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
    if (unique.length === 0) return [];
    const out: MediaDetail[] = [];
    for (let i = 0; i < unique.length; i += BATCH_PAGE_SIZE) {
      const chunk = unique.slice(i, i + BATCH_PAGE_SIZE);
      let page = 1;
      while (true) {
        const data = await this.request<{
          Page: { pageInfo: { hasNextPage: boolean }; media: MediaDetail[] };
        }>(MEDIA_DETAILS_BATCH_QUERY, { ids: chunk, type, page });
        const p = data?.Page;
        if (!p) break;
        for (const m of p.media ?? []) if (m) out.push(m);
        if (!p.pageInfo?.hasNextPage) break;
        page += 1;
        if (page > BATCH_PAGE_SAFETY_CAP) break;
      }
    }
    return out;
  }

  async fetchAllCharacters(mediaId: number, type: "ANIME" | "MANGA", startPage = 1, perPage = 50): Promise<AnilistCharacterEdge[]> {
    const edgeMap = new Map<string, AnilistCharacterEdge>();
    let page = startPage;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    this.onLog?.(`  [${type}:${mediaId}] starting character fetch from page ${page}, perPage=${perPage}`);

    while (true) {
      try {
        const data = await this.request<{
          Media: { characters: { pageInfo: { hasNextPage: boolean }; edges: AnilistCharacterEdge[] } };
        }>(CHARACTERS_PAGE_QUERY, { id: mediaId, type, page, perPage });
        const conn = data?.Media?.characters;
        if (!conn?.edges) {
          this.onLog?.(`  [${type}:${mediaId}] page ${page}: no edges returned, stopping`);
          break;
        }

        consecutiveFailures = 0; // reset on success
        const newCharsOnPage = conn.edges.filter(e => e?.node?.id).length;

        for (const e of conn.edges) {
          if (!e?.node?.id) continue;
          const key = `${e.node.id}:${e.role ?? ""}`;
          const existing = edgeMap.get(key);
          if (!existing) {
            edgeMap.set(key, {
              ...e,
              voiceActors: [...(e.voiceActors ?? [])],
            });
            continue;
          }
          existing.voiceActors = mergeVoiceActors(existing.voiceActors ?? [], e.voiceActors ?? []);
        }

        this.onLog?.(`  [${type}:${mediaId}] page ${page}: ${newCharsOnPage} chars, total ${edgeMap.size}, hasNextPage=${!!conn.pageInfo?.hasNextPage}`);

        if (!conn.pageInfo?.hasNextPage) break;
        page += 1;
        if (page > 50) {
          this.onLog?.(`  [${type}:${mediaId}] hit page cap (50), stopping at ${edgeMap.size} chars`);
          break;
        }
      } catch (err) {
        const e = err as Error & { status?: number };
        consecutiveFailures += 1;
        this.onLog?.(`  ! page ${page} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e?.message ?? String(err)}`);

        // If we hit a 400 complexity error, halve perPage, adjust page to maintain offset, and retry
        if (e?.status === 400 && /(cost|complexity|too ?complex)/i.test(e?.message ?? "") && perPage >= 25) {
          const offset = (page - 1) * perPage;
          perPage = Math.floor(perPage / 2);
          page = Math.floor(offset / perPage) + 1;
          consecutiveFailures = 0;
          this.onLog?.(`  [${type}:${mediaId}] complexity error on page, retrying with perPage=${perPage} at page ${page}`);
          continue;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.onLog?.(`  ! too many consecutive failures (${MAX_CONSECUTIVE_FAILURES}), aborting character fetch for media ${mediaId}`);
          break;
        }

        // On failure, move to the next page (skip the failed page)
        page += 1;
        if (page > 50) break;
      }
    }

    const allEdges = [...edgeMap.values()];

    // Filter to Japanese VAs per character; fall back to all VAs if none tagged Japanese.
    for (const edge of allEdges) {
      if (edge.voiceActors && edge.voiceActors.length > 0) {
        const japanese = edge.voiceActors.filter(va => va?.language === "Japanese");
        if (japanese.length > 0) {
          edge.voiceActors = japanese;
        }
      }
    }

    this.onLog?.(`  [${type}:${mediaId}] finished: ${allEdges.length} unique characters fetched`);
    return allEdges;
  }
}

function mergeVoiceActors(existing: AnilistVoiceActor[], incoming: AnilistVoiceActor[]): AnilistVoiceActor[] {
  const byId = new Map<number, AnilistVoiceActor>();
  const byName = new Map<string, AnilistVoiceActor>();

  for (const va of [...existing, ...incoming]) {
    if (!va) continue;
    const name = normalizeName(va.name?.full);
    if (va.id != null) {
      const prev = byId.get(va.id);
      byId.set(va.id, prev ? pickRicherVoiceActor(prev, va) : va);
    } else if (name) {
      const prev = byName.get(name);
      byName.set(name, prev ? pickRicherVoiceActor(prev, va) : va);
    }
  }

  return [...byId.values(), ...[...byName.values()].filter((va) => va.id == null)];
}

function pickRicherVoiceActor(a: AnilistVoiceActor, b: AnilistVoiceActor): AnilistVoiceActor {
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

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
