import { Notice, Plugin, TFile } from "obsidian";
import { AnisyncSettings, DEFAULT_SETTINGS } from "./settings";
import { AnisyncSettingTab } from "./settingsTab";
import { AnilistClient } from "./anilist/client";
import { SyncEngine, VaultAdapter, CacheStore } from "./sync/engine";
import { AnisyncCache, emptyCache } from "./sync/cache";
import {
  openAuthorizePopup,
  handleDeepLinkToken,
  disconnectAnilist,
  probeAnilistConnection,
} from "./auth/implicit";

interface AnisyncData {
  settings: AnisyncSettings;
  cache: AnisyncCache;
}

export default class AnisyncPlugin extends Plugin {
  settings: AnisyncSettings = { ...DEFAULT_SETTINGS };
  isSyncing = false;
  private cache: AnisyncCache = emptyCache();
  private syncEngine: SyncEngine | null = null;
  private syncIntervalId: number | null = null;
  private settingTab: AnisyncSettingTab | null = null;
  private saveTimeoutId: number | null = null;

  async onload(): Promise<void> {
    await this.loadAll();

    this.registerObsidianProtocolHandler("ani-sync", (params) => {
      const token = params.token;
      if (token) {
        void handleDeepLinkToken(this, token);
      }
    });

    this.settingTab = new AnisyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addRibbonIcon("database", "Ani-sync: Sync now", () => {
      void this.runSync();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      checkCallback: (checking) => {
        if (checking) return this.canSync();
        void this.runSync();
        return true;
      },
    });

    this.addCommand({
      id: "disconnect",
      name: "Disconnect AniList",
      checkCallback: (checking) => {
        if (checking) return !!this.settings.anilistToken;
        void disconnectAnilist(this).then(() => {
          this.refreshSettingsTab();
          new Notice("Disconnected from AniList.", 3000);
        });
        return true;
      },
    });

    this.addCommand({
      id: "clear-cache",
      name: "Clear sync cache (force full re-sync)",
      callback: () => {
        void this.clearCache();
      },
    });

    if (this.settings.enableAutoSync && this.canSync()) {
      this.startAutoSync();
    }
  }

  onunload(): void {
    this.syncEngine?.cancel();
    this.stopAutoSync();
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
    }
  }

  async loadAll(): Promise<void> {
    const raw = (await this.loadData()) as Partial<AnisyncData> | null;
    if (raw && typeof raw === "object") {
      if (raw.settings && typeof raw.settings === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
      }
      if (raw.cache && typeof raw.cache === "object" && raw.cache.version === 1) {
        this.cache = raw.cache;
      }
    } else {
      const legacy = raw as Partial<AnisyncSettings> | null;
      if (legacy && typeof legacy === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...legacy };
      }
    }
  }

  async saveSettings(): Promise<void> {
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
    }
    return new Promise((resolve) => {
      this.saveTimeoutId = window.setTimeout(async () => {
        await this.saveAll();
        this.saveTimeoutId = null;
        resolve();
      }, 300);
    });
  }

  async saveSettingsImmediate(): Promise<void> {
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
      this.saveTimeoutId = null;
    }
    await this.saveAll();
  }

  async saveAll(): Promise<void> {
    const data: AnisyncData = { settings: this.settings, cache: this.cache };
    await this.saveData(data);
  }

  canSync(): boolean {
    return !!(this.settings.anilistToken && this.settings.anilistUsername);
  }

  openAuthorizePopup(): void {
    openAuthorizePopup(this);
  }

  async probeAnilistConnection(): Promise<void> {
    await probeAnilistConnection(this);
  }

  async disconnectAnilist(): Promise<void> {
    await disconnectAnilist(this);
  }

  startAutoSync(): void {
    this.stopAutoSync();
    const ms = Math.max(5, this.settings.pollIntervalMinutes) * 60_000;
    const id = window.setInterval(() => {
      if (this.canSync()) {
        void this.runSync().catch(() => {});
      }
    }, ms);
    this.syncIntervalId = id;
    this.registerInterval(id);
  }

  stopAutoSync(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  refreshSettingsTab(): void {
    this.settingTab?.display();
  }

  async runSync(): Promise<void> {
    if (this.syncEngine) {
      new Notice("Ani-sync: sync already in progress.", 4000);
      return;
    }
    if (!this.canSync()) {
      new Notice("Ani-sync: connect AniList and set your username in settings first.", 6000);
      return;
    }

    this.isSyncing = true;
    this.settingTab?.showSyncProgress("Initializing sync...", 0);

    const client = new AnilistClient(this.settings.anilistToken, {
      onRetry: ({ attempt, waitMs, reason }) => {
        this.settingTab?.showSyncProgress(
          `Retrying in ${Math.round(waitMs / 1000)}s (${reason})...`,
          15
        );
      },
    });
    const vault = this.buildVaultAdapter();
    const cacheStore: CacheStore = {
      load: async () => this.cache,
      save: async (c) => {
        this.cache = c;
        await this.saveAll();
      },
    };

    this.syncEngine = new SyncEngine({
      anilist: client,
      vault,
      cacheStore,
      outputDir: this.settings.outputDir,
      username: this.settings.anilistUsername,
      cache: this.cache,
      onLog: (m) => {},
      onProgress: (m) => {
        const percent = this.calculateProgress(m);
        this.settingTab?.showSyncProgress(m, percent);
      },
    });

    try {
      const stats = await this.syncEngine.run();
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastSyncStats = `created ${stats.created}, updated ${stats.updated}, skipped ${stats.skipped}, failed ${stats.failed}`;
      await this.saveSettingsImmediate();
      this.settingTab?.showSyncProgress(
        `Sync complete: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`,
        100
      );
      setTimeout(() => {
        this.settingTab?.hideSyncProgress();
        this.refreshSettingsTab();
      }, 2000);
      new Notice(
        `Ani-sync: created ${stats.created}, updated ${stats.updated}, skipped ${stats.skipped}, failed ${stats.failed}`,
        6000,
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.settingTab?.showSyncProgress(`Sync failed: ${msg}`, 100);
      setTimeout(() => {
        this.settingTab?.hideSyncProgress();
      }, 3000);
      new Notice(`Ani-sync sync failed: ${msg}`, 10000);
    } finally {
      this.syncEngine = null;
      this.isSyncing = false;
    }
  }

  private calculateProgress(message: string): number {
    if (message.includes("Fetching viewer") || message.includes("summary")) return 5;
    if (message.includes("Viewer:")) return 10;
    if (message.includes("Summary:")) return 15;
    if (message.includes("Fetching full lists")) return 20;
    if (message.includes("anime lists:") || message.includes("manga lists:")) return 25;
    if (message.includes("Reusing")) return 30;
    if (message.includes("Fetching") && message.includes("detail")) return 40;
    if (message.includes("Detail fetch complete")) return 60;
    if (message.includes("Artifacts planned")) return 65;
    if (message.includes("Pre-computing hashes")) return 70;
    if (message.includes("Hashes computed")) return 75;
    if (message.includes("Removing")) return 85;
    if (message.includes("removed:")) return 90;
    if (message.includes("No changes")) return 100;
    return 50;
  }

  async clearCache(): Promise<void> {
    this.cache = emptyCache();
    await this.saveAll();
  }

  private buildVaultAdapter(): VaultAdapter {
    const adapter = this.app.vault.adapter;
    const fileManager = this.app.fileManager;
    const vault = this.app.vault;
    return {
      async read(path: string): Promise<string | null> {
        try {
          if (!(await adapter.exists(path))) return null;
          return await adapter.read(path);
        } catch {
          return null;
        }
      },
      async write(path: string, content: string): Promise<void> {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && dir !== "" && !(await adapter.exists(dir))) {
          await vault.createFolder(dir);
        }
        const existing = vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await vault.modify(existing, content);
        } else {
          await vault.create(path, content);
        }
      },
      async delete(path: string): Promise<void> {
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await fileManager.trashFile(file);
        }
      },
    };
  }
}
