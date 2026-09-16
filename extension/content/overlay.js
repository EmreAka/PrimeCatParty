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

  class Overlay {
    #host = null;
    #box = null;
    #enabled = true;
    #state = null;

    constructor() {
      document.addEventListener("fullscreenchange", () => this.#render());
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
        rows.push(row(`${state.peers} kişi · ${state.isHost ? "host" : "misafir"}`));
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
        this.#host = document.createElement("primecatparty-overlay");
        const root = this.#host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = STYLE;
        this.#box = document.createElement("div");
        this.#box.className = "box";
        root.append(style, this.#box);
      }
      // Fullscreen hides everything outside the fullscreen element, so follow it there.
      const fullscreen = document.fullscreenElement;
      const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.body;
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
