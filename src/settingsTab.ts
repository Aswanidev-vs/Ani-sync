import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnisyncPlugin from "./main";
import { fetchModels } from "./openrouter/client";

export class AnisyncSettingTab extends PluginSettingTab {
  private plugin: AnisyncPlugin;

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

    this.renderOAuthSection(containerEl);
    this.renderSyncSection(containerEl);
    this.renderSyncSettingsSection(containerEl);
    this.renderOpenRouterSection(containerEl);
    this.renderActionsSection(containerEl);
  }

  private renderOAuthSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const hasToken = !!s.anilistToken;

    containerEl.createEl("h3", { text: "AniList Connection" });

    const card = containerEl.createDiv({ cls: "anisync-status-card" });
    const row = card.createDiv({ cls: "anisync-status-row" });
    row.createDiv({ cls: hasToken ? "anisync-indicator anisync-indicator-ok" : "anisync-indicator anisync-indicator-warn" });
    const text = row.createSpan({ cls: "anisync-status-text" });

    if (hasToken && s.anilistUsername) {
      text.setText("Connected as @" + s.anilistUsername);
    } else if (hasToken) {
      text.setText("Connected (verifying...)");
    } else {
      text.setText("Not connected");
    }

    card.createDiv({ cls: "setting-item-description" })
      .setText(hasToken ? "Your AniList account is linked." : "Connect your AniList account to start syncing.");
  }

  private renderSyncSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    containerEl.createEl("h3", { text: "Sync" });

    if (s.lastSyncAt) {
      const dt = new Date(s.lastSyncAt);
      const ago = this.getTimeAgo(dt);
      const el = containerEl.createDiv({ cls: "anisync-last-sync" });
      el.createSpan({ cls: "anisync-last-sync-label" }).setText("Last sync: ");
      el.createSpan({ cls: "anisync-last-sync-time" }).setText(ago + " ago");
      if (s.lastSyncStats) {
        el.createDiv({ cls: "anisync-last-sync-stats" }).setText(s.lastSyncStats);
      }
    }

    if (s.anilistToken) {
      new Setting(containerEl)
        .setName("AniList username")
        .setDesc("Auto-detected from your AniList account.")
        .addText((text) =>
          text
            .setValue(s.anilistUsername)
            .setDisabled(true),
        );
    }

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

  }

  private renderSyncSettingsSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

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
            new Notice("Auto-sync enabled (every " + s.pollIntervalSeconds + "s)", 3000);
          } else {
            this.plugin.stopAutoSync();
            new Notice("Auto-sync disabled", 3000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("How often to check for updates (minimum 30 seconds).")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(s.pollIntervalSeconds))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            s.pollIntervalSeconds = Number.isFinite(n) && n >= 30 ? n : 30;
            await this.plugin.saveSettings();
            if (s.enableAutoSync) {
              this.plugin.startAutoSync();
            }
          }),
      );
  }

  private renderOpenRouterSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    containerEl.createEl("h3", { text: "OpenRouter AI" });
    containerEl.createEl("p", {
      text: "Configure an OpenRouter API key to enable the AI chat sidebar.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Your OpenRouter API key. Stored locally in your vault settings.")
      .addText((text) => {
        text
          .setPlaceholder("sk-or-v1-...")
          .setValue(s.openrouterApiKey)
          .onChange(async (value) => {
            s.openrouterApiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc("Select an OpenRouter model for chat.")
      .addDropdown((dropdown) => {
        const models = s.openrouterAvailableModels;
        if (models.length > 0) {
          for (const m of models) {
            const label = m.isFree ? `[Free] ${m.name}` : m.name;
            dropdown.addOption(m.id, label);
          }
          if (s.openrouterModel) {
            dropdown.setValue(s.openrouterModel);
          } else {
            dropdown.setValue(models[0].id);
            s.openrouterModel = models[0].id;
          }
        } else {
          dropdown.addOption("", "No models — fetch first");
        }
        dropdown.onChange(async (value) => {
          s.openrouterModel = value;
          await this.plugin.saveSettings();
        });
        return dropdown;
      });

    new Setting(containerEl)
      .setName("Fetch available models")
      .setDesc("Retrieve the list of models from OpenRouter. Free models are tagged.")
      .addButton((btn) =>
        btn.setButtonText("Fetch models").setCta().onClick(async () => {
          if (!s.openrouterApiKey) {
            new Notice("Enter and save an API key first.", 4000);
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText("Fetching...");
          try {
            const models = await fetchModels(s.openrouterApiKey);
            s.openrouterAvailableModels = models;
            if (models.length > 0 && !s.openrouterModel) {
              s.openrouterModel = models[0].id;
            }
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Fetched ${models.length} models (${models.filter((m) => m.isFree).length} free).`, 4000);
          } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            new Notice(`Failed to fetch models: ${msg}`, 6000);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("Fetch models");
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
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " minutes";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " hours";
    return Math.floor(seconds / 86400) + " days";
  }
}
