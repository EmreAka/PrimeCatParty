(() => {
  const PCP = (globalThis.PCP ??= {});

  const CONNECTION_LABELS = {
    idle: "Beklemede",
    connecting: "Bağlanıyor",
    connected: "Bağlı",
    reconnecting: "Yeniden bağlanıyor",
    disconnected: "Kopuk",
    error: "Kopuk",
  };

  const CONNECTION_COLORS = {
    idle: "#9e9e9e",
    connecting: "#ffb300",
    connected: "#4caf50",
    reconnecting: "#ffb300",
    disconnected: "#e53935",
    error: "#e53935",
  };

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 2147483647;
      pointer-events: none;
    }
    .box {
      font: 12px/1.45 system-ui, sans-serif;
      color: #fff;
      background: rgba(0, 0, 0, 0.65);
      padding: 6px 9px;
      border-radius: 6px;
      max-width: 280px;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .warning { color: #ffca28; }
  `;

  const TOAST_STYLE = `
    :host {
      all: initial;
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .toast {
      font: 600 22px/1.3 system-ui, sans-serif;
      color: #fff;
      background: rgba(0, 0, 0, 0.78);
      padding: 12px 22px;
      border-radius: 12px;
      text-align: center;
      max-width: 70vw;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .toast.visible { opacity: 1; }
  `;

  const TOAST_DURATION_MS = 2500;
  const TOAST_LIMIT = 3;

  // Fullscreen hides everything outside the fullscreen element, so follow it there.
  function mountTarget() {
    const fullscreen = document.fullscreenElement;
    return fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.body;
  }

  function createShadowHost(tag, css) {
    const host = document.createElement(tag);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style);
    return { host, root };
  }

  class Toasts {
    #host = null;
    #root = null;

    constructor() {
      document.addEventListener("fullscreenchange", () => {
        if (this.#host?.isConnected) this.#mount();
      });
    }

    show(text) {
      if (!this.#host) ({ host: this.#host, root: this.#root } = createShadowHost("primecatparty-toast", TOAST_STYLE));
      this.#mount();

      const toasts = this.#root.querySelectorAll(".toast");
      if (toasts.length >= TOAST_LIMIT) toasts[0].remove();

      const toast = document.createElement("div");
      toast.className = "toast";
      toast.textContent = text;
      this.#root.append(toast);
      requestAnimationFrame(() => toast.classList.add("visible"));
      setTimeout(() => {
        toast.classList.remove("visible");
        setTimeout(() => {
          toast.remove();
          if (!this.#root.querySelector(".toast")) this.#host.remove();
        }, 300);
      }, TOAST_DURATION_MS);
    }

    #mount() {
      const parent = mountTarget();
      if (parent && this.#host.parentNode !== parent) parent.append(this.#host);
    }
  }

  class Overlay {
    #host = null;
    #box = null;
    #enabled = true;
    #state = null;
    #toasts = new Toasts();

    constructor() {
      document.addEventListener("fullscreenchange", () => this.#render());
    }

    notify(text) {
      PCP.log(`bildirim: ${text}`);
      this.#toasts.show(text);
    }

    setEnabled(enabled) {
      this.#enabled = enabled;
      this.#render();
    }

    update(state) {
      this.#state = state;
      this.#render();
    }

    #render() {
      const state = this.#state;
      if (!this.#enabled || !state?.roomId || !state.hasVideo) {
        this.#host?.remove();
        return;
      }
      this.#mount();

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = CONNECTION_COLORS[state.connection] ?? CONNECTION_COLORS.idle;
      const label = CONNECTION_LABELS[state.connection] ?? state.connection;
      const rows = [row(dot, `${label}${state.detail ? ` (${state.detail})` : ""} · ${state.roomId}`)];

      if (state.connection === "connected") {
        const names = state.members.length ? `: ${state.members.join(", ")}` : "";
        rows.push(row(`${state.peers} kişi${names} · ${state.isHost ? "host" : "misafir"}`));
      }
      if (state.driftMs !== null) {
        const sign = state.driftMs > 0 ? "+" : "";
        rows.push(row(`${state.isHost ? "En büyük fark" : "Host'a fark"}: ${sign}${state.driftMs} ms`));
      }
      if (state.rttMs !== null) rows.push(row(`RTT: ${state.rttMs} ms`));
      for (const warning of state.warnings) {
        const element = row(`⚠ ${warning}`);
        element.className = "warning";
        rows.push(element);
      }
      this.#box.replaceChildren(...rows);
    }

    #mount() {
      if (!this.#host) {
        const { host, root } = createShadowHost("primecatparty-overlay", STYLE);
        this.#host = host;
        this.#box = document.createElement("div");
        this.#box.className = "box";
        root.append(this.#box);
      }
      const parent = mountTarget();
      if (parent && this.#host.parentNode !== parent) parent.append(this.#host);
    }
  }

  function row(...children) {
    const element = document.createElement("div");
    element.append(...children);
    return element;
  }

  PCP.Overlay = Overlay;
})();
