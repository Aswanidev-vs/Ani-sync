import type {
  MediaDetail,
  MediaList,
  MediaListCollection,
  Viewer,
} from "../types";

export const VIEWER_QUERY = `
  query Viewer {
    Viewer {
      id
      name
      siteUrl
      avatar { large medium }
      statistics {
        anime { count meanScore episodesWatched minutesWatched }
        manga { count meanScore chaptersRead volumesRead }
      }
    }
  }
`;

export const MEDIA_LIST_COLLECTION_QUERY = `
  query MediaListCollection($userName: String!, $type: MediaType!) {
    MediaListCollection(userName: $userName, type: $type) {
      lists {
        name
        isCustomList
        status
        entries {
          id
          status
          score
          progress
          progressVolumes
          repeat
          priority
          private
          notes
          startedAt { year month day }
          completedAt { year month day }
          updatedAt
          createdAt
          media {
            id
            type
            title { romaji english userPreferred }
          }
        }
      }
    }
  }
`;

export const MEDIA_DETAIL_QUERY = `
  query MediaDetail($id: Int!, $type: MediaType!) {
    Media(id: $id, type: $type) {
      id
      type
      format
      status
      siteUrl
      averageScore
      meanScore
      popularity
      episodes
      chapters
      volumes
      duration
      startDate { year month day }
      endDate { year month day }
      title { romaji english native userPreferred }
      coverImage { large medium color }
      bannerImage
      description(asHtml: false)
      genres
      tags { id name rank isMediaSpoiler isGeneralSpoiler }
      studios(isMain: true) {
        edges { isMain node { id name siteUrl isAnimationStudio } }
      }
      staff(perPage: 6, sort: RELEVANCE) {
        edges { role node { id name { full native } siteUrl language image { large medium } } }
      }
      relations {
        edges {
          relationType
          node { id type title { romaji english userPreferred } }
        }
      }
    }
  }
`;

export const MEDIA_DETAILS_BATCH_QUERY = `
  query MediaDetailsBatch($ids: [Int!], $type: MediaType!, $page: Int!) {
    Page(perPage: 50, page: $page) {
      pageInfo { hasNextPage }
      media(id_in: $ids, type: $type) {
        id
        type
        format
        status
        siteUrl
        averageScore
        meanScore
        popularity
        episodes
        chapters
        volumes
        duration
        startDate { year month day }
        endDate { year month day }
        title { romaji english native userPreferred }
        coverImage { large medium color }
        bannerImage
        description(asHtml: false)
        genres
        tags { id name rank isMediaSpoiler isGeneralSpoiler }
        studios(isMain: true) {
          edges { isMain node { id name siteUrl isAnimationStudio } }
        }
        staff(perPage: 6, sort: RELEVANCE) {
          edges { role node { id name { full native } siteUrl language image { large medium } } }
        }
        relations {
          edges {
            relationType
            node { id type title { romaji english userPreferred } }
          }
        }
      }
    }
  }
`;

export const SUMMARY_QUERY = `
  query Summary($userName: String!, $type: MediaType!) {
    MediaListCollection(userName: $userName, type: $type) {
      lists {
        entries {
          id
          updatedAt
          media { id type }
        }
      }
    }
  }
`;

export type ViewerResponse = { Viewer: Viewer };
export type MediaListCollectionResponse = { MediaListCollection: MediaListCollection };
export type MediaDetailResponse = { Media: MediaDetail };
export type MediaDetailsBatchResponse = {
  Page: { pageInfo: { hasNextPage: boolean }; media: MediaDetail[] };
};
export type SummaryResponse = { MediaListCollection: MediaListCollection };

export type SummaryEntry = { id: number; updatedAt: number | null; media: { id: number; type: "ANIME" | "MANGA" } };
export type SummaryList = { entries: SummaryEntry[] };
export type SummaryCollection = { lists?: SummaryList[] | null };

export function flattenSummaryToMap(...collections: SummaryCollection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const col of collections) {
    for (const list of col.lists ?? []) {
      for (const e of list.entries ?? []) {
        if (e.updatedAt == null) continue;
        out[`${e.media.type}:${e.media.id}`] = e.updatedAt;
      }
    }
  }
  return out;
}

export function collectUniqueMediaFromFull(
  ...listGroups: { lists?: MediaList[] | null }[]
): { id: number; type: "ANIME" | "MANGA"; title: string }[] {
  const seen = new Map<string, { id: number; type: "ANIME" | "MANGA"; title: string }>();
  for (const col of listGroups) {
    for (const list of col.lists ?? []) {
      for (const e of list.entries) {
        const k = `${e.media.type}:${e.media.id}`;
        if (!seen.has(k)) {
          const t = e.media.title;
          seen.set(k, {
            id: e.media.id,
            type: e.media.type,
            title: t?.userPreferred ?? t?.english ?? t?.romaji ?? String(e.media.id),
          });
        }
      }
    }
  }
  return [...seen.values()];
}
