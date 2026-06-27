import { ItemView, WorkspaceLeaf } from "obsidian";
import type AnisyncPlugin from "../main";
import { VaultContext } from "./vaultContext";
import { sendChatStream } from "../openrouter/client";

export const CHAT_VIEW_TYPE = "ani-sync-chat-view";

export class ChatView extends ItemView {
  private plugin: AnisyncPlugin;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private loadingEl!: HTMLDivElement;

  constructor(leaf: WorkspaceLeaf, plugin: AnisyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ani-sync Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("anisync-chat-container");

    this.messagesEl = container.createDiv({ cls: "anisync-chat-messages" });
    this.showWelcome();

    const inputArea = container.createDiv({ cls: "anisync-chat-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "anisync-chat-input",
      attr: { placeholder: "Ask about your AniList library...", rows: "2" },
    });
    this.sendBtn = inputArea.createEl("button", {
      cls: "anisync-chat-send-btn",
      text: "Send",
    });

    this.loadingEl = container.createDiv({ cls: "anisync-chat-loading" });
    this.loadingEl.hide();

    this.sendBtn.addEventListener("click", () => this.handleSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  async onClose(): Promise<void> {
    // nothing to clean up
  }

  private showWelcome(): void {
    this.messagesEl.empty();
    const welcome = this.messagesEl.createDiv({ cls: "anisync-chat-welcome" });
    welcome.setText("Ask about your AniList library — media, staff, studios, and more.");
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    const apiKey = this.plugin.settings.openrouterApiKey;
    const model = this.plugin.settings.openrouterModel;
    if (!apiKey || !model) {
      this.addMessage("assistant", "Please configure your OpenRouter API key and select a model in Settings → Ani-sync → OpenRouter AI.");
      return;
    }

    this.addMessage("user", text);
    this.inputEl.value = "";
    this.showLoading();

    const outputDir = this.plugin.settings.outputDir;
    const vaultContext = new VaultContext(this.plugin.app, outputDir);
    
    // Debug: log loaded files
    await vaultContext.load();
    console.log("[VaultContext] Loaded", vaultContext.getLoadedCount(), "files");
    console.log("[VaultContext] Titles:", vaultContext.getLoadedTitles().slice(0, 20));
    
    const context = await vaultContext.buildContextForQuery(text);

    try {
      let fullContent = "";
      const msgEl = this.addMessage("assistant", "");
      const typingEl = this.showTyping(msgEl);

      await sendChatStream(apiKey, model, [
        { role: "system", content: "You are an AniList assistant. Answer ONLY from the provided graph data context. If the answer isn't in the context, say so. Be concise and direct." },
        { role: "user", content: `[Context]\n${context}\n\n[Question]\n${text}` },
      ], (token) => {
        fullContent += token;
        msgEl.setText(fullContent);
        this.hideTyping(typingEl);
      });

      this.hideTyping(typingEl);
      if (!fullContent.trim()) {
        msgEl.setText("No response received from the model.");
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.addMessage("assistant", `Error: ${msg}`);
    } finally {
      this.hideLoading();
    }
  }

  private showTyping(bubbleEl: HTMLDivElement): HTMLSpanElement {
    const typing = bubbleEl.createSpan({ cls: "anisync-chat-typing" });
    typing.setText("●●●");
    return typing;
  }

  private hideTyping(typingEl: HTMLSpanElement): void {
    typingEl.remove();
  }

  private addMessage(role: "user" | "assistant", content: string): HTMLDivElement {
    if (this.messagesEl.querySelector(".anisync-chat-welcome")) {
      this.messagesEl.empty();
    }

    const msg = this.messagesEl.createDiv({
      cls: `anisync-chat-message anisync-chat-message-${role}`,
    });

    if (role === "assistant") {
      const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
      icon.setText("AI");
    }

    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    bubble.setText(content);
    this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
    return bubble;
  }

  private showLoading(): void {
    this.loadingEl.setText("Thinking...");
    this.loadingEl.show();
    this.sendBtn.disabled = true;
  }

  private hideLoading(): void {
    this.loadingEl.hide();
    this.sendBtn.disabled = false;
    this.inputEl.focus();
  }

  clearConversation(): void {
    this.showWelcome();
  }
}
