(() => {
  const PCP = (globalThis.PCP ??= {});

  const MIN_CONTENT_DURATION_S = 60;
  // Prime's class names churn, so ads are detected by duration: a short video while
  // the known content is long.
  const AD_MAX_DURATION_S = 90;
  const CONTENT_MIN_FOR_AD_S = 300;
  const SCAN_INTERVAL_MS = 1000;
  const SCAN_THROTTLE_MS = 150;
  const RATE_EPSILON = 1e-3;
  const DEEP_SCAN_INTERVAL_MS = 3000;

  const VIDEO_EVENTS = [
    "play",
    "pause",
    "seeked",
    "ratechange",
    "ended",
    "waiting",
    "canplay",
    "playing",
    "durationchange",
    "emptied",
  ];
  const LOGGED_EVENTS = new Set(["play", "pause", "seeked", "ratechange", "ended", "waiting", "canplay"]);
  // Media events don't bubble, but a capturing document listener still sees them.
  const DOCUMENT_EVENTS = ["loadedmetadata", "durationchange", "play", "emptied"];

  class Player {
    video = null;
    contentDuration = 0;
    adActive = false;
    baseRate = 1;
    #correction = 1;
    #internalRateChanges = 0;
    #observer = null;
    #pollTimer = null;
    #scanTimer = null;
    #scanning = false;
    #videos = [];
    #shadowVideos = [];
    #lastDeepScan = -Infinity;

    constructor({ onEvent, onVideoChange, onAdChange } = {}) {
      this.onEvent = onEvent;
      this.onVideoChange = onVideoChange;
      this.onAdChange = onAdChange;
    }

    start() {
      this.#observer = new MutationObserver(this.#scheduleScan);
      this.#observer.observe(document.documentElement, { childList: true, subtree: true });
      for (const type of DOCUMENT_EVENTS) document.addEventListener(type, this.#scheduleScan, true);
      document.addEventListener("fullscreenchange", this.#scheduleScan);
      this.#pollTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
      this.scan();
    }

    stop() {
      this.#observer?.disconnect();
      for (const type of DOCUMENT_EVENTS) document.removeEventListener(type, this.#scheduleScan, true);
      document.removeEventListener("fullscreenchange", this.#scheduleScan);
      clearInterval(this.#pollTimer);
      clearTimeout(this.#scanTimer);
      this.#unbind();
    }

    scan() {
      if (this.#scanning) return;
      this.#scanning = true;
      try {
        const videos = this.#findVideos();
        this.#videos = videos;
        let best = null;
        for (const video of videos) {
          if (this.#isContent(video) && (!best || video.duration > best.duration)) best = video;
        }

        const current = this.video;
        const currentUsable = current?.isConnected && (this.#isContent(current) || this.#isAdLike(current));
        if (best && best !== current && (!currentUsable || best.duration > current.duration)) {
          this.#attach(best);
        } else if (current && !current.isConnected) {
          this.#detach();
        }

        this.#setAd(
          videos.some((v) => this.#isAdLike(v) && (v === this.video || (!v.paused && v.videoWidth > 0))),
        );
      } finally {
        this.#scanning = false;
      }
    }

    // Snapshot of every <video> seen in the last scan and why it was (not) picked.
    describeVideos() {
      return this.#videos.map((video) => ({
        inShadow: video.getRootNode() !== document,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : String(video.duration),
        size: `${video.videoWidth}x${video.videoHeight}`,
        readyState: video.readyState,
        paused: video.paused,
        verdict: this.#verdict(video),
      }));
    }

    #verdict(video) {
      if (video === this.video) return this.adActive ? "seçili (reklamda)" : "seçili";
      if (Number.isNaN(video.duration)) return "süre yok (metadata yüklenmedi)";
      if (this.#isAdLike(video)) return "reklam sanıldı";
      if (!(video.duration > MIN_CONTENT_DURATION_S)) return `çok kısa (≤ ${MIN_CONTENT_DURATION_S} sn)`;
      if (video.videoWidth === 0) return "görüntü yok (videoWidth 0)";
      return "daha uzun bir video tercih edildi";
    }

    #findVideos() {
      const videos = Array.from(document.querySelectorAll("video"));
      if (videos.length > 0) return videos;
      // Fall back to shadow roots (closed ones too, via chrome.dom), throttled since it walks the whole tree.
      if (performance.now() - this.#lastDeepScan >= DEEP_SCAN_INTERVAL_MS) {
        this.#lastDeepScan = performance.now();
        this.#shadowVideos = collectShadowVideos(document.documentElement);
      }
      return this.#shadowVideos.filter((video) => video.isConnected);
    }

    play() {
      this.video?.play()?.catch((err) => PCP.log("play reddedildi:", err.message));
    }

    pause() {
      this.video?.pause();
    }

    seekTo(position) {
      const video = this.video;
      if (!video) return;
      const max = Number.isFinite(video.duration) ? video.duration - 0.5 : position;
      video.currentTime = Math.max(0, Math.min(position, max));
    }

    setBaseRate(rate) {
      if (!(rate > 0)) return;
      this.baseRate = rate;
      this.#applyRate();
    }

    setCorrectionFactor(factor) {
      this.#correction = factor;
      this.#applyRate();
    }

    #applyRate() {
      const video = this.video;
      if (!video) return;
      const target = this.baseRate * this.#correction;
      if (Math.abs(video.playbackRate - target) < RATE_EPSILON) return;
      this.#internalRateChanges += 1;
      video.playbackRate = target;
    }

    #isAdLike(video) {
      return (
        this.contentDuration >= CONTENT_MIN_FOR_AD_S &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.duration <= AD_MAX_DURATION_S
      );
    }

    #isContent(video) {
      return video.duration > MIN_CONTENT_DURATION_S && video.videoWidth > 0 && !this.#isAdLike(video);
    }

    #scheduleScan = () => {
      if (this.#scanTimer) return;
      this.#scanTimer = setTimeout(() => {
        this.#scanTimer = null;
        this.scan();
      }, SCAN_THROTTLE_MS);
    };

    #attach(video) {
      this.#unbind();
      this.video = video;
      this.contentDuration = video.duration;
      this.baseRate = video.playbackRate || 1;
      this.#correction = 1;
      this.#internalRateChanges = 0;
      for (const type of VIDEO_EVENTS) video.addEventListener(type, this.#handleEvent);
      PCP.log(`video bulundu: ${Math.round(video.duration)} sn, ${video.videoWidth}x${video.videoHeight}`);
      this.onVideoChange?.(video);
    }

    #detach() {
      if (!this.video) return;
      this.#unbind();
      PCP.log("video kayboldu");
      this.onVideoChange?.(null);
    }

    #unbind() {
      const video = this.video;
      if (!video) return;
      for (const type of VIDEO_EVENTS) video.removeEventListener(type, this.#handleEvent);
      if (this.#correction !== 1) video.playbackRate = this.baseRate;
      this.#correction = 1;
      this.video = null;
    }

    #setAd(active) {
      if (active === this.adActive) return;
      this.adActive = active;
      PCP.log(active ? "reklam başladı" : "reklam bitti");
      this.onAdChange?.(active);
    }

    #handleEvent = (event) => {
      const video = event.currentTarget;
      if (video !== this.video) return;
      const { type } = event;

      if (type === "durationchange" && video.duration > AD_MAX_DURATION_S) {
        this.contentDuration = video.duration;
      }

      let internal = false;
      if (type === "ratechange") {
        if (this.#internalRateChanges > 0) {
          this.#internalRateChanges -= 1;
          internal = true;
        } else {
          this.baseRate = video.playbackRate;
          this.#correction = 1;
        }
      }

      // Refresh ad state first so listeners see it for this very event.
      this.scan();

      if (LOGGED_EVENTS.has(type) && !internal) {
        PCP.log(`${type} @ ${video.currentTime.toFixed(2)}`, type === "ratechange" ? video.playbackRate : "");
      }
      this.onEvent?.(type, video, { internal });
    };
  }

  function collectShadowVideos(root) {
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (!(node instanceof Element)) continue;
      const shadow = chrome.dom?.openOrClosedShadowRoot?.(node) ?? node.shadowRoot;
      if (!shadow) continue;
      found.push(...shadow.querySelectorAll("video"));
      for (const child of shadow.children) found.push(...collectShadowVideos(child));
    }
    return found;
  }

  PCP.Player = Player;
})();
