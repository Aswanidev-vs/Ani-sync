import { slugify, pickTitle } from "./slugify";
import type {
  AnilistCharacterEdge,
  AnilistRelationEdge,
  AnilistStaffEdge,
  AnilistStudioEdge,
  AnilistTag,
  AnilistVoiceActor,
  AnilistTitle,
  MediaDetail,
  MediaList,
  MediaListEntry,
  Viewer,
} from "../types";

export const SYNCED_AT_PLACEHOLDER = "__SYNCED_AT_PLACEHOLDER__";

export interface ProfileData {
  viewer: Viewer;
  animeCount: number;
  mangaCount: number;
  animeLists: MediaList[];
  mangaLists: MediaList[];
}

export interface MediaNote {
  entryId: number;
  mediaId: number;
  type: "ANIME" | "MANGA";
  title: AnilistTitle;
  format?: string | null;
  status?: string | null;
  userStatus?: string | null;
  score?: number | null;
  progress?: number | null;
  progressVolumes?: number | null;
  repeat?: number | null;
  priority?: number | null;
  startedAt: string | null;
  completedAt: string | null;
  notes?: string | null;
  siteUrl?: string | null;
  coverColor?: string | null;
  coverLarge?: string | null;
  coverMedium?: string | null;
  description?: string | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  episodes?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  duration?: number | null;
  startDate: string | null;
  endDate: string | null;
  bannerImage?: string | null;
  listName?: string;
  studios: { id: number; name: string; siteUrl?: string | null; isAnimationStudio: boolean }[];
  staff: { id: number; name: string; native?: string | null; siteUrl?: string | null; role?: string | null; imageLarge?: string | null; imageMedium?: string | null }[];
  genres: string[];
  tags: { id: number; name: string; rank?: number | null }[];
  relations: { id: number; type: "ANIME" | "MANGA"; title: string; relationType: string }[];
  characters: { id: number; name: string; role?: string | null;
    voiceActors: { id: number; name: string }[] }[];
}

export interface StudioArtifactData {
  id: number;
  name: string;
  siteUrl?: string | null;
  isAnimationStudio: boolean;
}

export interface StaffArtifactData {
  id: number;
  name: string;
  native?: string | null;
  siteUrl?: string | null;
  role?: string | null;
  imageLarge?: string | null;
  imageMedium?: string | null;
}

export interface TagArtifactData {
  id: number;
  name: string;
  rank?: number | null;
}

export interface CharacterArtifactData {
  id: number;
  name: string;
  native?: string | null;
  imageLarge?: string | null;
  imageMedium?: string | null;
  siteUrl?: string | null;
  gender?: string | null;
  age?: string | null;
  dateOfBirth?: string | null;
  description?: string | null;
  voiceActors: { id: number; name: string; native: string | null; language: string | null; imageLarge: string | null; imageMedium: string | null; siteUrl: string | null }[];
}

export interface VoiceActorArtifactData {
  id: number;
  name: string;
  native?: string | null;
  language?: string | null;
  imageLarge?: string | null;
  imageMedium?: string | null;
  siteUrl?: string | null;
}

export interface BuiltArtifacts {
  profile: ProfileData;
  media: MediaNote[];
  studios: Map<number, StudioArtifactData>;
  staff: Map<number, StaffArtifactData>;
  tags: Map<number, TagArtifactData>;
  characters: Map<number, CharacterArtifactData>;
  voiceActors: Map<number, VoiceActorArtifactData>;
  relations: { id: number; type: "ANIME" | "MANGA"; title: string; relationType: string }[];
  animeLists: MediaList[];
  mangaLists: MediaList[];
}

export interface NoteArtifact {
  folder: string;
  filename: string;
  body: string;
  uniqueKey: string;
}

export function buildAll(
  viewer: Viewer,
  animeLists: MediaList[],
  mangaLists: MediaList[],
  details: Map<string, MediaDetail>,
): BuiltArtifacts {
  const studios = new Map<number, StudioArtifactData>();
  const staff = new Map<number, StaffArtifactData>();
  const tags = new Map<number, TagArtifactData>();
  const characters = new Map<number, CharacterArtifactData>();
  const voiceActors = new Map<number, VoiceActorArtifactData>();
  const relations: { id: number; type: "ANIME" | "MANGA"; title: string; relationType: string }[] = [];

  const mediaNotes: MediaNote[] = [];

  for (const list of [...animeLists, ...mangaLists]) {
    for (const entry of list.entries as MediaListEntry[]) {
      const detail = details.get(`${entry.media.type}:${entry.media.id}`);
      if (!detail) continue;
      mediaNotes.push(buildMediaNote(entry, detail, list.name));
      collectFromDetail(detail, studios, staff, tags, characters, voiceActors, relations);
    }
  }

  return {
    profile: { viewer, animeCount: countEntries(animeLists), mangaCount: countEntries(mangaLists), animeLists, mangaLists },
    media: mediaNotes,
    studios,
    staff,
    tags,
    characters,
    voiceActors,
    relations,
    animeLists,
    mangaLists,
  };
}

function countEntries(lists: MediaList[]): number {
  return lists.reduce((acc, l) => acc + l.entries.length, 0);
}

function collectFromDetail(
  detail: MediaDetail,
  studios: Map<number, StudioArtifactData>,
  staff: Map<number, StaffArtifactData>,
  tags: Map<number, TagArtifactData>,
  characters: Map<number, CharacterArtifactData>,
  voiceActors: Map<number, VoiceActorArtifactData>,
  relations: { id: number; type: "ANIME" | "MANGA"; title: string; relationType: string }[],
): void {
  for (const edge of detail.studios?.edges ?? []) {
    if (!edge?.node) continue;
    if (!studios.has(edge.node.id)) {
      studios.set(edge.node.id, {
        id: edge.node.id,
        name: edge.node.name,
        siteUrl: edge.node.siteUrl,
        isAnimationStudio: edge.node.isAnimationStudio,
      });
    }
  }
  for (const edge of detail.staff?.edges ?? []) {
    if (!edge?.node) continue;
    const role = edge.role ?? "";
    if (!staff.has(edge.node.id)) {
      staff.set(edge.node.id, {
        id: edge.node.id,
        name: edge.node.name?.full ?? "(unknown)",
        native: edge.node.name?.native,
        siteUrl: edge.node.siteUrl,
        role,
        imageLarge: edge.node.image?.large ?? undefined,
        imageMedium: edge.node.image?.medium ?? undefined,
      });
    } else {
      const existing = staff.get(edge.node.id)!;
      if (existing.role !== role && existing.role && role && !existing.role.includes(role)) {
        staff.set(edge.node.id, { ...existing, role: `${existing.role}, ${role}` });
      }
    }
  }
  for (const t of detail.tags ?? []) {
    if (!tags.has(t.id)) tags.set(t.id, { id: t.id, name: t.name, rank: t.rank });
  }
  for (const edge of detail.characters?.edges ?? []) {
    if (!edge?.node) continue;
    if (!characters.has(edge.node.id)) {
      const desc = edge.node.description;
      characters.set(edge.node.id, {
        id: edge.node.id,
        name: edge.node.name?.full ?? "(unknown)",
        native: edge.node.name?.native,
        imageLarge: edge.node.image?.large ?? undefined,
        imageMedium: edge.node.image?.medium ?? undefined,
        siteUrl: edge.node.siteUrl,
        gender: edge.node.gender,
        age: edge.node.age,
        dateOfBirth: formatFuzzyDate(edge.node.dateOfBirth),
        description: desc ? stripHtml(desc) : undefined,
        voiceActors: [],
      });
    }
    for (const va of edge.voiceActors ?? []) {
      if (!va) continue;
      if (!voiceActors.has(va.id)) {
        voiceActors.set(va.id, {
          id: va.id,
          name: va.name?.full ?? "(unknown)",
          native: va.name?.native,
          language: va.language,
          imageLarge: va.image?.large ?? undefined,
          imageMedium: va.image?.medium ?? undefined,
          siteUrl: undefined,
        });
      }
    }
  }
  for (const edge of detail.relations?.edges ?? []) {
    if (!edge?.node) continue;
    relations.push({
      id: edge.node.id,
      type: edge.node.type,
      title: pickTitle(edge.node.title),
      relationType: edge.relationType,
    });
  }
}

function buildMediaNote(entry: MediaListEntry, detail: MediaDetail, listName: string): MediaNote {
  return {
    entryId: entry.id,
    mediaId: detail.id,
    type: detail.type,
    title: detail.title,
    format: detail.format,
    status: detail.status,
    userStatus: entry.status ?? undefined,
    score: entry.score,
    progress: entry.progress,
    progressVolumes: entry.progressVolumes,
    repeat: entry.repeat,
    priority: entry.priority,
    startedAt: formatFuzzyDate(entry.startedAt),
    completedAt: formatFuzzyDate(entry.completedAt),
    notes: entry.notes,
    siteUrl: detail.siteUrl,
    coverColor: detail.coverImage?.color,
    coverLarge: detail.coverImage?.large,
    coverMedium: detail.coverImage?.medium,
    description: detail.description,
    averageScore: detail.averageScore,
    meanScore: detail.meanScore,
    popularity: detail.popularity,
    episodes: detail.episodes,
    chapters: detail.chapters,
    volumes: detail.volumes,
    duration: detail.duration,
    startDate: formatFuzzyDate(detail.startDate),
    endDate: formatFuzzyDate(detail.endDate),
    bannerImage: detail.bannerImage,
    listName,
    studios: (detail.studios?.edges ?? [])
      .filter((e): e is AnilistStudioEdge => !!e?.node)
      .map((e) => ({ id: e.node.id, name: e.node.name, siteUrl: e.node.siteUrl, isAnimationStudio: e.node.isAnimationStudio })),
    staff: (detail.staff?.edges ?? [])
      .filter((e): e is AnilistStaffEdge => !!e?.node)
      .map((e) => ({
        id: e.node.id,
        name: e.node.name?.full ?? "(unknown)",
        native: e.node.name?.native,
        siteUrl: e.node.siteUrl,
        role: e.role,
        imageLarge: e.node.image?.large ?? undefined,
        imageMedium: e.node.image?.medium ?? undefined,
      })),
    genres: detail.genres ?? [],
    tags: (detail.tags ?? []).map((t: AnilistTag) => ({ id: t.id, name: t.name, rank: t.rank })),
    relations: (detail.relations?.edges ?? [])
      .filter((e): e is AnilistRelationEdge => !!e?.node)
      .map((e) => ({
        id: e.node.id,
        type: e.node.type,
        title: pickTitle(e.node.title),
        relationType: e.relationType,
      })),
    characters: (detail.characters?.edges ?? [])
      .filter((e): e is AnilistCharacterEdge => !!e?.node)
      .map((e) => ({
        id: e.node.id,
        name: e.node.name?.full ?? "(unknown)",
        role: e.role,
        voiceActors: (e.voiceActors ?? [])
          .filter((va): va is AnilistVoiceActor => !!va)
          .map((va) => ({ id: va.id, name: va.name?.full ?? "(unknown)" })),
      })),
  };
}

function formatFuzzyDate(d: { year?: number | null; month?: number | null; day?: number | null } | null | undefined): string | null {
  if (!d) return null;
  if (!d.year) return null;
  const m = d.month ? String(d.month).padStart(2, "0") : "01";
  const day = d.day ? String(d.day).padStart(2, "0") : "01";
  return `${d.year}-${m}-${day}`;
}

function renderFrontmatter(obj: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        if (vv === null || vv === undefined) continue;
        lines.push(`  ${kk}: ${yamlScalar(vv)}`);
      }
    } else if (Array.isArray(v)) {
      if (v.length > 0) {
        lines.push(`${k}: [${v.map(item => yamlScalar(item)).join(", ")}]`);
      }
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (/[:#&*!|>'"%@`{}[\],\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n");

  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildArtifacts(built: BuiltArtifacts, syncedAt: string): NoteArtifact[] {
  const artifacts: NoteArtifact[] = [];
  if (built.profile) artifacts.push(buildProfileArtifact(built.profile, syncedAt));
  for (const m of built.media) {
    const title = pickTitle(m.title);
    artifacts.push(buildMediaArtifact(m, slugify(title), syncedAt));
  }
  for (const p of built.staff.values()) artifacts.push(buildStaffArtifact(p, syncedAt));
  for (const t of built.tags.values()) artifacts.push(buildTagArtifact(t, syncedAt));

  const mediaByCharId = new Map<number, { mediaId: number; mediaType: "ANIME" | "MANGA"; mediaTitle: string; role: string; vaNames: string[] }[]>();
  const mediaByCharId = new Map<number, { mediaId: number; mediaType: "ANIME" | "MANGA"; mediaTitle: string; role: string; vaIds: number[] }[]>();
  const mediaByStudioId = new Map<number, string[]>();

  for (const m of built.media) {
    const mediaTitle = pickTitle(m.title);
    for (const c of m.characters) {
      if (!mediaByCharId.has(c.id)) mediaByCharId.set(c.id, []);
      mediaByCharId.get(c.id)!.push({
        mediaId: m.mediaId,
        mediaType: m.type,
        mediaTitle,
        role: c.role ?? "",
        vaNames: c.voiceActors.map(va => va.name),
        vaIds: c.voiceActors.map(va => va.id),
      });
    }
    for (const studio of m.studios) {
      if (!mediaByStudioId.has(studio.id)) mediaByStudioId.set(studio.id, []);
      if (!mediaByStudioId.get(studio.id)!.includes(mediaTitle)) {
        mediaByStudioId.get(studio.id)!.push(mediaTitle);
      }
    }
  }

  for (const c of built.characters.values()) {
    const refs = mediaByCharId.get(c.id) ?? [];
    const charVAs = new Map<number, VoiceActorArtifactData>();
    for (const ref of refs) {
      for (const va of built.voiceActors.values()) {
        if (!charVAs.has(va.id) && ref.vaNames.includes(va.name)) {
          charVAs.set(va.id, va);
        }
      }
    }
    artifacts.push(buildCharacterArtifact(c, refs, [...charVAs.values()], syncedAt));
    artifacts.push(buildCharacterArtifact(c, refs, built.voiceActors, syncedAt));
  }
  for (const s of built.studios.values()) {
    const works = mediaByStudioId.get(s.id) ?? [];
    artifacts.push(buildStudioArtifact(s, works, syncedAt));
  }

  return artifacts;
}

export function buildMediaArtifact(note: MediaNote, titleSlug: string, syncedAt: string): NoteArtifact {
  const folder = note.type === "ANIME" ? "Anime" : "Manga";
  const title = pickTitle(note.title);
  const fm: Record<string, unknown> = {
    anilistId: note.mediaId,
    type: note.type,
    title: { romaji: note.title.romaji, english: note.title.english, native: note.title.native },
    status: note.userStatus,
    listName: note.listName,
    score: note.score,
    progress: note.progress,
    progressVolumes: note.progressVolumes,
    repeat: note.repeat,
    priority: note.priority,
    startedOn: note.startedAt,
    completedOn: note.completedAt,
    format: note.format,
    averageScore: note.averageScore,
    meanScore: note.meanScore,
    popularity: note.popularity,
    episodes: note.episodes,
    chapters: note.chapters,
    volumes: note.volumes,
    duration: note.duration,
    mediaStart: note.startDate,
    mediaEnd: note.endDate,
    syncedAt: SYNCED_AT_PLACEHOLDER,
    anilistUrl: note.siteUrl,
  };
  const body: string[] = [];
  body.push(`# ${title}`);
  body.push("");
  if (note.bannerImage) {
    body.push(`![banner](${note.bannerImage})`);
    body.push("");
  }
  if (note.coverLarge) {
    body.push(`![cover](${note.coverLarge})`);
    body.push("");
  }
  if (note.userStatus) body.push(`**Status:** ${note.userStatus}  `);
  if (note.score != null) body.push(`**Score:** ${note.score} / 10  `);
  if (note.type === "ANIME" && note.progress != null) {
    body.push(`**Progress:** ${note.progress}${note.episodes ? ` / ${note.episodes}` : ""} episodes  `);
  }
  if (note.type === "MANGA" && note.progress != null) {
    body.push(`**Progress:** ${note.progress}${note.chapters ? ` / ${note.chapters}` : ""} chapters  `);
  }
  if (note.repeat && note.repeat > 0) body.push(`**Rewatched/Reread:** ${note.repeat}  `);
  if (note.startedAt) body.push(`**Started:** ${note.startedAt}  `);
  if (note.completedAt) body.push(`**Completed:** ${note.completedAt}  `);
  body.push("");

  if (note.description) {
    body.push("## Synopsis");
    body.push("");
    body.push(stripHtml(note.description));
    body.push("");
  }
  if (note.studios.length) {
    body.push("## Studios");
    body.push("");
    for (const s of note.studios) body.push(`- [[Studios/${slugify(s.name)}|${s.name}]]`);
    body.push("");
  }
  if (note.staff.length) {
    body.push("## Staff");
    body.push("");
    for (const p of note.staff) body.push(`- [[Staff/${slugify(p.name)}|${p.name}]] — ${p.role ?? ""}`);
    body.push("");
  }
  if (note.characters.length) {
    body.push("## Characters");
    body.push("");
    for (const c of note.characters) {
      const vaLinks = c.voiceActors.length
        ? ` (voiced by ${c.voiceActors.map(va => va.name).join(", ")})`
        : "";
      body.push(`- [[Characters/${slugify(c.name)}|${c.name}]] — ${c.role ?? ""}${vaLinks}`);
    }
    body.push("");
  }
  if (note.genres.length) {
    body.push("## Genres");
    body.push("");
    for (const g of note.genres) body.push(`- [[Tags/${slugify(g)}|${g}]]`);
    body.push("");
  }
  if (note.tags.length) {
    body.push("## Tags");
    body.push("");
    for (const t of note.tags) {
      const pct = t.rank != null ? ` (${t.rank}%)` : "";
      body.push(`- [[Tags/${slugify(t.name)}|${t.name}]]${pct}`);
    }
    body.push("");
  }
  if (note.relations.length) {
    body.push("## Relations");
    body.push("");
    for (const r of note.relations) {
      const relFolder = r.type === "ANIME" ? "Anime" : "Manga";
      body.push(`- ${r.relationType}: [[${relFolder}/${slugify(r.title)}|${r.title}]]`);
    }
    body.push("");
  }
  if (note.notes && note.notes.trim()) {
    body.push("## My Notes");
    body.push("");
    body.push(note.notes.trim());
    body.push("");
  }
  return {
    folder,
    filename: `${titleSlug}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `${note.type}:${note.mediaId}`,
  };
}

export function buildStudioArtifact(studio: StudioArtifactData, works: string[], syncedAt: string): NoteArtifact {
  const fm: Record<string, unknown> = {
    anilistId: studio.id,
    type: "STUDIO",
    isAnimationStudio: studio.isAnimationStudio,
    anilistUrl: studio.siteUrl,
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };
  const body: string[] = [
    `# ${studio.name}`,
    "",
    `Animation studio: ${studio.isAnimationStudio ? "yes" : "no"}`,
    "",
  ];
  if (works.length) {
    body.push("## Works");
    body.push("");
    for (const w of works) body.push(`- ${w}`);
    body.push("");
  }
  body.push(`[AniList](${studio.siteUrl ?? ""})`);
  return {
    folder: "Studios",
    filename: `${slugify(studio.name)}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `studio:${studio.id}`,
  };
}

export function buildStaffArtifact(person: StaffArtifactData, syncedAt: string): NoteArtifact {
  const fm: Record<string, unknown> = {
    anilistId: person.id,
    type: "STAFF",
    nativeName: person.native,
    anilistUrl: person.siteUrl,
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };
  const body: string[] = [];
  body.push(`# ${person.name}`);
  body.push("");
  if (person.imageLarge) {
    body.push(`![photo](${person.imageLarge})`);
    body.push("");
  }
  if (person.native) body.push(`**Native:** ${person.native}  `);
  body.push(`**Primary role:** ${person.role ?? ""}  `);
  body.push("");
  body.push(`[AniList](${person.siteUrl ?? ""})`);
  return {
    folder: "Staff",
    filename: `${slugify(person.name)}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `staff:${person.id}`,
  };
}

export function buildTagArtifact(tag: TagArtifactData, syncedAt: string): NoteArtifact {
  const fm: Record<string, unknown> = {
    anilistId: tag.id,
    type: "TAG",
    rank: tag.rank,
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };
  const body: string[] = [`# ${tag.name}`, ""];
  if (tag.rank != null) body.push(`**AniList rank:** ${tag.rank}%  `);
  return {
    folder: "Tags",
    filename: `${slugify(tag.name)}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `tag:${tag.id}`,
  };
}

export function buildCharacterArtifact(
  ch: CharacterArtifactData,
  mediaRefs: { mediaId: number; mediaType: "ANIME" | "MANGA"; mediaTitle: string; role: string; vaNames: string[] }[],
  voiceActors: VoiceActorArtifactData[],
  syncedAt: string,
): NoteArtifact {
  const vaTags = voiceActors.map(va => `voiceactor/${slugify(va.name)}`);
  mediaRefs: { mediaId: number; mediaType: "ANIME" | "MANGA"; mediaTitle: string; role: string; vaIds: number[] }[],
  voiceActors: Map<number, VoiceActorArtifactData>,
  syncedAt: string,
): NoteArtifact {
  const vaSet = new Set<number>();
  for (const ref of mediaRefs) {
    for (const vaId of ref.vaIds) vaSet.add(vaId);
  }
  const vaList: VoiceActorArtifactData[] = [];
  for (const vaId of vaSet) {
    const va = voiceActors.get(vaId);
    if (va) vaList.push(va);
  }

  const tags = vaList.map(va => `voiceactor/${slugify(va.name)}`);

  const fm: Record<string, unknown> = {
    anilistId: ch.id,
    type: "CHARACTER",
    name: ch.name,
    nativeName: ch.native,
    gender: ch.gender,
    age: ch.age,
    dateOfBirth: ch.dateOfBirth,
    image: ch.imageLarge,
    anilistUrl: ch.siteUrl,
    tags: vaTags.length > 0 ? vaTags : undefined,
    syncedAt: SYNCED_AT_PLACEHOLDER,
    tags,
  };
  const body: string[] = [];
  body.push(`# ${ch.name}`);
  body.push("");
  if (ch.imageLarge) {
    body.push(`![character](${ch.imageLarge})`);
    body.push("");
  }
  if (ch.native) body.push(`**Native:** ${ch.native}  `);
  if (ch.gender) body.push(`**Gender:** ${ch.gender}  `);
  if (ch.age) body.push(`**Age:** ${ch.age}  `);
  if (ch.dateOfBirth) body.push(`**Birthday:** ${ch.dateOfBirth}  `);
  if (ch.description) {
    body.push("");
    body.push(ch.description);
    body.push("");
  }

  const vaByLang = new Map<string, VoiceActorArtifactData[]>();
  for (const va of voiceActors) {
    const lang = va.language ?? "Unknown";
    if (!vaByLang.has(lang)) vaByLang.set(lang, []);
    vaByLang.get(lang)!.push(va);
  }
  if (vaByLang.size > 0) {
    body.push("## Voice Actors");
    body.push("");
    for (const [lang, vas] of vaByLang) {
      for (const va of vas) {
        const mediaTitles = mediaRefs.filter(r => r.vaNames.includes(va.name)).map(r => r.mediaTitle);
        const vaLine = va.imageLarge
          ? `![photo](${va.imageLarge}) **${va.name}**`
          : `**${va.name}**`;
        const nativePart = va.native ? ` (${va.native})` : "";
        const langPart = lang !== "Unknown" ? ` — ${lang}` : "";
        const mediaPart = mediaTitles.length > 0 ? ` in ${mediaTitles.join(", ")}` : "";
        body.push(`- ${vaLine}${nativePart}${langPart}${mediaPart}`);
      }
  if (vaList.length) {
    for (const va of vaList) {
      body.push(`## Voice Actor: ${va.name}`);
      body.push("");
      if (va.imageLarge) {
        body.push(`![${va.name}](${va.imageLarge})`);
        body.push("");
      }
      if (va.native) body.push(`**Native:** ${va.native}  `);
      if (va.language) body.push(`**Language:** ${va.language}  `);
      body.push("");
    }
  }

  if (mediaRefs.length) {
    body.push("## Appearances");
    body.push("");
    for (const ref of mediaRefs) {
      const folder = ref.mediaType === "ANIME" ? "Anime" : "Manga";
      body.push(`- [[${folder}/${slugify(ref.mediaTitle)}|${ref.mediaTitle}]] — ${ref.role}`);
    }
    body.push("");
  }
  body.push(`[AniList](${ch.siteUrl ?? ""})`);
  return {
    folder: "Characters",
    filename: `${slugify(ch.name)}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `character:${ch.id}`,
  };
}



export function buildProfileArtifact(profile: ProfileData, syncedAt: string): NoteArtifact {
  const v = profile.viewer;
  const fm: Record<string, unknown> = {
    anilistId: v.id,
    type: "PROFILE",
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };
  const body: string[] = [`# @${v.name}`, ""];
  if (v.avatar?.large) {
    body.push(`![avatar](${v.avatar.large})`);
    body.push("");
  }
  body.push(`[AniList profile](${v.siteUrl ?? ""})`, "");
  const a = v.statistics?.anime;
  const m = v.statistics?.manga;
  body.push("## Stats", "");
  if (a) {
    body.push(`- **Anime:** ${a.count} entries, mean score ${a.meanScore ?? "—"}, ${a.episodesWatched} episodes, ${Math.round((a.minutesWatched ?? 0) / 60)} h watched`);
  }
  if (m) {
    body.push(`- **Manga:** ${m.count} entries, mean score ${m.meanScore ?? "—"}, ${m.chaptersRead} chapters, ${m.volumesRead} volumes read`);
  }
  body.push("");

  const summarize = (lists: MediaList[], kind: string) => {
    const byStatus = new Map<string, number>();
    for (const l of lists) for (const e of l.entries) {
      const s = e.status ?? "UNKNOWN";
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    if (byStatus.size === 0) return;
    body.push(`## ${kind} by status`, "");
    const order = ["CURRENT", "PLANNED", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"];
    for (const s of order) {
      const n = byStatus.get(s);
      if (n != null) body.push(`- **${s}:** ${n}`);
    }
    for (const [s, n] of byStatus) if (!order.includes(s)) body.push(`- **${s}:** ${n}`);
    body.push("");
  };
  summarize(profile.animeLists, "Anime");
  summarize(profile.mangaLists, "Manga");

  return {
    folder: "",
    filename: "Profile.md",
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: "profile",
  };
}
