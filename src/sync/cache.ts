import type { MediaDetail } from "../types";

export interface AnisyncCache {
  version: 1;
  summary: Record<string, number>;
  details: Record<string, MediaDetail>;
  noteHashes: Record<string, string>;
  paths: Record<string, string>;
}

export function emptyCache(): AnisyncCache {
  return { version: 1, summary: {}, details: {}, noteHashes: {}, paths: {} };
}

export function summaryKey(type: "ANIME" | "MANGA", mediaId: number): string {
  return `${type}:${mediaId}`;
}

export function diffSummary(
  oldSummary: Record<string, number>,
  newSummary: Record<string, number>,
): { changed: string[]; removed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const oldKeys = new Set(Object.keys(oldSummary));
  const newKeys = new Set(Object.keys(newSummary));
  for (const k of newKeys) {
    if (!oldKeys.has(k)) {
      changed.push(k);
    } else if (oldSummary[k] !== newSummary[k]) {
      changed.push(k);
    } else {
      unchanged.push(k);
    }
  }
  for (const k of oldKeys) {
    if (!newKeys.has(k)) removed.push(k);
  }
  return { changed, removed, unchanged };
}
