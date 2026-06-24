export interface AnisyncSettings {
  anilistToken: string;
  anilistUsername: string;
  outputDir: string;
  pollIntervalSeconds: number;
  enableAutoSync: boolean;
  lastSyncAt: string | null;
  lastSyncStats: string | null;
}

export const DEFAULT_SETTINGS: AnisyncSettings = {
  anilistToken: "",
  anilistUsername: "",
  outputDir: "Ani-sync",
  pollIntervalSeconds: 30,
  enableAutoSync: true,
  lastSyncAt: null,
  lastSyncStats: null,
};
