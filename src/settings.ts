import type { OpenRouterModel } from "./openrouter/types";

export interface GraphColors {
  anime: string;
  manga: string;
  staff: string;
  studios: string;
  tags: string;
  characters: string;
}

export interface AnisyncSettings {
  anilistToken: string;
  anilistUsername: string;
  outputDir: string;
  pollIntervalSeconds: number;
  enableAutoSync: boolean;
  lastSyncAt: string | null;
  lastSyncStats: string | null;
  openrouterApiKey: string;
  openrouterModel: string;
  openrouterAvailableModels: OpenRouterModel[];
  graphColors: GraphColors;
}

export const DEFAULT_GRAPH_COLORS: GraphColors = {
  anime: "#02a9ff",
  manga: "#8b5cf6",
  staff: "#4ade80",
  studios: "#f59e0b",
  tags: "#f87171",
  characters: "#fbbf24",
};

export const DEFAULT_SETTINGS: AnisyncSettings = {
  anilistToken: "",
  anilistUsername: "",
  outputDir: "Ani-sync",
  pollIntervalSeconds: 30,
  enableAutoSync: true,
  lastSyncAt: null,
  lastSyncStats: null,
  openrouterApiKey: "",
  openrouterModel: "",
  openrouterAvailableModels: [],
  graphColors: { ...DEFAULT_GRAPH_COLORS },
};
