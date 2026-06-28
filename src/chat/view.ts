import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView } from "obsidian";
import type AnisyncPlugin from "../main";
import { VaultContext } from "./vaultContext";
import { sendChatStream } from "../openrouter/client";

export const CHAT_VIEW_TYPE = "ani-sync-chat-view";

interface StreamingMessage {
  bubbleEl: HTMLDivElement;
  fullContent: string;
  displayedContent: string;
  animationId: number | null;
  isComplete: boolean;
  resolve: (value: void) => void;
}

export class ChatView extends ItemView {
  private plugin: AnisyncPlugin;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private loadingEl!: HTMLDivElement;
  private currentStream: StreamingMessage | null = null;
  private readonly TYPING_SPEED_MS = 15;

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
    if (this.currentStream?.animationId) {
      cancelAnimationFrame(this.currentStream.animationId);
    }
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
    
    await vaultContext.load();
    const context = await vaultContext.buildContextForQuery(text);

    try {
      const msgEl = this.addMessage("assistant", "");
      const bubbleEl = msgEl.querySelector(".anisync-chat-bubble") as HTMLDivElement;
      
      const streamPromise = new Promise<void>((resolve) => {
        this.currentStream = {
          bubbleEl,
          fullContent: "",
          displayedContent: "",
          animationId: null,
          isComplete: false,
          resolve,
        };
      });

      await sendChatStream(apiKey, model, [
        { role: "system", content: "You are an AniList assistant. Answer ONLY from the provided graph data context. If the answer isn't in the context, say so. Be concise and direct. Use markdown formatting for readability." },
        { role: "user", content: `[Context]\n${context}\n\n[Question]\n${text}` },
      ], (token) => {
        this.onTokenReceived(token);
      });

      await streamPromise;
      this.finishStreaming();
      
      if (!this.currentStream?.fullContent.trim()) {
        await this.renderMarkdown(bubbleEl, "No response received from the model.");
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.addMessage("assistant", `Error: ${msg}`);
    } finally {
      this.hideLoading();
      this.currentStream = null;
    }
  }

  private onTokenReceived(token: string): void {
    if (!this.currentStream) return;
    
    this.currentStream.fullContent += token;
    
    if (!this.currentStream.animationId) {
      this.startTypewriterAnimation();
    }
  }

  private startTypewriterAnimation(): void {
    if (!this.currentStream) return;
    
    const animate = () => {
      if (!this.currentStream) return;
      
      const remaining = this.currentStream.fullContent.length - this.currentStream.displayedContent.length;
      
      if (remaining > 0) {
        const charsToAdd = Math.max(1, Math.ceil(remaining * 0.1));
        this.currentStream.displayedContent = this.currentStream.fullContent.slice(0, this.currentStream.displayedContent.length + charsToAdd);
        this.renderMarkdown(this.currentStream.bubbleEl, this.currentStream.displayedContent + "▋");
      }
      
      if (this.currentStream.displayedContent.length < this.currentStream.fullContent.length) {
        this.currentStream.animationId = requestAnimationFrame(animate);
      } else if (this.currentStream.isComplete) {
        this.renderMarkdown(this.currentStream.bubbleEl, this.currentStream.fullContent);
        this.currentStream.resolve();
      } else {
        this.currentStream.animationId = requestAnimationFrame(animate);
      }
    };
    
    this.currentStream.animationId = requestAnimationFrame(animate);
  }

  private finishStreaming(): void {
    if (!this.currentStream) return;
    
    this.currentStream.isComplete = true;
    
    if (this.currentStream.animationId) {
      cancelAnimationFrame(this.currentStream.animationId);
      this.currentStream.animationId = null;
    }
    
    this.renderMarkdown(this.currentStream.bubbleEl, this.currentStream.fullContent);
    this.currentStream.resolve();
  }

  private async renderMarkdown(el: HTMLDivElement, content: string): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(
      this.plugin.app,
      content,
      el,
      "",
      this
    );
    
    this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
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
    
    if (role === "user") {
      bubble.setText(content);
    } else {
      this.renderMarkdown(bubble, content);
    }
    
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
