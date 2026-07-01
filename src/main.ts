import { App, Modal, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./chat/view";
import { AnisyncSettings, DEFAULT_SETTINGS } from "./settings";
import { AnisyncSettingTab } from "./settingsTab";
import { AnilistClient } from "./anilist/client";
import { SyncEngine, VaultAdapter, CacheStore } from "./sync/engine";
import { AnisyncCache, emptyCache } from "./sync/cache";
import {
  openAuthorizePopup,
  handleDeepLinkToken,
  clearAnilistCredentials,
  probeAnilistConnection,
} from "./auth/implicit";

interface AnisyncData {
  settings: AnisyncSettings;
  cache: AnisyncCache;
}

class SyncProgressPopup {
  private el: HTMLDivElement | null = null;
  private fill: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;
  private lastUpdate = 0;

  show(message: string, percent: number): void {
    const now = Date.now();
    if (percent < 100 && now - this.lastUpdate < 150) return;
    this.lastUpdate = now;

    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "anisync-progress-popup";
      this.fill = document.createElement("div");
      this.fill.className = "anisync-progress-fill";
      this.label = document.createElement("div");
      this.label.className = "anisync-progress-text";
      this.el.appendChild(this.fill);
      this.el.appendChild(this.label);
      document.body.appendChild(this.el);
    }
    this.el.style.display = "block";
    if (this.fill) this.fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (this.label) this.label.setText(message);
  }

  hide(): void {
    if (this.el) {
      this.el.style.display = "none";
      if (this.fill) this.fill.style.width = "0%";
    }
    this.lastUpdate = 0;
  }

  destroy(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

export default class AnisyncPlugin extends Plugin {
  settings: AnisyncSettings = { ...DEFAULT_SETTINGS };
  cache: AnisyncCache = emptyCache();
  private syncEngine: SyncEngine | null = null;
  private syncIntervalId: number | null = null;
  private settingTab: AnisyncSettingTab | null = null;
  private syncPopup = new SyncProgressPopup();

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

    this.addRibbonIcon("message-circle", "Ani-sync: Open chat", () => {
      void this.openChatView();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
      checkCallback: (checking) => {
        if (checking) return this.canSync();
        void this.runSync();
        return true;
      },
    });

    this.addCommand({
      id: "disconnect",
      name: "Disconnect AniList",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "d" }],
      checkCallback: (checking) => {
        if (checking) return !!this.settings.anilistToken;
        void this.disconnectAnilist().then(() => {
          this.refreshSettingsTab();
          new Notice("Disconnected from AniList.", 3000);
        }).catch((e) => {
          const msg = (e as Error)?.message ?? String(e);
          new Notice(`Disconnect failed: ${msg}`, 6000);
          this.refreshSettingsTab();
        });
        return true;
      },
    });

    this.addCommand({
      id: "clear-cache",
      name: "Clear sync cache (force full re-sync)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
      callback: () => {
        void this.clearCache();
      },
    });

    this.addCommand({
      id: "open-chat",
      name: "Open Ani-sync Chat",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "o" }],
      callback: () => {
        void this.openChatView();
      },
    });

    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    if (this.settings.enableAutoSync && this.canSync()) {
      this.startAutoSync();
    }
  }

  onunload(): void {
    this.syncEngine?.cancel();
    this.stopAutoSync();
    this.syncPopup.destroy();
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  async loadAll(): Promise<void> {
    const raw = (await this.loadData()) as Partial<AnisyncData> | null;
    if (raw && typeof raw === "object") {
      if (raw.settings && typeof raw.settings === "object") {
        const loaded = raw.settings as unknown as Record<string, unknown>;
        if ("pollIntervalMinutes" in loaded && !("pollIntervalSeconds" in loaded)) {
          const mins = Number(loaded.pollIntervalMinutes);
          loaded.pollIntervalSeconds = Number.isFinite(mins) && mins > 0 ? Math.max(30, mins * 60) : 30;
          delete loaded.pollIntervalMinutes;
        }
        this.settings = { ...DEFAULT_SETTINGS, ...(loaded as Partial<AnisyncSettings>) };
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
    this.stopAutoSync();
    this.syncEngine?.cancel();
    this.syncPopup.hide();
    await clearAnilistCredentials(this);
  }

  startAutoSync(): void {
    this.stopAutoSync();
    const ms = Math.max(30, this.settings.pollIntervalSeconds) * 1000;
    const id = window.setInterval(() => {
      if (this.canSync() && !this.syncEngine) {
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

  invalidateChatContext(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const view = leaf.view as import("./chat/view").ChatView;
      view.invalidateVaultContext();
    }
  }

  async applyGraphColors(): Promise<boolean> {
    try {
      const path = ".obsidian/graph.json";
      const adapter = this.app.vault.adapter;
      const raw = await adapter.exists(path) ? await adapter.read(path) : '{"colorGroups":[]}';
      const graph = JSON.parse(raw);
      const outputDir = (this.settings.outputDir ?? "Ani-sync").replace(/^\/+|\/+$/g, "") || "Ani-sync";
      const groups: Record<string, unknown>[] = graph.colorGroups ?? [];
      const kept = groups.filter((g: Record<string, unknown>) => {
        const q = (g.query as string ?? "").trim();
        return !q.startsWith(`path:${outputDir}/`);
      });
      const folderMap: Record<string, string> = {
        anime: "Anime",
        manga: "Manga",
        staff: "Staff",
        studios: "Studios",
        tags: "Tags",
        characters: "Characters",
      };
      const colors = (this.settings.graphColors ?? {}) as unknown as Record<string, string>;
      for (const [key, folder] of Object.entries(folderMap)) {
        const hex = colors[key] ?? "#ffffff";
        const rgb = parseInt(hex.replace("#", ""), 16);
        kept.push({
          query: `path:${outputDir}/${folder}`,
          color: { rgb: isNaN(rgb) ? 16777215 : rgb, a: 1 },
        });
      }
      graph.colorGroups = kept;
      await adapter.write(path, JSON.stringify(graph, null, 2));
      return true;
    } catch (e) {
      console.error("Ani-sync: failed to apply graph colors", e);
      return false;
    }
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

    this.syncPopup.show("Syncing...", 0);

    const client = new AnilistClient(this.settings.anilistToken, {
      onRetry: ({ attempt, waitMs, reason }) => {
        this.syncPopup.show(`Retrying in ${Math.round(waitMs / 1000)}s (${reason})...`, 10);
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
      onLog: () => {},
      onProgress: (m, p) => {
        this.syncPopup.show(m, p ?? this.estimateProgress(m));
      },
    });

    try {
      const stats = await this.syncEngine.run();
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastSyncStats = `${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.skipped} unchanged, ${stats.failed} failed`;
      await this.saveAll();
      try { await this.applyGraphColors(); } catch {}
      try { this.invalidateChatContext(); } catch {}
      this.syncPopup.show("Sync complete!", 100);
      setTimeout(() => this.syncPopup.hide(), 2000);
      new Notice(`Ani-sync: done — ${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.skipped} skipped, ${stats.failed} failed`, 6000);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.syncPopup.show(`Failed: ${msg}`, 100);
      setTimeout(() => this.syncPopup.hide(), 3000);
      new Notice(`Ani-sync sync failed: ${msg}`, 10000);
    } finally {
      this.syncEngine = null;
    }
  }

  private estimateProgress(msg: string): number {
    if (msg.includes("Fetching viewer") || msg.includes("summary")) return 5;
    if (msg.includes("Viewer:")) return 10;
    if (msg.includes("Summary:")) return 15;
    if (msg.includes("Fetching full lists")) return 20;
    if (msg.includes("lists:")) return 25;
    if (msg.includes("Reusing")) return 30;
    if (msg.includes("Fetching") && msg.includes("detail")) return 40;
    if (msg.includes("Detail fetch")) return 60;
    if (msg.includes("Artifacts")) return 65;
    if (msg.includes("Pre-computing")) return 70;
    if (msg.includes("Hashes")) return 75;
    if (msg.includes("Removing")) return 85;
    if (msg.includes("removed:")) return 90;
    if (msg.includes("No changes")) return 100;
    if (msg.includes("complete")) return 100;
    return 50;
  }

  getCache(): AnisyncCache {
    return this.cache;
  }

  async openChatView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) {
        new Notice("Cannot open chat view.", 3000);
        return;
      }
      leaf = rightLeaf;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
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
        if (dir && dir !== "") {
          try {
            if (!(await adapter.exists(dir))) {
              await vault.createFolder(dir);
            }
          } catch {
            // concurrent write created the folder already — proceed
          }
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
      async exists(path: string): Promise<boolean> {
        try {
          return await adapter.exists(path);
        } catch {
          return false;
        }
      },
    };
  }
}

export class ClearCacheConfirmModal extends Modal {
  private plugin: AnisyncPlugin;

  constructor(app: App, plugin: AnisyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Clear sync cache?");

    contentEl.createEl("p", {
      text: "This will wipe all cached AniList data, triggering a full re-download on the next sync. This can use a large portion of your AniList API rate limit and may result in temporary rate-limiting if you re-sync immediately.",
    });

    const btnDiv = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelBtn = btnDiv.createEl("button", { text: "Cancel", cls: "mod-cta" });
    cancelBtn.onclick = () => this.close();

    const clearBtn = btnDiv.createEl("button", { text: "Clear Cache", cls: "mod-warning" });
    clearBtn.onclick = async () => {
      try {
        await this.plugin.clearCache();
        new Notice("Cache cleared. Next sync will be a full re-download.", 5000);
      } catch (e) {
        new Notice(`Failed to clear cache: ${(e as Error)?.message ?? e}`, 6000);
      } finally {
        this.plugin.refreshSettingsTab();
        this.close();
      }
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
