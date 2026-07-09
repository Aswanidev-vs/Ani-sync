export interface AnilistTitle {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
  userPreferred?: string | null;
}

export interface AnilistFuzzyDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

export interface AnilistCover {
  large?: string | null;
  medium?: string | null;
  color?: string | null;
}

export interface AnilistTag {
  id: number;
  name: string;
  rank?: number | null;
  isMediaSpoiler?: boolean | null;
  isGeneralSpoiler?: boolean | null;
}

export interface AnilistStudioEdge {
  isMain: boolean;
  node: {
    id: number;
    name: string;
    siteUrl?: string | null;
    isAnimationStudio: boolean;
  };
}

export interface AnilistStaffEdge {
  role?: string | null;
  node: {
    id: number;
    name: { full?: string | null; native?: string | null };
    siteUrl?: string | null;
    language?: string | null;
    image?: { large?: string | null; medium?: string | null } | null;
  };
}

export interface AnilistCharacterEdge {
  role: string;
  voiceActors?: AnilistVoiceActor[] | null;
  node: {
    id: number;
    name: { full?: string | null; native?: string | null };
    image?: { large?: string | null; medium?: string | null } | null;
    description?: string | null;
    siteUrl?: string | null;
    gender?: string | null;
    age?: string | null;
    dateOfBirth?: { year?: number | null; month?: number | null; day?: number | null } | null;
  };
}

export interface AnilistCharacterConnection {
  pageInfo?: { hasNextPage: boolean } | null;
  edges?: AnilistCharacterEdge[] | null;
}

export interface AnilistVoiceActor {
  id: number;
  name: { full?: string | null; native?: string | null };
  language?: string | null;
  image?: { large?: string | null; medium?: string | null } | null;
}

export interface AnilistRelationEdge {
  relationType: string;
  node: {
    id: number;
    type: "ANIME" | "MANGA";
    title: AnilistTitle;
  };
}

export interface MediaDetail {
  id: number;
  type: "ANIME" | "MANGA";
  format?: string | null;
  status?: string | null;
  siteUrl?: string | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  episodes?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  duration?: number | null;
  startDate?: AnilistFuzzyDate | null;
  endDate?: AnilistFuzzyDate | null;
  title: AnilistTitle;
  coverImage: AnilistCover;
  bannerImage?: string | null;
  description?: string | null;
  genres?: string[] | null;
  tags?: AnilistTag[] | null;
  studios?: { edges?: AnilistStudioEdge[] | null } | null;
  staff?: { edges?: AnilistStaffEdge[] | null } | null;
  relations?: { edges?: AnilistRelationEdge[] | null } | null;
  characters?: AnilistCharacterConnection | null;
}

export interface MediaListEntry {
  id: number;
  status?: string | null;
  score?: number | null;
  progress?: number | null;
  progressVolumes?: number | null;
  repeat?: number | null;
  priority?: number | null;
  private?: boolean | null;
  notes?: string | null;
  startedAt?: AnilistFuzzyDate | null;
  completedAt?: AnilistFuzzyDate | null;
  updatedAt?: number | null;
  createdAt?: number | null;
  media: { id: number; type: "ANIME" | "MANGA"; title: AnilistTitle };
}

export interface MediaList {
  name: string;
  isCustomList?: boolean | null;
  status?: string | null;
  entries: MediaListEntry[];
}

export interface MediaListCollection {
  lists?: MediaList[] | null;
}

export interface ViewerStatistics {
  count?: number | null;
  meanScore?: number | null;
  episodesWatched?: number | null;
  minutesWatched?: number | null;
  chaptersRead?: number | null;
  volumesRead?: number | null;
}

export interface Viewer {
  id: number;
  name: string;
  siteUrl?: string | null;
  avatar?: { large?: string | null; medium?: string | null } | null;
  statistics?: { anime?: ViewerStatistics; manga?: ViewerStatistics } | null;
}
