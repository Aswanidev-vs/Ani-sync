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
  private vaultContext: VaultContext | null = null;
  private lastOutputDir: string = "";

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
    container.style.cssText = "display: flex; flex-direction: column; height: 100%; overflow: hidden;";

    this.messagesEl = container.createDiv({ cls: "anisync-chat-messages" });
    this.messagesEl.style.cssText = "flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; align-content: flex-start;";
    this.showWelcome();

    const inputArea = container.createDiv({ cls: "anisync-chat-input-area" });
    inputArea.style.cssText = "display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--background-modifier-border); background: var(--background-primary); flex-shrink: 0;";
    
    this.inputEl = inputArea.createEl("textarea", {
      cls: "anisync-chat-input",
      attr: { placeholder: "Ask about your AniList library...", rows: "2" },
    });
    this.inputEl.style.cssText = "flex: 1; resize: none; border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px 10px; font-size: 13px; background: var(--background-secondary); color: var(--text-normal); min-height: 36px;";
    
    this.sendBtn = inputArea.createEl("button", {
      cls: "anisync-chat-send-btn",
      text: "Send",
    });
    this.sendBtn.style.cssText = "align-self: flex-end; padding: 6px 14px; border-radius: 6px; border: none; background: var(--color-accent); color: var(--text-on-accent); font-size: 13px; font-weight: 600; cursor: pointer;";

    this.loadingEl = container.createDiv({ cls: "anisync-chat-loading" });
    this.loadingEl.style.cssText = "padding: 6px 12px; font-size: 12px; color: var(--text-muted); text-align: center;";
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
    this.sendBtn.disabled = true;

    const outputDir = this.plugin.settings.outputDir;
    
    // Reuse cached VaultContext if outputDir hasn't changed
    if (!this.vaultContext || this.lastOutputDir !== outputDir) {
      this.vaultContext = new VaultContext(this.plugin.app, outputDir);
      this.lastOutputDir = outputDir;
    }
    
    await this.vaultContext.load();
    const context = await this.vaultContext.buildContextForQuery(text);

    try {
      const msgEl = this.addMessage("assistant", "");
      const bubbleEl = msgEl.querySelector(".anisync-chat-bubble") as HTMLDivElement;
      bubbleEl.innerHTML = '<span class="anisync-chat-thinking">Thinking...</span>';
      
      this.currentStream = {
        bubbleEl,
        fullContent: "",
        displayedContent: "",
        animationId: null,
        isComplete: false,
        resolve: () => {},
      };

      await sendChatStream(apiKey, model, [
        { role: "system", content: "You are an AniList assistant. Answer ONLY from the provided graph data context. If the answer isn't in the context, say so. Be concise and direct. Use markdown formatting for readability." },
        { role: "user", content: `[Context]\n${context}\n\n[Question]\n${text}` },
      ], (token) => {
        this.onTokenReceived(token);
      });

      // Stream finished - now wait for animation to catch up
      await new Promise<void>((resolve) => {
        this.currentStream!.resolve = resolve;
        this.finishStreaming();
      });
      
      if (!this.currentStream?.fullContent.trim()) {
        await this.renderMarkdown(bubbleEl, "No response received from the model.", false);
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.addMessage("assistant", `Error: ${msg}`);
    } finally {
      this.sendBtn.disabled = false;
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
    
    let isRendering = false;
    
    const animate = async () => {
      if (!this.currentStream || isRendering) return;
      
      const remaining = this.currentStream.fullContent.length - this.currentStream.displayedContent.length;
      
      if (remaining > 0) {
        isRendering = true;
        const charsToAdd = Math.max(1, Math.ceil(remaining * 0.15));
        this.currentStream.displayedContent = this.currentStream.fullContent.slice(0, this.currentStream.displayedContent.length + charsToAdd);
        await this.renderMarkdown(this.currentStream.bubbleEl, this.currentStream.displayedContent, true);
        isRendering = false;
      }
      
      if (this.currentStream.displayedContent.length < this.currentStream.fullContent.length) {
        this.currentStream.animationId = requestAnimationFrame(animate);
      } else if (this.currentStream.isComplete) {
        // Animation caught up to content - render final without cursor
        await this.renderMarkdown(this.currentStream.bubbleEl, this.currentStream.fullContent, false);
        this.currentStream.animationId = null;
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
    // Let animation loop finish naturally - it will call resolve() when caught up
  }

  private async renderMarkdown(el: HTMLDivElement, content: string, showCursor: boolean = false): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(
      this.plugin.app,
      content,
      el,
      "",
      this
    );
    
    // Add blinking cursor only during streaming
    if (showCursor && content.length > 0) {
      const cursor = document.createElement("span");
      cursor.className = "anisync-cursor";
      cursor.textContent = "▋";
      el.appendChild(cursor);
    }
    
    this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
  }

  private addMessage(role: "user" | "assistant", content: string): HTMLDivElement {
    if (this.messagesEl.querySelector(".anisync-chat-welcome")) {
      this.messagesEl.empty();
    }

    const msg = this.messagesEl.createDiv({
      cls: `anisync-chat-message anisync-chat-message-${role}`,
    });
    msg.style.cssText = "display: flex; gap: 8px; max-width: 95%;" + (role === "user" ? " align-self: flex-end; flex-direction: row-reverse;" : " align-self: flex-start;");

    if (role === "assistant") {
      const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
      icon.style.cssText = "width: 24px; height: 24px; border-radius: 4px; background: var(--color-accent); color: var(--text-on-accent); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0;";
      icon.setText("AI");
    }

    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    bubble.style.cssText = role === "user" 
      ? "padding: 10px 14px; border-radius: 12px; background: var(--color-accent); color: var(--text-on-accent); font-size: 13px; line-height: 1.6; word-break: break-word; max-width: 100%;"
      : "padding: 10px 14px; border-radius: 12px; background: var(--background-secondary); color: var(--text-normal); font-size: 13px; line-height: 1.6; word-break: break-word; max-width: 100%;";
    
    if (role === "user") {
      bubble.setText(content);
    } else {
      this.renderMarkdown(bubble, content);
    }
    
    this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
    return msg;
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
