import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import AnisyncPlugin, { ClearCacheConfirmModal } from "./main";
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

    this.safeRender("OAuth", () => this.renderOAuthSection(containerEl));
    this.safeRender("Sync", () => this.renderSyncSection(containerEl));
    this.safeRender("SyncSettings", () => this.renderSyncSettingsSection(containerEl));
    this.safeRender("OpenRouter", () => this.renderOpenRouterSection(containerEl));
    this.safeRender("GraphColors", () => this.renderGraphColorsSection(containerEl));
    this.safeRender("Actions", () => this.renderActionsSection(containerEl));
  }

  private safeRender(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`Ani-sync: ${name} section render failed`, e);
    }
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
            .onClick(() => {
              void this.plugin.disconnectAnilist().then(() => {
                new Notice("Disconnected from AniList.", 3000);
              }).catch((e) => {
                const msg = e?.message ?? String(e);
                new Notice(`Disconnect failed: ${msg}`, 6000);
              }).finally(() => {
                this.plugin.refreshSettingsTab();
              });
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

    const section = containerEl.createDiv({ cls: "anisync-openrouter-panel" });
    const hero = section.createDiv({ cls: "anisync-openrouter-hero" });
    hero.createDiv({ cls: "anisync-openrouter-kicker", text: "AI Routing" });
    hero.createEl("h3", { text: "OpenRouter AI" });
    hero.createEl("p", {
      text: "Search and pin a valid model for the current API key without fighting a cramped native dropdown.",
    });

    new Setting(section)
      .setName("API key")
      .setDesc("Your OpenRouter API key. Stored locally in your vault settings.")
      .addText((text) => {
        text
          .setPlaceholder("sk-or-v1-...")
          .setValue(s.openrouterApiKey)
          .onChange(async (value) => {
            const next = value.trim();
            const apiKeyChanged = next !== s.openrouterApiKey;
            s.openrouterApiKey = next;
            if (apiKeyChanged) {
              s.openrouterAvailableModels = [];
              s.openrouterModel = "";
            }
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.addClass("anisync-openrouter-key-input");
      });

    new Setting(section)
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
            if (models.length > 0 && (!s.openrouterModel || !models.some((m) => m.id === s.openrouterModel))) {
              s.openrouterModel = models[0].id;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshSettingsTab();
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

    this.renderModelPicker(section);
  }

  private renderModelPicker(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "anisync-model-picker" });

    const header = card.createDiv({ cls: "anisync-model-picker-header" });
    const titleWrap = header.createDiv();
    titleWrap.createEl("h4", { text: "Model" });
    titleWrap.createEl("p", { text: "Search by provider, family, price tier, or context window." });
    header.createDiv({
      cls: "anisync-model-picker-badge",
      text: s.openrouterAvailableModels.length > 0 ? `${s.openrouterAvailableModels.length} loaded` : "No list",
    });

    const selected = card.createDiv({ cls: "anisync-model-selected" });
    const selectedLabel = selected.createDiv({ cls: "anisync-model-selected-label" });
    const selectedMeta = selected.createDiv({ cls: "anisync-model-selected-meta" });

    const searchWrap = card.createDiv({ cls: "anisync-model-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "anisync-model-search-icon" });
    searchIcon.innerHTML = "&#8981;";
    const searchInput = searchWrap.createEl("input", {
      cls: "anisync-model-search-input",
      attr: { type: "text", placeholder: "Search models... e.g. nemotron, qwen, free, 128k" },
    });

    const list = card.createDiv({ cls: "anisync-model-list" });

    const updateSelected = () => {
      const model = s.openrouterAvailableModels.find((m) => m.id === s.openrouterModel);
      if (!model) {
        selected.addClass("is-empty");
        selectedLabel.setText("No model selected");
        selectedMeta.setText("Fetch models for this API key, then pick one route for chat.");
        return;
      }
      selected.removeClass("is-empty");
      selectedLabel.setText(model.isFree ? `[Free] ${model.name}` : model.name);
      const provider = model.id.split("/")[0] ?? "provider";
      const ctx = model.context_length ? `${Math.round(model.context_length / 1000)}k ctx` : "ctx unknown";
      selectedMeta.setText(`${provider} · ${ctx} · ${model.id}`);
    };

    const renderList = async () => {
      list.empty();
      const q = searchInput.value.toLowerCase().trim();
      const models = s.openrouterAvailableModels.filter((m) => {
        if (!q) return true;
        const hay = [
          m.id,
          m.name,
          m.description ?? "",
          m.isFree ? "free" : "paid",
          String(m.context_length),
          `${Math.round(m.context_length / 1000)}k`,
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });

      if (s.openrouterAvailableModels.length === 0) {
        const empty = list.createDiv({ cls: "anisync-model-empty" });
        empty.createEl("strong", { text: "No models loaded" });
        empty.createEl("span", { text: "Enter a key and fetch models first." });
        updateSelected();
        return;
      }

      if (models.length === 0) {
        const empty = list.createDiv({ cls: "anisync-model-empty" });
        empty.createEl("strong", { text: "No matches" });
        empty.createEl("span", { text: "Try provider names, model families, or 'free'." });
        updateSelected();
        return;
      }

      for (const model of models.slice(0, 60)) {
        const item = list.createDiv({ cls: "anisync-model-option" });
        if (model.id === s.openrouterModel) item.addClass("is-selected");

        const top = item.createDiv({ cls: "anisync-model-option-top" });
        top.createSpan({ cls: "anisync-model-option-name", text: model.name });
        top.createSpan({
          cls: model.isFree ? "anisync-model-chip is-free" : "anisync-model-chip",
          text: model.isFree ? "Free" : "Paid",
        });

        const meta = item.createDiv({ cls: "anisync-model-option-meta" });
        meta.createSpan({ text: model.id });
        meta.createSpan({ text: `${Math.round(model.context_length / 1000)}k ctx` });

        if (model.description) {
          item.createDiv({ cls: "anisync-model-option-desc", text: model.description });
        }

        item.onclick = async () => {
          s.openrouterModel = model.id;
          await this.plugin.saveSettings();
          updateSelected();
          await renderList();
        };
      }

      updateSelected();
    };

    searchInput.addEventListener("input", () => { void renderList(); });
    void renderList();
  }

  private renderGraphColorsSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const colors = s.graphColors;
    const labels: [keyof typeof colors, string, string][] = [
      ["anime", "Anime", "#02a9ff"],
      ["manga", "Manga", "#8b5cf6"],
      ["staff", "Staff", "#4ade80"],
      ["studios", "Studios", "#f59e0b"],
      ["tags", "Tags", "#f87171"],
      ["characters", "Characters", "#fbbf24"],
    ];

    containerEl.createEl("h3", { text: "Graph Colors" });
    containerEl.createEl("p", {
      text: "Customise the colours used for each note type in Obsidian's graph view.",
      cls: "setting-item-description",
    });

    for (const [key, label] of labels) {
      new Setting(containerEl)
        .setName(label)
        .addColorPicker((picker) =>
          picker
            .setValue(colors[key])
            .onChange(async (value) => {
              colors[key] = value;
              await this.plugin.saveSettings();
              await this.plugin.applyGraphColors();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Apply to graph now")
      .setDesc("Update graph.json with the colours above.")
      .addButton((btn) =>
        btn.setButtonText("Apply").setCta().onClick(async () => {
          await this.plugin.applyGraphColors();
          new Notice("Graph colours applied. Reopen the graph panel to see changes.", 6000);
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
          .onClick(() => {
            new ClearCacheConfirmModal(this.app, this.plugin).open();
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
