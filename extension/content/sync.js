(() => {
  const PCP = (globalThis.PCP ??= {});

  // Clock sync
  const BURST_SIZE = 10;
  const BEST_COUNT = 3;
  const PING_TIMEOUT_MS = 2000;
  const RETRY_MS = 5000;
  const REFRESH_MS = 30000;
  const SMOOTHING = 0.2;
  const RTT_SLACK_MS = 20;
  const JUMP_LIMIT_MS = 25;
  const MAX_STRIKES = 3;

  // Drift correction
  const SOFT_THRESHOLD_S = 0.3;
  const SETTLE_THRESHOLD_S = 0.1;
  const HARD_THRESHOLD_S = 2;
  const SPEED_UP = 1.05;
  const SLOW_DOWN = 0.95;
  const HARD_SEEK_GAP_MS = 5000; // Widevine playback stalls on back-to-back seeks.
  const SOFT_TICK_MS = 250;

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  // Where the sender's video should be now. `at` is in server clock ms.
  function expectedPosition(state, serverNow) {
    if (!state.playing) return state.position;
    const elapsed = Math.max(0, (serverNow - state.at) / 1000);
    return state.position + elapsed * (state.rate || 1);
  }

  // Maps the local monotonic clock (performance.now) onto the server's monotonic clock.
  class ClockSync {
    offset = 0;
    rtt = null;
    ready = false;
    estimated = false;
    onReady = null;
    #bestRtt = Infinity;
    #pending = new Map();
    #generation = 0;
    #refreshTimer = null;
    #retryTimer = null;
    #strikes = 0;

    constructor(sendPing) {
      this.sendPing = sendPing;
    }

    get usable() {
      return this.ready || this.estimated;
    }

    now() {
      return performance.now() + this.offset;
    }

    // Rough offset from a single server timestamp, good enough until the burst completes.
    seed(serverTime) {
      if (this.ready || typeof serverTime !== "number") return;
      this.offset = serverTime - performance.now();
      this.estimated = true;
    }

    async start() {
      this.stop();
      const generation = this.#generation;
      const samples = [];
      for (let i = 0; i < BURST_SIZE; i++) {
        const sample = await this.#measure();
        if (generation !== this.#generation) return;
        if (sample) samples.push(sample);
      }
      if (samples.length === 0) {
        this.#retryTimer = setTimeout(() => this.start(), RETRY_MS);
        return;
      }

      const best = samples.sort((a, b) => a.rtt - b.rtt).slice(0, BEST_COUNT);
      this.offset = median(best.map((s) => s.offset));
      this.rtt = best[0].rtt;
      this.#bestRtt = best[0].rtt;
      this.#strikes = 0;
      this.ready = true;
      PCP.log(`saat senkronu hazır: rtt ${this.rtt.toFixed(1)} ms (${samples.length}/${BURST_SIZE} ölçüm)`);
      this.#refreshTimer = setInterval(() => this.#refresh(), REFRESH_MS);
      this.onReady?.();
    }

    stop() {
      this.#generation += 1;
      clearInterval(this.#refreshTimer);
      clearTimeout(this.#retryTimer);
      for (const { timer, resolve } of this.#pending.values()) {
        clearTimeout(timer);
        resolve(null);
      }
      this.#pending.clear();
      this.offset = 0;
      this.rtt = null;
      this.ready = false;
      this.estimated = false;
      this.#bestRtt = Infinity;
    }

    handlePong({ t0, t1 }) {
      const t3 = performance.now();
      const entry = this.#pending.get(t0);
      if (!entry || typeof t1 !== "number") return;
      this.#pending.delete(t0);
      clearTimeout(entry.timer);
      const rtt = t3 - t0;
      entry.resolve({ rtt, offset: t1 - t0 - rtt / 2 });
    }

    #measure() {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => {
          this.#pending.delete(t0);
          resolve(null);
        }, PING_TIMEOUT_MS);
        this.#pending.set(t0, { timer, resolve });
        if (!this.sendPing(t0)) {
          clearTimeout(timer);
          this.#pending.delete(t0);
          resolve(null);
        }
      });
    }

    async #refresh() {
      const generation = this.#generation;
      const sample = await this.#measure();
      if (!sample || generation !== this.#generation) return;

      const jump = Math.abs(sample.offset - this.offset);
      if (sample.rtt > this.#bestRtt * 2 + RTT_SLACK_MS || jump > JUMP_LIMIT_MS + sample.rtt / 2) {
        this.#strikes += 1;
        if (this.#strikes >= MAX_STRIKES) {
          PCP.log("saat ölçümleri tutarsız, sıfırdan senkronlanıyor");
          this.start();
        }
        return;
      }
      this.#strikes = 0;
      this.#bestRtt = Math.min(this.#bestRtt, sample.rtt);
      this.rtt = sample.rtt;
      this.offset += SMOOTHING * (sample.offset - this.offset);
    }
  }

  class DriftController {
    lastDiff = null;
    #reference = null;
    #correcting = false;
    #timer = null;
    #lastHardSeek = -Infinity;

    constructor({ player, clock, canCorrect, hardSeek }) {
      this.player = player;
      this.clock = clock;
      this.canCorrect = canCorrect;
      this.hardSeek = hardSeek;
    }

    update(reference) {
      this.#reference = reference;
      this.#evaluate();
    }

    markHardSeek() {
      this.#lastHardSeek = performance.now();
    }

    reset() {
      this.#stopSoft();
      this.#reference = null;
    }

    #evaluate() {
      const video = this.player.video;
      if (!this.#reference || !video || !this.canCorrect()) {
        this.reset();
        return;
      }

      const diff = video.currentTime - expectedPosition(this.#reference, this.clock.now());
      const abs = Math.abs(diff);
      this.lastDiff = diff;

      if (abs > HARD_THRESHOLD_S) {
        this.#stopSoft();
        if (performance.now() - this.#lastHardSeek < HARD_SEEK_GAP_MS) return;
        this.markHardSeek();
        PCP.log(`sert düzeltme: ${diff.toFixed(2)} sn`);
        this.hardSeek(video.currentTime - diff);
        return;
      }

      if (abs < (this.#correcting ? SETTLE_THRESHOLD_S : SOFT_THRESHOLD_S)) {
        this.#stopSoft();
        return;
      }

      if (!this.#correcting) PCP.log(`yumuşak düzeltme: ${diff.toFixed(2)} sn`);
      this.#correcting = true;
      this.player.setCorrectionFactor(diff > 0 ? SLOW_DOWN : SPEED_UP);
      this.#timer ??= setInterval(() => this.#evaluate(), SOFT_TICK_MS);
    }

    #stopSoft() {
      clearInterval(this.#timer);
      this.#timer = null;
      if (!this.#correcting) return;
      this.#correcting = false;
      this.player.setCorrectionFactor(1);
    }
  }

  PCP.expectedPosition = expectedPosition;
  PCP.ClockSync = ClockSync;
  PCP.DriftController = DriftController;
})();
