import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnisyncPlugin from "./main";

export class AnisyncSettingTab extends PluginSettingTab {
  private plugin: AnisyncPlugin;
  private syncProgressEl: HTMLDivElement | null = null;
  private syncProgressBar: HTMLDivElement | null = null;
  private syncProgressText: HTMLDivElement | null = null;

  constructor(app: App, plugin: AnisyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Ani-sync" });
    containerEl.createEl("p", {
      text: "Sync your AniList anime & manga lists into your vault as wikilinked markdown notes.",
      cls: "setting-item-description",
    });

    this.renderSyncProgress(containerEl);
    this.renderOAuthSection(containerEl);
    this.renderSyncSection(containerEl);
    this.renderActionsSection(containerEl);
  }

  private renderSyncProgress(containerEl: HTMLElement): void {
    const progressContainer = containerEl.createDiv({ cls: "anisync-progress-container" });
    progressContainer.style.display = this.plugin.isSyncing ? "block" : "none";

    this.syncProgressBar = progressContainer.createDiv({ cls: "anisync-progress-fill" });
    this.syncProgressBar.style.width = "0%";

    this.syncProgressText = progressContainer.createDiv({ cls: "anisync-progress-text" });
    this.syncProgressText.setText("Initializing sync...");

    this.syncProgressEl = progressContainer;
  }

  showSyncProgress(message: string, percent: number): void {
    if (!this.syncProgressEl || !this.syncProgressBar || !this.syncProgressText) return;
    this.syncProgressEl.style.display = "block";
    this.syncProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    this.syncProgressText.setText(message);
  }

  hideSyncProgress(): void {
    if (!this.syncProgressEl || !this.syncProgressBar || !this.syncProgressText) return;
    this.syncProgressEl.style.display = "none";
    this.syncProgressBar.style.width = "0%";
    this.syncProgressText.setText("");
  }

  private renderOAuthSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const hasToken = !!s.anilistToken;

    containerEl.createEl("h3", { text: "AniList Connection" });

    const statusCard = containerEl.createDiv({ cls: "anisync-status-card" });
    const statusRow = statusCard.createDiv({ cls: "anisync-status-row" });
    statusRow.createDiv({ cls: hasToken ? "anisync-indicator anisync-indicator-ok" : "anisync-indicator anisync-indicator-warn" });
    const statusText = statusRow.createSpan({ cls: "anisync-status-text" });

    if (hasToken && s.anilistUsername) {
      statusText.setText("Connected as @" + s.anilistUsername);
    } else if (hasToken) {
      statusText.setText("Connected (verifying...)");
    } else {
      statusText.setText("Not connected");
    }

    const descEl = statusCard.createDiv({ cls: "setting-item-description" });
    descEl.setText(hasToken
      ? "Your AniList account is linked."
      : "Connect your AniList account to start syncing.");
  }

  private renderSyncSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    containerEl.createEl("h3", { text: "Sync" });

    if (s.lastSyncAt) {
      const dt = new Date(s.lastSyncAt);
      const timeAgo = this.getTimeAgo(dt);
      const statsEl = containerEl.createDiv({ cls: "anisync-last-sync" });
      const labelEl = statsEl.createSpan({ cls: "anisync-last-sync-label" });
      labelEl.setText("Last sync: ");
      const timeEl = statsEl.createSpan({ cls: "anisync-last-sync-time" });
      timeEl.setText(timeAgo + " ago");
      if (s.lastSyncStats) {
        const statsText = statsEl.createDiv({ cls: "anisync-last-sync-stats" });
        statsText.setText(s.lastSyncStats);
      }
    }

    new Setting(containerEl)
      .setName("AniList username")
      .setDesc("Your AniList username. Required for syncing.")
      .addText((text) =>
        text
          .setPlaceholder("your-username")
          .setValue(s.anilistUsername)
          .onChange(async (value) => {
            s.anilistUsername = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    if (!s.anilistToken) {
      new Setting(containerEl)
        .setName("Connect to AniList")
        .setDesc("Opens AniList authorization page. After approving, connection is established automatically.")
        .addButton((btn) =>
          btn
            .setButtonText("Connect to AniList")
            .setCta()
            .onClick(() => {
              new Notice("Opening AniList authorization...", 3000);
              this.plugin.openAuthorizePopup();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("Disconnect")
        .setDesc("Remove your AniList connection.")
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setDestructive()
            .onClick(async () => {
              await this.plugin.disconnectAnilist();
              this.plugin.refreshSettingsTab();
              new Notice("Disconnected from AniList.", 3000);
            }),
        );
    }

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder where notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("Ani-sync")
          .setValue(s.outputDir)
          .onChange(async (value) => {
            s.outputDir = value.trim() || "Ani-sync";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync at regular intervals while Obsidian is open.")
      .addToggle((toggle) =>
        toggle.setValue(s.enableAutoSync).onChange(async (value) => {
          s.enableAutoSync = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.startAutoSync();
            new Notice("Auto-sync enabled (every " + s.pollIntervalMinutes + " minutes)", 3000);
          } else {
            this.plugin.stopAutoSync();
            new Notice("Auto-sync disabled", 3000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("How often to check for updates (minimum 5 minutes).")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(s.pollIntervalMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            s.pollIntervalMinutes = Number.isFinite(n) && n >= 5 ? n : 30;
            await this.plugin.saveSettings();
            if (s.enableAutoSync) {
              this.plugin.startAutoSync();
            }
          }),
      );
  }

  private renderActionsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Manually trigger a sync with AniList.")
      .addButton((btn) =>
        btn
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => {
            void this.plugin.runSync();
          }),
      );

    new Setting(containerEl)
      .setName("Clear sync cache")
      .setDesc("Force a complete re-sync by clearing all cached data.")
      .addButton((btn) =>
        btn
          .setButtonText("Clear cache")
          .setDestructive()
          .onClick(async () => {
            await this.plugin.clearCache();
            new Notice("Cache cleared. Next sync will be a full re-download.", 5000);
            this.display();
          }),
      );
  }

  private getTimeAgo(date: Date): string {
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " minutes";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " hours";
    return Math.floor(seconds / 86400) + " days";
  }
}
