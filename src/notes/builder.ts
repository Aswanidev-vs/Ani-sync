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

  // Suppress duplicate characters from sequel entries (e.g. BLEACH split into cours).
  // If a character appears in both a prequel and its sequel, only keep it in the prequel.
  const charToMedia = new Map<number, Set<number>>();
  for (const m of mediaNotes) {
    for (const c of m.characters) {
      if (!charToMedia.has(c.id)) charToMedia.set(c.id, new Set());
      charToMedia.get(c.id)!.add(m.mediaId);
    }
  }
  for (const m of mediaNotes) {
    const detail = details.get(`${m.type}:${m.mediaId}`);
    if (!detail?.relations?.edges) continue;
    const sequelIds = new Set<number>();
    for (const edge of detail.relations.edges) {
      if (!edge?.node) continue;
      if (edge.relationType === "SEQUEL") sequelIds.add(edge.node.id);
    }
    if (sequelIds.size === 0) continue;
    const currentCharIds = new Set(m.characters.map(c => c.id));
    for (const sm of mediaNotes) {
      if (!sequelIds.has(sm.mediaId)) continue;
      sm.characters = sm.characters.filter(c => !currentCharIds.has(c.id));
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
        voiceActors: (edge.voiceActors ?? []).filter(Boolean).map(va => ({
          id: va.id,
          name: va.name?.full ?? "(unknown)",
          native: va.name?.native ?? null,
          language: va.language ?? null,
          imageLarge: va.image?.large ?? null,
          imageMedium: va.image?.medium ?? null,
          siteUrl: null,
        })),
      });
    } else {
      const ch = characters.get(edge.node.id)!;
      for (const va of edge.voiceActors ?? []) {
        if (!va) continue;
        if (!ch.voiceActors.some(v => v.id === va.id)) {
          ch.voiceActors.push({
            id: va.id,
            name: va.name?.full ?? "(unknown)",
            native: va.name?.native ?? null,
            language: va.language ?? null,
            imageLarge: va.image?.large ?? null,
            imageMedium: va.image?.medium ?? null,
            siteUrl: null,
          });
        }
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

  const mediaByStudioId = new Map<number, string[]>();

  // Group media by slugified title for character cast merging
  const mediaBySlug = new Map<string, MediaNote[]>();
  for (const m of built.media) {
    if (m.characters.length === 0) continue;
    const slug = slugify(pickTitle(m.title));
    if (!mediaBySlug.has(slug)) mediaBySlug.set(slug, []);
    mediaBySlug.get(slug)!.push(m);
  }

  // Build character → media cross-reference map for split entries (e.g. BLEACH multi-cour)
  const charMediaLookup = new Map<number, { mediaId: number; title: string; type: string }[]>();
  for (const m of built.media) {
    const mediaTitle = pickTitle(m.title);
    for (const c of m.characters) {
      if (!charMediaLookup.has(c.id)) charMediaLookup.set(c.id, []);
      const list = charMediaLookup.get(c.id)!;
      if (!list.some(e => e.mediaId === m.mediaId)) {
        list.push({ mediaId: m.mediaId, title: mediaTitle, type: m.type });
      }
    }
  }

  for (const [slug, mediaList] of mediaBySlug) {
    if (mediaList.length === 1) {
      artifacts.push(buildMediaCharacterArtifact(mediaList[0], built.characters, charMediaLookup, syncedAt));
    } else {
      artifacts.push(buildMergedCharacterArtifact(mediaList, built.characters, charMediaLookup, syncedAt));
    }
  }

  for (const m of built.media) {
    const mediaTitle = pickTitle(m.title);
    for (const studio of m.studios) {
      if (!mediaByStudioId.has(studio.id)) mediaByStudioId.set(studio.id, []);
      if (!mediaByStudioId.get(studio.id)!.includes(mediaTitle)) {
        mediaByStudioId.get(studio.id)!.push(mediaTitle);
      }
    }
  }

  for (const s of built.studios.values()) {
    const works = mediaByStudioId.get(s.id) ?? [];
    artifacts.push(buildStudioArtifact(s, works, syncedAt));
  }

  // Build VA → media mapping for Voice-Actors.md MOC
  const vaToMedia = new Map<string, { title: string; slug: string; characters: string[] }[]>();
  for (const m of built.media) {
    const mediaTitle = pickTitle(m.title);
    const mediaSlug = slugify(mediaTitle);
    for (const c of m.characters) {
      const ch = built.characters.get(c.id);
      if (!ch) continue;
      for (const va of ch.voiceActors) {
        if (!vaToMedia.has(va.name)) vaToMedia.set(va.name, []);
        const entries = vaToMedia.get(va.name)!;
        let entry = entries.find(e => e.slug === mediaSlug);
        if (!entry) {
          entry = { title: mediaTitle, slug: mediaSlug, characters: [] };
          entries.push(entry);
        }
        if (!entry.characters.includes(ch.name)) entry.characters.push(ch.name);
      }
    }
  }

  if (vaToMedia.size > 0) {
    artifacts.push(buildVoiceActorMocArtifact(vaToMedia, syncedAt));
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
      body.push(`- [[Characters/${titleSlug}#${c.name}|${c.name}]] — ${c.role ?? ""}${vaLinks}`);
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

export function buildMediaCharacterArtifact(
  mediaNote: MediaNote,
  characters: Map<number, CharacterArtifactData>,
  charMediaLookup: Map<number, { mediaId: number; title: string; type: string }[]>,
  syncedAt: string,
): NoteArtifact {
  const title = pickTitle(mediaNote.title);
  const titleSlug = slugify(title);

  // Collect unique VA names for frontmatter
  const vaNames = new Set<string>();
  for (const c of mediaNote.characters) {
    for (const va of c.voiceActors) vaNames.add(va.name);
  }

  const fm: Record<string, unknown> = {
    mediaId: mediaNote.mediaId,
    type: "MEDIA_CHARACTERS",
    mediaTitle: title,
    mediaType: mediaNote.type,
    voiceActors: [...vaNames].sort(),
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };

  const body: string[] = [];
  body.push(`# ${title} — Characters`);
  body.push("");

  for (const c of mediaNote.characters) {
    const ch = characters.get(c.id);
    if (!ch) continue;

    body.push(`## ${ch.name}`);
    body.push("");
    if (ch.imageLarge) {
      body.push(`![${ch.name}](${ch.imageLarge})`);
      body.push("");
    }
    if (ch.native) body.push(`**Native:** ${ch.native}  `);
    if (ch.gender) body.push(`**Gender:** ${ch.gender}  `);
    if (ch.age) body.push(`**Age:** ${ch.age}  `);
    if (ch.dateOfBirth) body.push(`**Birthday:** ${ch.dateOfBirth}  `);
    body.push(`**Role:** ${c.role ?? ""}  `);
    body.push(`**Type:** ${mediaNote.type === 'ANIME' ? 'Anime' : 'Manga'}  `);
    body.push(`[AniList](${ch.siteUrl ?? ""})  `);
    body.push("");

    if (ch.voiceActors.length) {
      body.push("### Voice Actors");
      body.push("");
      for (const va of ch.voiceActors) {
        if (va.imageLarge) {
          body.push(`![${va.name}](${va.imageLarge})`);
        }
        body.push(`**${va.name}**  `);
        if (va.native) body.push(`Native: ${va.native}  `);
        if (va.language) body.push(`Language: ${va.language}  `);
        body.push("");
      }
    }

    if (ch.description) {
      body.push(ch.description);
      body.push("");
    }

    // Cross-media references: show other Ani-sync entries this character appears in
    const allMedia = charMediaLookup.get(c.id) ?? [];
    const otherMedia = allMedia.filter(m => m.mediaId !== mediaNote.mediaId);
    if (otherMedia.length > 0) {
      body.push("### Also appears in");
      body.push("");
      for (const m of otherMedia) {
        const folder = m.type === "ANIME" ? "Anime" : "Manga";
        body.push(`- [[${folder}/${slugify(m.title)}|${m.title}]]`);
      }
      body.push("");
    }
  }

  body.push(`[AniList - ${title}](${mediaNote.siteUrl ?? ""})`);

  return {
    folder: "Characters",
    filename: `${titleSlug}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `media-characters:${mediaNote.mediaId}`,
  };
}

export function buildMergedCharacterArtifact(
  mediaNotes: MediaNote[],
  characters: Map<number, CharacterArtifactData>,
  charMediaLookup: Map<number, { mediaId: number; title: string; type: string }[]>,
  syncedAt: string,
): NoteArtifact {
  const primaryNote = mediaNotes[0];
  const title = pickTitle(primaryNote.title);
  const titleSlug = slugify(title);

  const types = new Set(mediaNotes.map(m => m.type));
  const mediaTypeStr = types.size > 1
    ? [...types].sort().join("/")
    : [...types][0];

  const mediaIds = mediaNotes.map(m => m.mediaId).sort();

  // Collect unique VA names for frontmatter
  const vaNames = new Set<string>();
  for (const m of mediaNotes) {
    for (const c of m.characters) {
      const ch = characters.get(c.id);
      if (ch) {
        for (const va of ch.voiceActors) vaNames.add(va.name);
      }
    }
  }

  const fm: Record<string, unknown> = {
    mediaIds,
    type: "MEDIA_CHARACTERS",
    mediaTitle: title,
    mediaType: mediaTypeStr,
    voiceActors: [...vaNames].sort(),
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };

  // Merge characters: track which media types each character appears in
  const merged = new Map<number, { name: string; types: Set<"ANIME" | "MANGA">; roles: string[] }>();
  for (const m of mediaNotes) {
    for (const c of m.characters) {
      if (!merged.has(c.id)) {
        merged.set(c.id, { name: c.name, types: new Set(), roles: [] });
      }
      const mc = merged.get(c.id)!;
      mc.types.add(m.type);
      if (c.role && !mc.roles.includes(c.role)) mc.roles.push(c.role);
    }
  }

  const charTypeLabels: Record<string, string> = {
    ANIME: "Anime",
    MANGA: "Manga",
  };
  const formatType = (types: Set<"ANIME" | "MANGA">): string => {
    return [...types].map(t => charTypeLabels[t]).join("/");
  };

  const body: string[] = [];
  body.push(`# ${title} — Characters`);
  body.push("");

  for (const [charId, mc] of merged) {
    const ch = characters.get(charId);
    if (!ch) continue;

    body.push(`## ${ch.name}`);
    body.push("");
    if (ch.imageLarge) {
      body.push(`![${ch.name}](${ch.imageLarge})`);
      body.push("");
    }
    if (ch.native) body.push(`**Native:** ${ch.native}  `);
    if (ch.gender) body.push(`**Gender:** ${ch.gender}  `);
    if (ch.age) body.push(`**Age:** ${ch.age}  `);
    if (ch.dateOfBirth) body.push(`**Birthday:** ${ch.dateOfBirth}  `);
    body.push(`**Role:** ${mc.roles.join(", ")}  `);
    body.push(`**Type:** ${formatType(mc.types)}  `);
    body.push(`[AniList](${ch.siteUrl ?? ""})  `);
    body.push("");

    if (ch.voiceActors.length) {
      body.push("### Voice Actors");
      body.push("");
      for (const va of ch.voiceActors) {
        if (va.imageLarge) {
          body.push(`![${va.name}](${va.imageLarge})`);
        }
        body.push(`**${va.name}**  `);
        if (va.native) body.push(`Native: ${va.native}  `);
        if (va.language) body.push(`Language: ${va.language}  `);
        body.push("");
      }
    }

    if (ch.description) {
      body.push(ch.description);
      body.push("");
    }

    // Cross-media references: show other Ani-sync entries this character appears in
    // (exclude media already merged with the same slug)
    const mergedIds = new Set(mediaNotes.map(m => m.mediaId));
    const allMedia = charMediaLookup.get(charId) ?? [];
    const otherMedia = allMedia.filter(m => !mergedIds.has(m.mediaId));
    if (otherMedia.length > 0) {
      body.push("### Also appears in");
      body.push("");
      for (const m of otherMedia) {
        const folder = m.type === "ANIME" ? "Anime" : "Manga";
        body.push(`- [[${folder}/${slugify(m.title)}|${m.title}]]`);
      }
      body.push("");
    }
  }

  body.push(`[AniList - ${title}](${primaryNote.siteUrl ?? ""})`);

  return {
    folder: "Characters",
    filename: `${titleSlug}.md`,
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: `media-characters:${titleSlug}`,
  };
}

export function buildVoiceActorMocArtifact(
  vaToMedia: Map<string, { title: string; slug: string; characters: string[] }[]>,
  syncedAt: string,
): NoteArtifact {
  const fm: Record<string, unknown> = {
    type: "VOICE_ACTOR_INDEX",
    syncedAt: SYNCED_AT_PLACEHOLDER,
  };

  const body: string[] = [`# Voice Actors`, ""];

  const sortedVAs = [...vaToMedia.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [vaName, mediaEntries] of sortedVAs) {
    body.push(`## ${vaName}`);
    body.push("");
    for (const me of mediaEntries) {
      const charList = me.characters.join(", ");
      body.push(`- [[Characters/${me.slug}|${me.title}]] — ${charList}`);
    }
    body.push("");
  }

  return {
    folder: "",
    filename: "Voice-Actors.md",
    body: renderFrontmatter(fm) + "\n" + body.join("\n"),
    uniqueKey: "voice-actor-index",
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
