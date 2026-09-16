(() => {
  const PCP = (globalThis.PCP ??= {});

  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30000;
  // Server close codes that retrying cannot fix.
  const FATAL_CLOSE_CODES = new Map([
    [4000, "geçersiz oda kodu"],
    [4001, "oda dolu"],
  ]);

  class Transport {
    status = "idle";
    detail = null;
    #ws = null;
    #attempt = 0;
    #timer = null;
    #closed = false;

    constructor(url, { onOpen, onMessage, onStatus } = {}) {
      this.url = url;
      this.onOpen = onOpen;
      this.onMessage = onMessage;
      this.onStatus = onStatus;
    }

    connect() {
      this.#closed = false;
      clearTimeout(this.#timer);
      this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch {
        this.#closed = true;
        this.#setStatus("error", "geçersiz sunucu adresi");
        return;
      }
      this.#ws = ws;

      ws.addEventListener("open", () => {
        if (this.#ws !== ws) return;
        this.#attempt = 0;
        this.#setStatus("connected");
        this.onOpen?.();
      });

      ws.addEventListener("message", (event) => {
        if (this.#ws !== ws) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.onMessage?.(msg);
      });

      ws.addEventListener("close", (event) => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        if (this.#closed) return;
        const fatal = FATAL_CLOSE_CODES.get(event.code);
        if (fatal) {
          this.#closed = true;
          this.#setStatus("error", fatal);
          return;
        }
        this.#scheduleReconnect();
      });
    }

    send(message) {
      if (this.#ws?.readyState !== WebSocket.OPEN) return false;
      this.#ws.send(JSON.stringify(message));
      return true;
    }

    close() {
      this.#closed = true;
      clearTimeout(this.#timer);
      const ws = this.#ws;
      this.#ws = null;
      ws?.close(1000);
      this.#setStatus("disconnected");
    }

    #scheduleReconnect() {
      const delay = Math.min(BASE_DELAY_MS * 2 ** this.#attempt, MAX_DELAY_MS);
      this.#attempt += 1;
      PCP.log(`bağlantı koptu, ${delay / 1000} sn sonra yeniden denenecek`);
      this.#setStatus("reconnecting", `${delay / 1000} sn`);
      this.#timer = setTimeout(() => this.connect(), delay);
    }

    #setStatus(status, detail = null) {
      if (status === this.status && detail === this.detail) return;
      this.status = status;
      this.detail = detail;
      this.onStatus?.(status, detail);
    }
  }

  PCP.Transport = Transport;
})();
