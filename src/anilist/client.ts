import { requestUrl, RequestUrlResponse } from "obsidian";
import type { MediaDetail, Viewer, MediaList, MediaListCollection } from "../types";
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

export interface RetryInfo {
  attempt: number;
  waitMs: number;
  reason: string;
}

export interface AnilistClientOptions {
  onLog?: (message: string) => void;
  onRetry?: (info: RetryInfo) => void;
}

export class AnilistClient {
  private token: string;
  private nextAllowedAt = 0;
  private currentInterval = MODERATE_INTERVAL_MS;
  private onLog?: (message: string) => void;
  private onRetry?: (info: RetryInfo) => void;

  constructor(token: string, options: AnilistClientOptions = {}) {
    this.token = token;
    this.onLog = options.onLog;
    this.onRetry = options.onRetry;
  }

  async request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.runWithRetry(async () => {
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

      if (response.status === 429) {
        const ra = Number(response.headers["retry-after"] ?? "60");
        const err = new Error("rate-limited") as Error & { status: number; retryAfter: number };
        err.status = 429;
        err.retryAfter = Number.isFinite(ra) ? ra : 60;
        throw err;
      }

      const json = (typeof response.json === "object" && response.json !== null
        ? response.json
        : JSON.parse(response.text)) as { data?: T; errors?: { message: string }[] };

      if (json.errors && json.errors.length > 0) {
        const err = new Error(json.errors[0]?.message ?? "AniList error") as Error & { status: number };
        err.status = response.status;
        throw err;
      }

      if (!json.data) {
        throw new Error(`AniList returned no data (status ${response.status})`);
      }

      const remaining = Number(response.headers["x-ratelimit-remaining"] ?? "30");
      const reset = Number(response.headers["x-ratelimit-reset"] ?? "0");
      this.updateRateLimit(remaining, reset);

      return json.data;
    });
  }

  private async reserveSlot(): Promise<void> {
    const now = Date.now();
    const reservedAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = reservedAt + this.currentInterval;
    const wait = reservedAt - now;
    if (wait > 0) await sleep(wait);
  }

  private updateRateLimit(remaining: number, resetEpoch: number): void {
    if (Number.isFinite(remaining) && remaining >= 0) {
      if (remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
        const resetMs = resetEpoch * 1000;
        if (resetMs > Date.now()) {
          this.nextAllowedAt = resetMs;
          this.currentInterval = MODERATE_INTERVAL_MS;
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
  }

  private async runWithRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
    await this.reserveSlot();
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & { status?: number; retryAfter?: number };
      if (e?.status === 429 && attempt <= 3) {
        const waitMs = (e.retryAfter ?? 60) * 1000;
        this.currentInterval = SLOW_INTERVAL_MS;
        this.onRetry?.({ attempt, waitMs, reason: "rate-limited" });
        await sleep(waitMs);
        this.nextAllowedAt = Date.now() + this.currentInterval;
        return this.runWithRetry(fn, attempt + 1);
      }
      if (e?.status && e.status >= 500 && attempt <= 3) {
        const waitMs = 1000 * 2 ** (attempt - 1);
        this.onRetry?.({ attempt, waitMs, reason: `server ${e.status}` });
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

  async fetchAllCharacters(mediaId: number, type: "ANIME" | "MANGA"): Promise<AnilistCharacterEdge[]> {
    const allEdges: AnilistCharacterEdge[] = [];
    let page = 1;
    while (true) {
      const data = await this.request<{
        Media: { characters: { pageInfo: { hasNextPage: boolean }; edges: AnilistCharacterEdge[] } };
      }>(CHARACTERS_PAGE_QUERY, { id: mediaId, type, page });
      const conn = data?.Media?.characters;
      if (!conn?.edges) break;
      for (const e of conn.edges) if (e) allEdges.push(e);
      if (!conn.pageInfo?.hasNextPage) break;
      page += 1;
      if (page > 50) break;
    }
    return allEdges;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
