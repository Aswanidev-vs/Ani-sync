import { ItemView, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import type AnisyncPlugin from "../main";
import { VaultContext } from "./vaultContext";
import { sendChatStream } from "../openrouter/client";
import { LOGO_DATA_URL } from "./logo";

export const CHAT_VIEW_TYPE = "ani-sync-chat-view";

interface StreamingMessage {
  bubbleEl: HTMLDivElement;
  fullContent: string;
  displayedContent: string;
  animationId: number | null;
  isComplete: boolean;
  resolved: boolean;
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

  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return "Ani-sync Chat"; }
  getIcon(): string { return "message-circle"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("anisync-chat-container");
    container.style.cssText = "display: flex; flex-direction: column; height: 100%; overflow: hidden;";

    this.messagesEl = container.createDiv({ cls: "anisync-chat-messages" });
    this.messagesEl.style.cssText = "flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; align-content: flex-start; min-height: 0;";

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

    this.sendBtn.onclick = () => this.handleSend();
    this.inputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleSend(); }
    };

    this.showWelcome("Loading your library...");
    this.preloadVaultContext();
  }

  private async preloadVaultContext(): Promise<void> {
    const outputDir = this.plugin.settings.outputDir;
    if (!this.vaultContext || this.lastOutputDir !== outputDir) {
      this.vaultContext = new VaultContext(this.plugin.app, outputDir);
      this.lastOutputDir = outputDir;
    }
    await this.vaultContext.load();
    if (!this.hasChatMessages()) {
      this.showWelcome();
    }
  }

  async onClose(): Promise<void> {
    if (this.currentStream?.animationId) {
      cancelAnimationFrame(this.currentStream.animationId);
    }
  }

  private showWelcome(loadingText?: string): void {
    if (this.hasChatMessages()) {
      return;
    }
    this.messagesEl.empty();
    this.messagesEl.style.backgroundImage = `url(${LOGO_DATA_URL})`;
    this.messagesEl.style.backgroundRepeat = "no-repeat";
    this.messagesEl.style.backgroundPosition = "center 40px";
    this.messagesEl.style.backgroundSize = "120px auto";

    const username = this.plugin.settings.anilistUsername;
    const text = username ? `Search anime, ${username}` : "Search anime";

    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-welcome" });
    msg.style.cssText = "text-align: center; padding: 180px 16px 32px; font-family: var(--font-interface); font-size: 18px; color: var(--text-muted);";
    msg.setText(loadingText ?? text);
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    // Quick response for greetings / out-of-context — no vault load, no API call
    const quick = this.getQuickResponse(text);
    if (quick) {
      this.addUserMessage(text);
      this.addAssistantMessage(quick);
      return;
    }

    this.addUserMessage(text);
    this.inputEl.value = "";
    this.sendBtn.disabled = true;

    // Preflight: check API key and model before vault load
    const apiKey = this.plugin.settings.openrouterApiKey;
    const model = this.plugin.settings.openrouterModel;
    const availableModels = this.plugin.settings.openrouterAvailableModels;
    if (!apiKey || !model) {
      this.addAssistantMessage("Please configure your OpenRouter API key and select a model in **Settings → Ani-sync → OpenRouter AI**.");
      this.sendBtn.disabled = false;
      return;
    }

    if (availableModels.length > 0 && !availableModels.some((m) => m.id === model)) {
      this.addAssistantMessage("Your selected OpenRouter model is no longer valid for the current API key. Re-fetch models in **Settings -> Ani-sync -> OpenRouter AI** and pick one again.");
      this.sendBtn.disabled = false;
      return;
    }

    // Build or reuse vault context
    const outputDir = this.plugin.settings.outputDir;
    if (this.vaultContext && this.lastOutputDir === outputDir && this.vaultContext.getLoadedCount() > 0) {
      // already loaded — just search
    } else if (!this.vaultContext || this.lastOutputDir !== outputDir) {
      this.vaultContext = new VaultContext(this.plugin.app, outputDir);
      this.lastOutputDir = outputDir;
      await this.vaultContext.load();
    } else {
      await this.vaultContext.load();
    }

    // Search and build context for LLM
    const context = await this.vaultContext.buildContextForQuery(text);

    // Create the assistant bubble directly (no renderMarkdown on empty content)
    const msgEl = this.createAssistantBubble();
    const bubbleEl = msgEl.lastChild as HTMLDivElement;
    bubbleEl.innerHTML = '<span class="anisync-chat-thinking">Thinking...</span>';
    this.scrollDown();

    try {
      this.currentStream = {
        bubbleEl, fullContent: "", displayedContent: "",
        animationId: null, isComplete: false, resolved: false, resolve: () => {},
      };

      await sendChatStream(
        this.plugin.settings.openrouterApiKey,
        this.plugin.settings.openrouterModel,
        [
          { role: "system", content: "You are an AniList assistant. Answer ONLY from the provided graph data context. If the answer isn't in the context, say so. Be concise and direct. Use markdown formatting for readability." },
          { role: "user", content: `[Context]\n${context}\n\n[Question]\n${text}` },
        ],
        (token) => this.onTokenReceived(token),
      );

      if (this.currentStream) {
        await new Promise<void>((resolve) => {
          if (!this.currentStream) {
            resolve();
            return;
          }
          this.currentStream.resolve = resolve;
          this.finishStreaming();
          if (!this.currentStream.animationId) {
            this.flushCompletedStream();
          }
        });
      }

      if (!this.currentStream?.fullContent.trim()) {
        await this.renderMarkdown(bubbleEl, "No response received from the model.", false);
      }
    } catch (err) {
      const e = err as Error;
      const msg = e.message ?? String(e);
      if (msg.includes("name not resolved") || msg.includes("ENOTFOUND") || msg.includes("DNS")) {
        bubbleEl.innerHTML = "Cannot reach OpenRouter API — DNS resolution failed. Check your internet connection or the API endpoint.";
      } else if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("Unauthorized")) {
        bubbleEl.innerHTML = "OpenRouter API key is invalid. Go to Settings → Ani-sync → OpenRouter AI and update your key.";
      } else if (msg.includes("429") || msg.includes("rate limit")) {
        bubbleEl.innerHTML = "OpenRouter rate limit exceeded. Wait a moment and try again.";
      } else if (msg.includes("timeout") || msg.includes("TIMEOUT")) {
        bubbleEl.innerHTML = "OpenRouter request timed out. The API might be slow right now — try again.";
      } else {
        bubbleEl.innerHTML = `Error: ${msg}`;
      }
      this.scrollDown();
    } finally {
      this.sendBtn.disabled = false;
      this.currentStream = null;
    }
  }

  private onTokenReceived(token: string): void {
    if (!this.currentStream) return;
    this.currentStream.fullContent += token;
    if (!this.currentStream.animationId) {
      this.currentStream.animationId = requestAnimationFrame(() => this.typewriterLoop());
    }
  }

  private typewriterLoop(): void {
    if (!this.currentStream) return;
    const s = this.currentStream;
    const remaining = s.fullContent.length - s.displayedContent.length;

    if (remaining > 0) {
      const chars = Math.max(1, Math.ceil(remaining * 0.15));
      s.displayedContent = s.fullContent.slice(0, s.displayedContent.length + chars);
    }

    if (s.displayedContent.length < s.fullContent.length) {
      s.animationId = requestAnimationFrame(() => this.typewriterLoop());
    } else if (s.isComplete) {
      s.animationId = null;
      this.flushCompletedStream();
      return;
    } else {
      s.animationId = requestAnimationFrame(() => this.typewriterLoop());
      return;
    }

    // Batch-render: skip if a render is already queued
    if (!s.bubbleEl.querySelector(".anisync-cursor")) {
      s.bubbleEl.empty();
      MarkdownRenderer.render(this.plugin.app, s.displayedContent, s.bubbleEl, "", this);
      s.bubbleEl.createSpan({ cls: "anisync-cursor", text: "▋" });
      this.scrollDown();
    }
  }

  private finishStreaming(): void {
    if (this.currentStream) this.currentStream.isComplete = true;
  }

  private flushCompletedStream(): void {
    const s = this.currentStream;
    if (!s || s.resolved || !s.isComplete) return;

    s.resolved = true;
    void this.renderMarkdown(
      s.bubbleEl,
      s.fullContent.trim() ? s.fullContent : "No response received from the model.",
      false,
    ).finally(() => {
      s.resolve();
    });
  }

  private async renderMarkdown(el: HTMLDivElement, content: string, showCursor = false): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.plugin.app, content, el, "", this);
    if (showCursor && content.length > 0) {
      el.createSpan({ cls: "anisync-cursor", text: "▋" });
    }
    this.scrollDown();
  }

  private addUserMessage(text: string): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-user" });
    msg.style.cssText = "display: flex; gap: 8px; max-width: 95%; align-self: flex-end; flex-direction: row-reverse;";
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    bubble.setText(text);
    this.scrollDown();
  }

  private addAssistantMessage(text: string): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-assistant" });
    msg.style.cssText = "display: flex; gap: 8px; max-width: 95%; align-self: flex-start;";
    const icon = msg.createSpan({ cls: "anisync-chat-avatar", text: "AI" });
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    this.renderMarkdown(bubble, text, false);
  }

  private createAssistantBubble(): HTMLDivElement {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-assistant" });
    msg.style.cssText = "display: flex; gap: 8px; max-width: 95%; align-self: flex-start;";
    const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
    icon.style.cssText = "width: 24px; height: 24px; border-radius: 4px; background: var(--color-accent); color: var(--text-on-accent); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0;";
    icon.setText("AI");
    msg.createDiv({ cls: "anisync-chat-bubble" });
    return msg;
  }

  private removeWelcome(): void {
    const w = this.messagesEl.querySelector(".anisync-chat-welcome");
    if (w) {
      w.remove();
      this.messagesEl.style.backgroundImage = "none";
    }
  }

  private hasChatMessages(): boolean {
    return !!this.messagesEl.querySelector(".anisync-chat-message");
  }

  private scrollDown(): void {
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
  }

  private getQuickResponse(text: string): string | null {
    const t = text.toLowerCase().trim();
    if (["hi", "hello", "hey", "hola", "howdy", "greetings", "yo", "sup"].some(g => t === g || t.startsWith(g + " ")))
      return "Hey! I'm your AniList library assistant. Ask me about your anime, manga, characters, studios, or voice actors.";
    if (["thanks", "thank you", "thx", "ty"].some(g => t.startsWith(g)))
      return "You're welcome! Let me know if you want to explore your library.";
    if (["bye", "goodbye", "see you", "later"].some(g => t.startsWith(g)))
      return "Bye! Happy watching/reading!";
    if (["who are you", "what are you", "what can you do", "help"].some(g => t.includes(g)))
      return "I'm an AI assistant with access to your synced AniList library.\n\n**Examples:**\n- \"What anime have I rated 10?\"\n- \"Show me all Studio MAPPA works\"\n- \"What's my highest rated manga?\"\n- \"Who voices Naruto?\"";
    if (["weather", "news", "politics", "code", "programming", "math", "recipe", "movie", "game", "stock", "crypto"].some(k => t.includes(k)))
      return "I can only answer questions about your AniList library. Try asking about your anime, manga, characters, or voice actors.";
    return null;
  }

  invalidateVaultContext(): void {
    this.vaultContext?.invalidate();
    this.vaultContext = null;
  }
}
