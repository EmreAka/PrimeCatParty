(() => {
  const PCP = (globalThis.PCP ??= {});

  // Chat UI only; sending and receiving are wired up by main.js.
  //
  //   const chat = new PCP.Chat();
  //   chat.onSend = (text) => boolean   // return false when the message could not be sent
  //   chat.addMessage({ id, clientId, name, text, at, self })   // at: ms timestamp, self: own message
  //   chat.setSelf(clientId)            // colours the composer like our own name
  //   chat.setActive(bool)              // shown only while in a room with a video
  //   chat.setEnabled(bool)             // user setting
  //   chat.clear() / chat.destroy()
  //
  // Lines sit on the video like a second subtitle track: no boxes, clicks pass through to the
  // player, and each line fades away on its own. Enter opens the composer, which also brings back
  // the history.

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      left: 0;
      bottom: 0;
      z-index: 2147483646;
      pointer-events: none;
      --font: ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif;
      --size: clamp(14px, 1.3vw, 21px);
      --ink: #ffffff;
      --ink-soft: rgba(255, 255, 255, 0.72);
      --warn: #ffd166;
      --scrim: rgba(6, 8, 18, 0.72);
      --outline: 0 0 2px #000, 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 10px rgba(0, 0, 0, 0.55);
      --me: #ffb347;
    }
    .panel {
      box-sizing: border-box;
      width: clamp(260px, 42vw, 440px);
      padding: 56px clamp(16px, 2.4vw, 40px) clamp(104px, 17vh, 190px);
      display: flex;
      flex-direction: column;
      gap: 10px;
      font: 500 var(--size)/1.32 var(--font);
      color: var(--ink);
      transition: background-color 0.2s ease;
    }
    .panel.open {
      /* Clicking the scrim closes the composer instead of toggling playback underneath. */
      pointer-events: auto;
      background: linear-gradient(90deg, var(--scrim) 0%, rgba(6, 8, 18, 0.5) 62%, transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
    }

    .feed {
      display: flex;
      flex-direction: column;
      gap: 0.3em;
      max-height: 46vh;
      overflow: hidden;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
    }
    .open .feed {
      overflow-y: auto;
      pointer-events: auto;
    }
    .line {
      margin: 0;
      max-width: 34ch;
      overflow-wrap: anywhere;
      text-shadow: var(--outline);
      transition: opacity 0.6s ease, transform 0.25s ease;
    }
    .line.entering {
      opacity: 0;
      transform: translateY(6px);
    }
    .line.spent {
      opacity: 0;
    }
    .panel:not(.open) .line:nth-last-child(n + 6) {
      display: none;
    }
    .open .line.spent {
      opacity: 0.78;
    }
    .name {
      font-weight: 800;
      color: var(--who);
      margin-right: 0.4em;
    }

    .dock {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 30px;
    }
    .tab {
      all: unset;
      flex: none;
      width: 30px;
      height: 28px;
      display: grid;
      place-items: center;
      cursor: pointer;
      color: var(--me);
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.35s ease;
      filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.8));
    }
    .awake .tab {
      opacity: 0.8;
    }
    .tab:hover,
    .tab:focus-visible,
    .open .tab {
      opacity: 1;
    }
    .tab:focus-visible {
      outline: 2px solid var(--ink);
      outline-offset: 3px;
      border-radius: 6px;
    }
    .tab svg {
      width: 30px;
      height: 28px;
      overflow: visible;
    }

    .composer {
      flex: 1;
      min-width: 0;
      display: none;
      flex-direction: column;
      gap: 4px;
    }
    .open .composer {
      display: flex;
    }
    .composer input {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      padding: 3px 0 5px;
      font: 500 var(--size)/1.3 var(--font);
      color: var(--ink);
      caret-color: var(--me);
      text-shadow: var(--outline);
      border-bottom: 2px solid var(--me);
      pointer-events: auto;
    }
    .composer input::placeholder {
      color: var(--ink-soft);
    }
    .hint {
      font-size: 0.68em;
      font-weight: 600;
      color: var(--ink-soft);
      text-shadow: var(--outline);
    }
    .hint.error {
      color: var(--warn);
    }

    @media (prefers-reduced-motion: reduce) {
      .line,
      .tab,
      .panel {
        transition: none;
      }
      .line.entering {
        transform: none;
      }
    }
  `;

  // A speech bubble with cat ears; filled in our own colour.
  const TAB_ICON = `
    <svg viewBox="0 0 30 28" aria-hidden="true">
      <path fill="currentColor" d="M5 4.5 L9.5 8.5 H20.5 L25 4.5 L25.6 10.2 C26.8 11.4 27.5 13 27.5 14.8 C27.5 19.6 22.6 22.8 15 22.8 C13.6 22.8 12.3 22.7 11.1 22.4 L5.4 26 L6.6 20.6 C4 19.2 2.5 17.2 2.5 14.8 C2.5 13 3.2 11.4 4.4 10.2 Z"/>
      <circle cx="10.5" cy="15" r="1.6" fill="#10131f"/>
      <circle cx="19.5" cy="15" r="1.6" fill="#10131f"/>
    </svg>
  `;

  // Picked to stay readable on both dark and bright frames under the outline shadow.
  // The first one is always ours; the rest go to others in the order they speak.
  const NAME_COLORS = ["#ffb347", "#8fd3ff", "#9be89b", "#ff9ebb", "#c9a7ff", "#f2d68a", "#7ee8d8", "#ffa38a"];
  const HISTORY_LIMIT = 60;
  const MAX_LENGTH = 300;
  const LINE_BASE_MS = 8000;
  const LINE_PER_CHAR_MS = 60;
  const LINE_MAX_MS = 15000;
  const AWAKE_MS = 2500;
  const KEY_EVENTS = ["keydown", "keyup", "keypress"];
  const HINT = "Enter ile gönder, boşken Enter ile kapat";

  function isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
  }

  function formatClock(at) {
    const date = new Date(Number(at) || Date.now());
    return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }

  class Chat {
    onSend = null;
    #enabled = true;
    #active = false;
    #selfId = null;
    #host = null;
    #root = null;
    #panel = null;
    #feed = null;
    #input = null;
    #hint = null;
    #tab = null;
    #ids = new Set();
    #colors = new Map(); // clientId -> colour
    #awakeTimer = null;
    #onFullscreenChange = () => this.#render();
    #onKey = (event) => this.#handleKey(event);
    #onPointer = () => this.#wake();

    constructor() {
      this.#build();
      document.addEventListener("fullscreenchange", this.#onFullscreenChange);
      for (const type of KEY_EVENTS) addEventListener(type, this.#onKey, true);
      document.addEventListener("mousemove", this.#onPointer, { capture: true, passive: true });
    }

    get #open() {
      return this.#panel.classList.contains("open");
    }

    setEnabled(enabled) {
      this.#enabled = enabled;
      this.#render();
    }

    setActive(active) {
      if (active === this.#active) return;
      this.#active = active;
      this.#render();
    }

    setSelf(clientId) {
      this.#selfId = clientId;
      this.#colors.clear();
      this.#host.style.setProperty("--me", this.#colorFor(clientId));
    }

    addMessage({ id, clientId, name, text, at, self }) {
      const body = String(text ?? "").trim();
      if (!body) return;
      if (id != null) {
        if (this.#ids.has(id)) return;
        this.#ids.add(id);
      }

      const line = document.createElement("p");
      line.className = "line entering";
      line.title = formatClock(at);
      const who = document.createElement("span");
      who.className = "name";
      who.textContent = name || "İsimsiz";
      who.style.setProperty("--who", this.#colorFor(self ? this.#selfId : clientId));
      line.append(who, body.slice(0, MAX_LENGTH));

      const stickToBottom = this.#feed.scrollHeight - this.#feed.scrollTop - this.#feed.clientHeight < 24;
      this.#feed.append(line);
      while (this.#feed.childElementCount > HISTORY_LIMIT) this.#feed.firstElementChild.remove();
      if (this.#ids.size > HISTORY_LIMIT * 4) this.#ids = new Set([...this.#ids].slice(-HISTORY_LIMIT));
      if (stickToBottom || !this.#open) this.#feed.scrollTop = this.#feed.scrollHeight;

      requestAnimationFrame(() => line.classList.remove("entering"));
      const lifetime = Math.min(LINE_MAX_MS, LINE_BASE_MS + body.length * LINE_PER_CHAR_MS);
      setTimeout(() => line.classList.add("spent"), lifetime);
    }

    clear() {
      this.#feed.replaceChildren();
      this.#ids.clear();
      this.#colors.clear();
      this.#input.value = "";
      this.#close();
    }

    destroy() {
      this.#active = false;
      this.#host.remove();
      document.removeEventListener("fullscreenchange", this.#onFullscreenChange);
      for (const type of KEY_EVENTS) removeEventListener(type, this.#onKey, true);
      document.removeEventListener("mousemove", this.#onPointer, { capture: true });
    }

    #colorFor(clientId) {
      if (clientId === this.#selfId) return NAME_COLORS[0];
      if (!this.#colors.has(clientId)) {
        this.#colors.set(clientId, NAME_COLORS[1 + (this.#colors.size % (NAME_COLORS.length - 1))]);
      }
      return this.#colors.get(clientId);
    }

    #build() {
      const { host, root } = PCP.createShadowHost("primecatparty-chat", STYLE);
      this.#host = host;
      this.#root = root;

      this.#panel = document.createElement("div");
      this.#panel.className = "panel";

      this.#feed = document.createElement("div");
      this.#feed.className = "feed";
      this.#feed.setAttribute("role", "log");
      this.#feed.setAttribute("aria-live", "polite");
      this.#feed.setAttribute("aria-label", "Sohbet");

      this.#tab = document.createElement("button");
      this.#tab.className = "tab";
      this.#tab.type = "button";
      this.#tab.title = "Sohbete yaz (Enter)";
      this.#tab.setAttribute("aria-label", "Sohbete yaz");
      this.#tab.innerHTML = TAB_ICON;
      this.#tab.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.#open) this.#close();
        else this.#openComposer();
      });

      this.#input = document.createElement("input");
      this.#input.type = "text";
      this.#input.maxLength = MAX_LENGTH;
      this.#input.placeholder = "Bir şey yaz";
      this.#input.autocomplete = "off";
      this.#input.spellcheck = false;
      this.#input.setAttribute("aria-label", "Mesaj");
      this.#input.addEventListener("input", () => this.#setHint(HINT));
      this.#input.addEventListener("blur", () => {
        // Moving the host into or out of fullscreen blurs the input; that's not the user leaving.
        if (!this.#host.isConnected) return;
        if (!this.#input.value.trim()) this.#close();
      });

      this.#hint = document.createElement("div");
      this.#hint.className = "hint";
      this.#hint.textContent = HINT;

      const composer = document.createElement("div");
      composer.className = "composer";
      composer.append(this.#input, this.#hint);

      const dock = document.createElement("div");
      dock.className = "dock";
      dock.append(this.#tab, composer);

      // Keep clicks inside the chat from reaching the player (a click there toggles playback).
      for (const type of ["click", "mousedown", "pointerdown", "dblclick"]) {
        this.#panel.addEventListener(type, (event) => event.stopPropagation());
      }

      this.#panel.append(this.#feed, dock);
      root.append(this.#panel);
    }

    #render() {
      if (!this.#enabled || !this.#active) {
        this.#close();
        this.#host.remove();
        return;
      }
      const parent = PCP.mountTarget();
      if (parent && this.#host.parentNode !== parent) {
        const refocus = this.#open;
        parent.append(this.#host);
        if (refocus) this.#input.focus({ preventScroll: true });
      }
    }

    #openComposer() {
      if (!this.#enabled || !this.#active) return;
      this.#panel.classList.add("open");
      this.#setHint(HINT);
      this.#feed.scrollTop = this.#feed.scrollHeight;
      this.#input.focus({ preventScroll: true });
    }

    #close() {
      if (!this.#open) return;
      this.#panel.classList.remove("open");
      this.#feed.scrollTop = this.#feed.scrollHeight;
      if (this.#root.activeElement === this.#input) this.#input.blur();
    }

    #send() {
      const text = this.#input.value.trim();
      if (!text) return this.#close();
      let sent = false;
      try {
        sent = typeof this.onSend === "function" && this.onSend(text) !== false;
      } catch (err) {
        PCP.log?.(`sohbet gönderilemedi: ${err?.message ?? err}`);
      }
      if (!sent) {
        this.#setHint("Mesaj gönderilemedi. Bağlantı gelince Enter ile tekrar dene.", true);
        return;
      }
      this.#input.value = "";
      this.#close();
    }

    #setHint(text, error = false) {
      this.#hint.textContent = text;
      this.#hint.classList.toggle("error", error);
    }

    // Runs in the window's capture phase so Prime's shortcuts (space, f, m, arrows) never see
    // keys typed into the chat, and Enter can open the composer from anywhere on the page.
    #handleKey(event) {
      if (!this.#enabled || !this.#active) return;
      const typing = this.#open && this.#root.activeElement === this.#input;
      if (typing) {
        event.stopImmediatePropagation();
        if (event.type !== "keydown" || event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          this.#send();
        } else if (event.key === "Escape") {
          this.#close();
        }
        return;
      }
      if (event.type !== "keydown" || event.key !== "Enter" || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditable(document.activeElement) && document.activeElement !== this.#host) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#openComposer();
    }

    #wake() {
      if (!this.#host.isConnected) return;
      this.#panel.classList.add("awake");
      clearTimeout(this.#awakeTimer);
      this.#awakeTimer = setTimeout(() => this.#panel.classList.remove("awake"), AWAKE_MS);
    }
  }

  PCP.Chat = Chat;
})();
