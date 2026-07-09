import { ItemView, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import type AnisyncPlugin from "../main";
import { VaultContext } from "./vaultContext";
import { sendChatStream } from "../openrouter/client";
import { LOGO_DATA_URL } from "./logo";

export const CHAT_VIEW_TYPE = "ani-sync-chat-view";

const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
const STOP_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;

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
  private newChatBtn!: HTMLButtonElement;
  private loadingEl!: HTMLDivElement;
  private currentStream: StreamingMessage | null = null;
  private vaultContext: VaultContext | null = null;
  private lastOutputDir: string = "";
  private streamAbortController: AbortController | null = null;

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

    // Header bar with title + new chat button
    const header = container.createDiv({ cls: "anisync-chat-header" });
    const title = header.createSpan({ cls: "anisync-chat-header-title" });
    title.textContent = "Ani-sync Chat";
    this.newChatBtn = header.createEl("button", { cls: "anisync-chat-new-btn", title: "New chat" });
    this.newChatBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    this.newChatBtn.onclick = () => this.clearChat();

    // Messages area
    this.messagesEl = container.createDiv({ cls: "anisync-chat-messages" });

    // Input area
    const inputArea = container.createDiv({ cls: "anisync-chat-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "anisync-chat-input",
      attr: { placeholder: "Ask about your AniList library...", rows: "2" },
    });

    this.sendBtn = inputArea.createEl("button", { cls: "anisync-chat-send-btn" });
    this.updateSendButton(false);

    this.loadingEl = container.createDiv({ cls: "anisync-chat-loading" });
    this.loadingEl.hide();

    this.sendBtn.onclick = () => {
      if (this.currentStream) this.stopStreaming();
      else void this.handleSend();
    };
    this.inputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleSend(); }
    };

    // Load chat history
    const messages = this.plugin.getActiveChatMessages();
    if (messages.length > 0) {
      for (const msg of messages) {
        if (msg.role === "user") {
          this.addUserMessage(msg.content, false);
        } else {
          this.addAssistantMessage(msg.content, false);
        }
      }
      this.scrollDown();
    } else {
      this.showWelcome("Loading your library...");
    }
    this.preloadVaultContext();
  }

  private async preloadVaultContext(): Promise<void> {
    const outputDir = this.plugin.settings.outputDir;
    if (!this.vaultContext || this.lastOutputDir !== outputDir) {
      this.vaultContext = new VaultContext(this.plugin.app, outputDir);
      this.lastOutputDir = outputDir;
    }
    await this.vaultContext.load((msg) => this.showWelcome(msg));
    if (!this.hasChatMessages()) {
      this.showWelcome();
    }
  }

  async onClose(): Promise<void> {
    this.stopStreaming();
    if (this.currentStream?.animationId) {
      cancelAnimationFrame(this.currentStream.animationId);
    }
  }

  private clearChat(): void {
    this.currentStream = null;
    this.streamAbortController = null;
    this.messagesEl.empty();
    this.plugin.startNewChat();
    this.showWelcome();
    this.updateSendButton(false);
  }

  private showWelcome(loadingText?: string): void {
    if (this.hasChatMessages() && !loadingText) return;
    if (!loadingText && this.messagesEl.querySelector(".anisync-chat-welcome")) return;

    this.messagesEl.empty();
    this.messagesEl.style.backgroundImage = `url(${LOGO_DATA_URL})`;
    this.messagesEl.style.backgroundRepeat = "no-repeat";
    this.messagesEl.style.backgroundPosition = "center 88px";
    this.messagesEl.style.backgroundSize = "120px auto";

    const username = this.plugin.settings.anilistUsername;
    const text = username ? `Search anime, ${username}` : "Search anime";

    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-welcome" });
    msg.setText(loadingText ?? text);
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    const quick = this.getQuickResponse(text);
    if (quick) {
      this.addUserMessage(text);
      this.addAssistantMessage(quick);
      return;
    }

    this.addUserMessage(text);
    this.inputEl.value = "";
    this.updateSendButton(true);

    const apiKey = this.plugin.settings.openrouterApiKey;
    const model = this.plugin.settings.openrouterModel;
    const availableModels = this.plugin.settings.openrouterAvailableModels;
    if (!apiKey || !model) {
      this.addAssistantMessage("Please configure your OpenRouter API key and select a model in **Settings → Ani-sync → OpenRouter AI**.");
      this.updateSendButton(false);
      return;
    }

    if (availableModels.length > 0 && !availableModels.some((m) => m.id === model)) {
      this.addAssistantMessage("Your selected OpenRouter model is no longer valid for the current API key. Re-fetch models in **Settings -> Ani-sync -> OpenRouter AI** and pick one again.");
      this.updateSendButton(false);
      return;
    }

    const outputDir = this.plugin.settings.outputDir;
    if (this.vaultContext && this.lastOutputDir === outputDir && this.vaultContext.getLoadedCount() > 0) {
      // already loaded
    } else if (!this.vaultContext || this.lastOutputDir !== outputDir) {
      this.vaultContext = new VaultContext(this.plugin.app, outputDir);
      this.lastOutputDir = outputDir;
      await this.vaultContext.load();
    } else {
      await this.vaultContext.load();
    }

    const context = await this.vaultContext.buildContextForQuery(text);

    const msgEl = this.createAssistantBubble();
    const bubbleEl = msgEl.lastChild as HTMLDivElement;
    bubbleEl.innerHTML = '<span class="anisync-chat-thinking"><span class="anisync-thinking-dot"></span><span class="anisync-thinking-dot"></span><span class="anisync-thinking-dot"></span></span>';
    this.scrollDown();

    try {
      this.currentStream = {
        bubbleEl, fullContent: "", displayedContent: "",
        animationId: null, isComplete: false, resolved: false, resolve: () => {},
      };
      this.streamAbortController = new AbortController();

      await sendChatStream(
        this.plugin.settings.openrouterApiKey,
        this.plugin.settings.openrouterModel,
        [
          { role: "system", content: "You are an AniList assistant. Answer ONLY from the provided graph data context. If the answer isn't in the context, say so. Be concise and direct. Use markdown formatting for readability." },
          { role: "user", content: `[Context]\n${context}\n\n[Question]\n${text}` },
        ],
        (token) => this.onTokenReceived(token),
        this.streamAbortController.signal,
      );

      if (this.currentStream) {
        await new Promise<void>((resolve) => {
          if (!this.currentStream) { resolve(); return; }
          this.currentStream.resolve = resolve;
          this.finishStreaming();
          if (!this.currentStream.animationId) this.flushCompletedStream();
        });
      }

      if (!this.currentStream?.fullContent.trim()) {
        await this.renderMarkdown(bubbleEl, "No response received from the model.", false);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if ((err as Error).name === "AbortError") {
        // user stopped the response; keep any partial content that was already streamed
      } else if (msg.includes("name not resolved") || msg.includes("ENOTFOUND") || msg.includes("DNS")) {
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
      this.updateSendButton(false);
      this.streamAbortController = null;
      this.currentStream = null;
    }
  }

  private stopStreaming(): void {
    if (!this.currentStream) return;
    this.streamAbortController?.abort();
    this.finishStreaming();
    if (!this.currentStream.animationId) this.flushCompletedStream();
    this.updateSendButton(false);
  }

  private updateSendButton(isStreaming: boolean): void {
    this.sendBtn.disabled = false;
    this.sendBtn.innerHTML = isStreaming ? STOP_ICON : SEND_ICON;
    this.sendBtn.title = isStreaming ? "Stop response" : "Send message";
    this.sendBtn.classList.toggle("is-stop", isStreaming);
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
    const content = s.fullContent.trim() ? s.fullContent : "No response received from the model.";
    void this.renderMarkdown(s.bubbleEl, content, false).finally(() => {
      this.plugin.saveChatMessage("assistant", content);
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

  private addUserMessage(text: string, save = true): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-user" });
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    bubble.setText(text);
    this.scrollDown();
    if (save) this.plugin.saveChatMessage("user", text);
  }

  private addAssistantMessage(text: string, save = true): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-assistant" });
    const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
    icon.textContent = "AI";
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    this.renderMarkdown(bubble, text, false);
    if (save) this.plugin.saveChatMessage("assistant", text);
  }

  private createAssistantBubble(): HTMLDivElement {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-assistant" });
    const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
    icon.textContent = "AI";
    msg.createDiv({ cls: "anisync-chat-bubble" });
    this.scrollDown();
    return msg;
  }

  private removeWelcome(): void {
    const w = this.messagesEl.querySelector(".anisync-chat-welcome");
    if (w) { w.remove(); this.messagesEl.style.backgroundImage = "none"; }
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
    if (["weather", "news", "politics", "code", "programming", "math", "recipe", "stock", "crypto"].some(k => t.includes(k)))
      return "I can only answer questions about your AniList library. Try asking about your anime, manga, characters, or voice actors.";
    return null;
  }

  invalidateVaultContext(): void {
    this.vaultContext?.invalidate();
    this.vaultContext = null;
  }
}
