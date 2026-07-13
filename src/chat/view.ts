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
  lastRenderTime: number;
}

export class ChatView extends ItemView {
  private plugin: AnisyncPlugin;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private newChatBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private historyDropdown!: HTMLDivElement;
  private loadingEl!: HTMLDivElement;
  private currentStream: StreamingMessage | null = null;
  private vaultContext: VaultContext | null = null;
  private lastOutputDir: string = "";
  private streamAbortController: AbortController | null = null;
  private isSending = false;
  private isClosed = false;
  private userScrolledUp = false;

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
    // History button (placed first)
    this.historyBtn = header.createEl("button", { cls: "anisync-chat-history-btn", title: "Chat history", attr: { "aria-label": "Chat history" } });
    this.historyBtn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
    this.historyBtn.onclick = () => this.toggleHistoryDropdown();

    // New chat button (placed after history)
    this.newChatBtn = header.createEl("button", { cls: "anisync-chat-new-btn", title: "New chat", attr: { "aria-label": "New chat" } });
    this.newChatBtn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    this.newChatBtn.onclick = () => this.clearChat();

    // History dropdown (hidden by default)
    this.historyDropdown = container.createDiv({ cls: "anisync-chat-history-dropdown" });
    this.historyDropdown.hide();

    // Messages area with wrapper for pull-to-refresh
    const messagesWrapper = container.createDiv({ cls: "anisync-chat-messages-wrapper" });
    messagesWrapper.style.position = "relative";
    messagesWrapper.style.flex = "1";
    messagesWrapper.style.overflow = "hidden";

    this.messagesEl = messagesWrapper.createDiv({ cls: "anisync-chat-messages", attr: { "role": "log", "aria-live": "polite", "aria-label": "Chat messages" } });

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
          this.addUserMessage(msg.content, false, msg.timestamp);
        } else {
          this.addAssistantMessage(msg.content, false, msg.timestamp);
        }
      }
      this.scrollDown();
    } else {
      this.showWelcome("Loading your library...");
    }

    // Track user scroll position to prevent force-scrolling when reading history
    this.messagesEl.onscroll = () => {
      const el = this.messagesEl;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      this.userScrolledUp = !atBottom;
    };

    this.preloadVaultContext();

    // Swipe-to-refresh for mobile
    this.setupPullToRefresh();

    // Close dropdown when clicking outside
    this.registerDomEvent(document, "click", (e) => {
      if (!this.historyDropdown.contains(e.target as Node) && e.target !== this.historyBtn) {
        this.historyDropdown.hide();
      }
    });
  }

  private setupPullToRefresh(): void {
    const messagesEl = this.messagesEl;
    const messagesWrapper = messagesEl.parentElement;
    if (!messagesWrapper) return;

    let startY = 0;
    let isPulling = false;
    let pullDistance = 0;
    const THRESHOLD = 80;
    const MAX_PULL = 120;

    const refreshIndicator = document.createElement("div");
    refreshIndicator.className = "anisync-pull-to-refresh";
    refreshIndicator.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg><span>Pull to refresh</span>`;
    refreshIndicator.style.cssText = `
      position: absolute;
      top: -60px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      color: var(--text-muted);
      font-size: 13px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: none;
      z-index: 10;
    `;
    // Insert into wrapper instead of messagesEl so it survives empty() calls
    messagesWrapper.insertBefore(refreshIndicator, messagesWrapper.firstChild);

    const handleTouchStart = (e: TouchEvent) => {
      if (messagesEl.scrollTop === 0 && !this.isSending) {
        startY = e.touches[0].clientY;
        isPulling = true;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isPulling) return;
      const currentY = e.touches[0].clientY;
      pullDistance = Math.max(0, currentY - startY);
      
      if (pullDistance > 0) {
        e.preventDefault();
        const progress = Math.min(pullDistance / THRESHOLD, 1);
        const limitedPull = Math.min(pullDistance, MAX_PULL);
        
        refreshIndicator.style.opacity = String(progress);
        refreshIndicator.style.transform = `translateX(-50%) translateY(${limitedPull * 0.5}px)`;
        refreshIndicator.querySelector("svg")?.setAttribute("style", `transform: rotate(${progress * 180}deg); transition: transform 0.1s;`);
        
        if (pullDistance >= THRESHOLD) {
          refreshIndicator.querySelector("span")!.textContent = "Release to refresh";
        } else {
          refreshIndicator.querySelector("span")!.textContent = "Pull to refresh";
        }
      }
    };

    const handleTouchEnd = async () => {
      if (!isPulling) return;
      isPulling = false;

      if (pullDistance >= THRESHOLD) {
        refreshIndicator.querySelector("span")!.textContent = "Refreshing...";
        refreshIndicator.querySelector("svg")?.setAttribute("style", "animation: spin 1s linear infinite;");

        // Add spin animation
        const style = document.createElement("style");
        style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
        if (!document.querySelector("style[data-pull-refresh]")) {
          style.setAttribute("data-pull-refresh", "true");
          document.head.appendChild(style);
        }

        try {
          await this.plugin.refreshPlugin();
          this.messagesEl.empty();
          this.showWelcome("Loading your library...");
          await this.preloadVaultContext();
        } finally {
          // Reset indicator (always executes even if refresh throws)
          refreshIndicator.style.opacity = "0";
          refreshIndicator.style.transform = "translateX(-50%) translateY(0)";
          refreshIndicator.querySelector("svg")?.removeAttribute("style");
          pullDistance = 0;
        }
      } else {
        // Reset indicator for incomplete pull
        refreshIndicator.style.opacity = "0";
        refreshIndicator.style.transform = "translateX(-50%) translateY(0)";
        refreshIndicator.querySelector("svg")?.removeAttribute("style");
        pullDistance = 0;
      }
    };

    this.registerDomEvent(messagesEl, "touchstart", handleTouchStart, { passive: true });
    this.registerDomEvent(messagesEl, "touchmove", handleTouchMove, { passive: false });
    this.registerDomEvent(messagesEl, "touchend", handleTouchEnd, { passive: true });
    this.registerDomEvent(messagesEl, "touchcancel", handleTouchEnd, { passive: true });
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
    this.isClosed = true;
    this.stopStreaming();
    if (this.currentStream?.animationId) {
      cancelAnimationFrame(this.currentStream.animationId);
    }
  }

  private clearChat(): void {
    // Abort any active stream before clearing
    this.streamAbortController?.abort();
    this.currentStream = null;
    this.streamAbortController = null;
    this.messagesEl.empty();
    this.plugin.startNewChat();
    this.showWelcome();
    this.updateSendButton(false);
  }

  private toggleHistoryDropdown(): void {
    if (this.historyDropdown.isShown()) {
      this.historyDropdown.hide();
    } else {
      this.renderHistoryList();
      this.historyDropdown.show();
    }
  }

  private renderHistoryList(): void {
    this.historyDropdown.empty();
    const sessions = this.plugin.getAllChatSessions();

    if (sessions.length === 0) {
      const empty = this.historyDropdown.createDiv({ cls: "anisync-history-empty" });
      empty.setText("No chat history yet");
      return;
    }

    for (const session of sessions) {
      const item = this.historyDropdown.createDiv({ cls: "anisync-history-item" });
      if (session.id === this.plugin.activeChatId) {
        item.addClass("is-active");
      }

      const info = item.createDiv({ cls: "anisync-history-item-info" });
      const titleEl = info.createDiv({ cls: "anisync-history-item-title" });
      titleEl.setText(session.title);
      const metaEl = info.createDiv({ cls: "anisync-history-item-meta" });
      const date = new Date(session.updatedAt);
      const timeStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      metaEl.setText(`${session.messages.length} messages · ${timeStr}`);

      const deleteBtn = item.createEl("button", { cls: "anisync-history-item-delete", attr: { "aria-label": "Delete chat" } });
      deleteBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.deleteSession(session.id);
      };

      item.onclick = () => {
        this.loadSession(session.id);
        this.historyDropdown.hide();
      };
    }

    // Delete all button
    if (sessions.length > 1) {
      const deleteAllBtn = this.historyDropdown.createDiv({ cls: "anisync-history-delete-all" });
      deleteAllBtn.setText("Delete all history");
      deleteAllBtn.onclick = () => this.deleteAllSessions();
    }
  }

  private loadSession(sessionId: string): void {
    this.plugin.loadChatSession(sessionId);
    this.messagesEl.empty();
    const messages = this.plugin.getActiveChatMessages();
    for (const msg of messages) {
      if (msg.role === "user") {
        this.addUserMessage(msg.content, false);
      } else {
        this.addAssistantMessage(msg.content, false);
      }
    }
    this.scrollDown();
  }

  private deleteSession(sessionId: string): void {
    this.plugin.deleteChatSession(sessionId);
    if (sessionId === this.plugin.activeChatId) {
      const sessions = this.plugin.getAllChatSessions();
      if (sessions.length > 0) {
        this.loadSession(sessions[0].id);
      } else {
        this.plugin.startNewChat();
        this.messagesEl.empty();
        this.showWelcome();
      }
    }
    this.renderHistoryList();
  }

  private deleteAllSessions(): void {
    this.plugin.deleteAllChatSessions();
    this.plugin.startNewChat();
    this.messagesEl.empty();
    this.showWelcome();
    this.historyDropdown.hide();
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
    if (this.isSending) return;
    this.isSending = true;

    try {
      const text = this.inputEl.value.trim();
      if (!text) return;

      const quick = this.getQuickResponse(text);
      if (quick) {
        this.addUserMessage(text);
        this.addAssistantMessage(quick);
        this.inputEl.value = "";
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
      if (!this.vaultContext || this.lastOutputDir !== outputDir) {
        this.vaultContext = new VaultContext(this.plugin.app, outputDir);
        this.lastOutputDir = outputDir;
      }

      // Save local reference in case invalidateVaultContext() is called during async ops
      const vaultContext = this.vaultContext;

      // Create assistant bubble FIRST so errors are visible
      const msgEl = this.createAssistantBubble();
      const bubbleEl = msgEl.lastChild as HTMLDivElement;
      bubbleEl.innerHTML = '<span class="anisync-chat-thinking"><span class="anisync-thinking-dot"></span><span class="anisync-thinking-dot"></span><span class="anisync-thinking-dot"></span></span>';
      this.scrollDown();

      let context: string;
      try {
        await vaultContext.load();
        context = await vaultContext.buildContextForQuery(text);
      } catch (vaultErr) {
        const errMsg = (vaultErr as Error).message ?? String(vaultErr);
        await this.renderMarkdown(bubbleEl, `Error loading library: ${errMsg}`, false);
        this.scrollDown();
        return;
      }

      try {
        this.currentStream = {
          bubbleEl, fullContent: "", displayedContent: "",
          animationId: null, isComplete: false, resolved: false, resolve: () => {},
          lastRenderTime: 0,
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
        if (this.isClosed) return;
        const msg = (err as Error).message ?? String(err);
        if ((err as Error).name === "AbortError") {
          // user stopped the response; keep any partial content that was already streamed
        } else if (msg.includes("name not resolved") || msg.includes("ENOTFOUND") || msg.includes("DNS")) {
          bubbleEl.textContent = "Cannot reach OpenRouter API — DNS resolution failed. Check your internet connection or the API endpoint.";
        } else if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("Unauthorized")) {
          bubbleEl.textContent = "OpenRouter API key is invalid. Go to Settings → Ani-sync → OpenRouter AI and update your key.";
        } else if (msg.includes("429") || msg.includes("rate limit")) {
          bubbleEl.textContent = "OpenRouter rate limit exceeded. Wait a moment and try again.";
        } else if (msg.includes("timeout") || msg.includes("TIMEOUT")) {
          bubbleEl.textContent = "OpenRouter request timed out. The API might be slow right now — try again.";
        } else {
          bubbleEl.textContent = `Error: ${msg}`;
        }
        this.scrollDown();
      } finally {
        if (!this.isClosed) {
          this.updateSendButton(false);
        }
        this.streamAbortController = null;
        this.currentStream = null;
        this.isSending = false;
      }
    } finally {
      this.isSending = false;
    }
  }

  private stopStreaming(): void {
    if (!this.currentStream) return;
    // Mark as complete first to stop typewriter from processing more tokens
    this.currentStream.isComplete = true;
    // Abort the stream
    this.streamAbortController?.abort();
    // Flush any remaining content
    this.flushCompletedStream();
    this.updateSendButton(false);
  }

  private updateSendButton(isStreaming: boolean): void {
    this.sendBtn.disabled = false;
    this.sendBtn.innerHTML = isStreaming ? STOP_ICON : SEND_ICON;
    this.sendBtn.title = isStreaming ? "Stop response" : "Send message";
    this.sendBtn.setAttribute("aria-label", isStreaming ? "Stop response" : "Send message");
    this.sendBtn.classList.toggle("is-stop", isStreaming);
  }

  private onTokenReceived(token: string): void {
    if (!this.currentStream || this.currentStream.isComplete) return;
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

    // Throttle re-renders to every 200ms to reduce CPU usage
    const now = Date.now();
    if (now - s.lastRenderTime < 200) return;
    s.lastRenderTime = now;

    // Always re-render markdown with the growing displayedContent
    s.bubbleEl.empty();
    MarkdownRenderer.render(this.plugin.app, s.displayedContent, s.bubbleEl, "", this);
    s.bubbleEl.createSpan({ cls: "anisync-cursor", text: "▋" });
    this.scrollDown();
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
    try {
      await MarkdownRenderer.render(this.plugin.app, content, el, "", this);
    } catch {
      el.textContent = content;
    }
    if (showCursor && content.length > 0) {
      el.createSpan({ cls: "anisync-cursor", text: "▋" });
    }
    this.scrollDown();
  }

  private addUserMessage(text: string, save = true, timestamp?: number): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-user" });
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    bubble.setText(text);
    const timeEl = msg.createDiv({ cls: "anisync-chat-timestamp" });
    const ts = timestamp ?? Date.now();
    timeEl.setText(new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
    this.scrollDown();
    if (save) this.plugin.saveChatMessage("user", text);
  }

  private addAssistantMessage(text: string, save = true, timestamp?: number): void {
    this.removeWelcome();
    const msg = this.messagesEl.createDiv({ cls: "anisync-chat-message anisync-chat-message-assistant" });
    const icon = msg.createSpan({ cls: "anisync-chat-avatar" });
    icon.textContent = "AI";
    const bubble = msg.createDiv({ cls: "anisync-chat-bubble" });
    this.renderMarkdown(bubble, text, false);
    const timeEl = msg.createDiv({ cls: "anisync-chat-timestamp" });
    const ts = timestamp ?? Date.now();
    timeEl.setText(new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
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
    if (w) {
      w.remove();
    }
    // Always clear background styles in case empty() already removed the welcome element
    this.messagesEl.style.backgroundImage = "";
    this.messagesEl.style.backgroundRepeat = "";
    this.messagesEl.style.backgroundPosition = "";
    this.messagesEl.style.backgroundSize = "";
  }

  private hasChatMessages(): boolean {
    return !!this.messagesEl.querySelector(".anisync-chat-message");
  }

  private scrollDown(): void {
    // Only auto-scroll if user hasn't scrolled up manually
    if (this.userScrolledUp) return;
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
