(() => {
  const PCP = globalThis.PCP;
  if (!PCP) return;
  // Re-injection after an extension reload can share a world with the orphaned copy; retire it first.
  PCP.shutdown?.();
  PCP.shutdown = shutdown;

  const { Transport, ClockSync, DriftController, Player, Overlay, expectedPosition, log } = PCP;

  const DEFAULT_SETTINGS = { serverUrl: "ws://localhost:8080", overlay: true };
  // Time window, not a flag: `seeked` can arrive 200-300 ms after a remote seek is applied.
  const SUPPRESS_MS = 400;
  const HEARTBEAT_MS = 3000;
  // Local controls wait this long so ad transitions (pause/seek fired before the ad is detected) can be dropped.
  const LOCAL_SEND_DELAY_MS = 400;
  const AD_EXIT_GRACE_MS = 1500;
  const CONTROL_GRACE_MS = 1500;
  const VIDEO_LOST_GRACE_MS = 15000;
  const BUFFER_REPORT_DELAY_MS = 500;
  const CONTENT_CHECK_MS = 1000;
  const DURATION_TOLERANCE_S = 2;
  const CONTROL_ACTIONS = { play: "play", pause: "pause", seeked: "seek", ratechange: "rate" };

  const clientId = crypto.randomUUID();
  let settings = { ...DEFAULT_SETTINGS };
  let roomId = null;
  let transport = null;
  let session = newSession();
  let suppressUntil = 0;
  let adEndedAt = -Infinity;
  let localContent = null;
  let lostTimer = null;
  let bufferTimer = null;
  let reported = false;
  let lastReportKey = null;
  let lastDiagKey = null;
  let lastSearchKey = null;
  let stopped = false;
  const intervals = [];

  const player = new Player({ onEvent: onPlayerEvent, onVideoChange, onAdChange });
  const clock = new ClockSync((t0) => transport?.send({ type: "ping", t0 }) ?? false);
  const drift = new DriftController({
    player,
    clock,
    canCorrect: () => canFollowHost() && !player.video.paused,
    hardSeek: (position) => applyRemote(() => player.seekTo(position)),
  });
  const overlay = new Overlay();

  clock.onReady = () => {
    afterClockSync();
    report();
  };

  init().catch((err) => log("başlatılamadı:", err));

  async function init() {
    log(`içerik betiği başladı: ${location.href}`);
    settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    if (stopped) return;
    log(`ayarlar: sunucu ${settings.serverUrl}, gösterge ${settings.overlay ? "açık" : "kapalı"}`);
    overlay.setEnabled(settings.overlay);
    chrome.storage.onChanged.addListener(onSettingsChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    player.start();
    intervals.push(
      setInterval(sendHeartbeat, HEARTBEAT_MS),
      setInterval(() => {
        checkContent();
        logVideoSearch();
        report();
        sendDiagnostics();
      }, CONTENT_CHECK_MS),
    );
    globalThis.navigation?.addEventListener("navigatesuccess", () => checkContent());
    addEventListener("pagehide", () => {
      if (reported) sendToBackground({ type: "status", status: null });
      if (lastDiagKey) sendToBackground({ type: "diag", diag: null });
    });

    const response = await chrome.runtime.sendMessage({ type: "getRoom" });
    if (stopped) return;
    log(`arka plandan oda: ${response?.roomId ?? "yok"}`);
    setRoom(response?.roomId ?? null);
  }

  function onRuntimeMessage(message) {
    if (message?.type !== "roomChanged") return;
    log(`oda değişti: ${message.roomId ?? "yok"}`);
    setRoom(message.roomId ?? null);
  }

  function newSession() {
    return {
      joined: false,
      isHost: false,
      hostId: null,
      peers: 0,
      pendingState: null,
      needsInitialHeartbeat: false,
      remoteAds: new Set(),
      remoteBuffering: new Set(),
      peerContent: new Map(),
      peerDrift: new Map(),
      autoPaused: false,
      pendingControl: null,
      bufferingReported: false,
      lastControlAt: -Infinity,
      lastControlLocal: -Infinity,
    };
  }

  // ---- Settings & room -------------------------------------------------------

  function onSettingsChanged(changes, area) {
    if (area !== "local") return;
    if (changes.overlay) {
      settings.overlay = changes.overlay.newValue ?? DEFAULT_SETTINGS.overlay;
      overlay.setEnabled(settings.overlay);
    }
    if (changes.serverUrl) {
      settings.serverUrl = changes.serverUrl.newValue || DEFAULT_SETTINGS.serverUrl;
      if (transport) {
        disconnect();
        connectIfReady();
      }
    }
  }

  function setRoom(next) {
    if (next === roomId) return;
    disconnect();
    roomId = next;
    if (!roomId) log("odadan ayrılındı");
    connectIfReady();
    report();
  }

  // ---- Connection --------------------------------------------------------------

  // Only a frame that actually holds the player connects; other frames stay silent.
  function connectIfReady() {
    if (stopped || transport || !roomId) return;
    if (!player.video) {
      log("oda var ama bu çerçevede uygun video yok, bağlantı bekletiliyor");
      return;
    }
    log(`odaya bağlanılıyor: ${roomId} (${settings.serverUrl})`);
    transport = new Transport(settings.serverUrl, {
      onOpen,
      onMessage,
      onStatus: onTransportStatus,
    });
    transport.connect();
  }

  function disconnect() {
    if (!transport) return;
    transport.close();
    transport = null;
    endSession();
    report();
  }

  function endSession() {
    clock.stop();
    drift.reset();
    clearTimeout(bufferTimer);
    session = newSession();
  }

  function onTransportStatus(status, detail) {
    log(`bağlantı: ${status}${detail ? ` (${detail})` : ""}`);
    if (status !== "connected") endSession();
    report();
  }

  function onOpen() {
    endSession();
    transport.send({ type: "join", roomId, clientId });
    // Never trust an offset from a previous connection.
    clock.start();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "pong":
        return clock.handlePong(msg);
      case "joined":
        return onJoined(msg);
      case "peerJoined":
        return onPeerJoined(msg);
      case "peerLeft":
        return onPeerLeft(msg);
      case "control":
        return onRemoteControl(msg);
      case "heartbeat":
        return onHeartbeat(msg);
      case "adBreak":
        return onRemoteAd(msg);
      case "buffering":
        return onRemoteBuffering(msg);
      case "contentChanged":
        return onRemoteContent(msg);
    }
  }

  function onJoined(msg) {
    Object.assign(session, {
      joined: true,
      isHost: msg.isHost,
      hostId: msg.hostId ?? null,
      peers: msg.peers,
      pendingState: msg.state ?? null,
      needsInitialHeartbeat: !msg.state,
    });
    clock.seed(msg.t1);
    log(`odaya katılındı: ${msg.peers} kişi, ${msg.isHost ? "host" : "misafir"}`);
    checkContent(true);
    announceLocalHolds();
    if (clock.ready) afterClockSync();
    report();
  }

  function afterClockSync() {
    if (!session.joined) return;
    if (session.pendingState) {
      const state = session.pendingState;
      session.pendingState = null;
      if (!contentMatches(state.clientId)) return;
      log("oda durumuna senkronlanılıyor", state);
      applyControl(state);
    } else if (session.needsInitialHeartbeat) {
      session.needsInitialHeartbeat = false;
      sendHeartbeat();
    }
  }

  function onPeerJoined(msg) {
    session.peers = msg.peers;
    session.hostId = msg.hostId ?? session.hostId;
    log(`katılımcı geldi (${msg.peers} kişi)`);
    checkContent(true);
    announceLocalHolds();
    report();
  }

  function onPeerLeft(msg) {
    session.peers = msg.peers;
    session.hostId = msg.hostId ?? session.hostId;
    const wasHost = session.isHost;
    session.isHost = session.hostId === clientId;
    if (session.isHost && !wasHost) {
      log("host artık bu sekme");
      drift.reset();
    }
    for (const collection of [session.remoteAds, session.remoteBuffering, session.peerContent, session.peerDrift]) {
      collection.delete(msg.clientId);
    }
    log(`katılımcı ayrıldı (${msg.peers} kişi)`);
    resumeIfClear();
    report();
  }

  // Tell newcomers about ad/buffer pauses they would otherwise never hear about.
  function announceLocalHolds() {
    if (player.adActive) transport?.send({ type: "adBreak", clientId, active: true });
    if (session.bufferingReported) transport?.send({ type: "buffering", clientId, active: true });
  }

  // ---- Echo suppression & applying remote state --------------------------------

  function applyRemote(fn) {
    suppressUntil = performance.now() + SUPPRESS_MS;
    fn();
  }

  function onRemoteControl(msg) {
    log(`uzak ${msg.action} @ ${Number(msg.position).toFixed(2)}`);
    if (!contentMatches(msg.clientId)) {
      log("farklı içerik, komut yok sayıldı");
      return;
    }
    applyControl(msg);
  }

  function applyControl(state) {
    const video = player.video;
    if (!video || !clock.usable) return;
    if (player.adActive) {
      session.pendingControl = state;
      return;
    }
    session.pendingControl = null;
    session.lastControlAt = state.at;
    session.lastControlLocal = performance.now();
    drift.reset();

    const target = expectedPosition(state, clock.now());
    const hold = state.playing && (session.remoteAds.size > 0 || session.remoteBuffering.size > 0);
    applyRemote(() => {
      if (state.rate > 0) player.setBaseRate(state.rate);
      const threshold = state.action === "seek" ? 0.05 : 0.5;
      if (Math.abs(video.currentTime - target) > threshold) {
        player.seekTo(target);
        drift.markHardSeek();
      }
      session.autoPaused = hold;
      if (state.playing && !hold) {
        if (video.paused) player.play();
      } else if (!video.paused) {
        player.pause();
      }
    });
  }

  function canFollowHost() {
    const video = player.video;
    return (
      session.joined &&
      !session.isHost &&
      clock.ready &&
      !!video &&
      !video.seeking &&
      !player.adActive &&
      !session.autoPaused &&
      session.remoteAds.size === 0 &&
      session.remoteBuffering.size === 0 &&
      performance.now() - session.lastControlLocal > CONTROL_GRACE_MS
    );
  }

  // ---- Heartbeats & drift ------------------------------------------------------

  function sendHeartbeat() {
    const video = player.video;
    if (!session.joined || !video || !clock.usable) return;
    if (player.adActive || session.autoPaused || session.bufferingReported || video.seeking) return;
    transport.send({
      type: "heartbeat",
      clientId,
      fromHost: session.isHost,
      position: video.currentTime,
      playing: !video.paused,
      rate: player.baseRate,
      at: clock.now(),
    });
  }

  function onHeartbeat(msg) {
    const video = player.video;
    if (!video || !clock.usable) return;
    session.peerDrift.set(msg.clientId, video.currentTime - expectedPosition(msg, clock.now()));
    // Only guests correct, and only toward the host; otherwise both sides chase each other.
    if (msg.fromHost && !session.isHost) followHost(msg);
    report();
  }

  function followHost(msg) {
    if (msg.at <= session.lastControlAt || !canFollowHost() || !contentMatches(msg.clientId)) return;
    const video = player.video;
    if (msg.playing === video.paused) {
      log("oynatma durumu host ile uyuşmuyor, düzeltiliyor");
      applyControl(msg);
    } else if (msg.playing) {
      drift.update(msg);
    } else if (Math.abs(video.currentTime - msg.position) > 0.5) {
      applyControl(msg);
    }
  }

  // ---- Local player events -----------------------------------------------------

  function onVideoChange(video) {
    if (video) {
      clearTimeout(lostTimer);
      lostTimer = null;
      drift.reset();
      checkContent();
      connectIfReady();
    } else {
      onBufferRecovered();
      // Episode changes and fullscreen swap the element; don't drop the room for a brief gap.
      if (transport && !lostTimer) {
        lostTimer = setTimeout(() => {
          lostTimer = null;
          if (player.video) return;
          log("video bulunamadı, bağlantı kapatılıyor");
          disconnect();
        }, VIDEO_LOST_GRACE_MS);
      }
    }
    report();
  }

  function onPlayerEvent(type, video, { internal }) {
    if (video !== player.video || !session.joined) return;
    if (type === "waiting") return onWaiting();
    if (type === "canplay" || type === "playing") onBufferRecovered();
    if (type === "play" && performance.now() - adEndedAt < AD_EXIT_GRACE_MS && hasRemoteHolds()) {
      return holdPlayback();
    }
    const action = CONTROL_ACTIONS[type];
    if (!action || internal || performance.now() < suppressUntil) return;
    queueLocalControl(action, video);
  }

  function queueLocalControl(action, video) {
    if (player.adActive || !clock.usable || performance.now() - adEndedAt < AD_EXIT_GRACE_MS) return;
    const control = {
      type: "control",
      action,
      clientId,
      position: video.currentTime,
      playing: !video.paused,
      rate: player.baseRate,
      at: clock.now(),
    };
    session.lastControlLocal = performance.now();
    drift.reset();

    const current = session;
    setTimeout(() => {
      if (session !== current || player.video !== video || player.adActive) return;
      if (performance.now() - adEndedAt < AD_EXIT_GRACE_MS) return;
      if (action === "play" || action === "pause") session.autoPaused = false;
      session.lastControlAt = control.at;
      session.lastControlLocal = performance.now();
      log(`yerel ${action} gönderiliyor @ ${control.position.toFixed(2)}`);
      transport?.send(control);
      report();
    }, LOCAL_SEND_DELAY_MS);
  }

  // ---- Ads ----------------------------------------------------------------------

  function onAdChange(active) {
    if (!active) adEndedAt = performance.now();
    if (!session.joined) return report();
    transport.send({ type: "adBreak", clientId, active });
    drift.reset();
    if (!active) {
      if (hasRemoteHolds()) holdPlayback();
      else if (session.pendingControl) applyControl(session.pendingControl);
    }
    report();
  }

  function onRemoteAd(msg) {
    log(`uzak reklam ${msg.active ? "başladı" : "bitti"}`);
    if (msg.active) {
      session.remoteAds.add(msg.clientId);
      holdPlayback();
    } else {
      session.remoteAds.delete(msg.clientId);
      resumeIfClear();
    }
    report();
  }

  // ---- Buffering ------------------------------------------------------------------

  function onWaiting() {
    const video = player.video;
    if (!video || video.paused || player.adActive || session.bufferingReported) return;
    clearTimeout(bufferTimer);
    const current = session;
    bufferTimer = setTimeout(() => {
      const v = player.video;
      if (session !== current || !v || v.paused || player.adActive) return;
      if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      session.bufferingReported = true;
      log("buffer boşaldı, diğerleri bekletiliyor");
      transport?.send({ type: "buffering", clientId, active: true });
      drift.reset();
      report();
    }, BUFFER_REPORT_DELAY_MS);
  }

  function onBufferRecovered() {
    clearTimeout(bufferTimer);
    if (!session.bufferingReported) return;
    session.bufferingReported = false;
    log("buffer doldu");
    transport?.send({ type: "buffering", clientId, active: false });
    report();
  }

  function onRemoteBuffering(msg) {
    if (msg.active) {
      session.remoteBuffering.add(msg.clientId);
      holdPlayback();
    } else {
      session.remoteBuffering.delete(msg.clientId);
      resumeIfClear();
    }
    report();
  }

  // ---- Shared hold/resume -----------------------------------------------------------

  function hasRemoteHolds() {
    return session.remoteAds.size > 0 || session.remoteBuffering.size > 0;
  }

  function holdPlayback() {
    drift.reset();
    const video = player.video;
    // During our own ad the element may be the ad itself; onAdChange re-holds when it ends.
    if (!video || player.adActive || video.paused) return;
    session.autoPaused = true;
    applyRemote(() => player.pause());
  }

  function resumeIfClear() {
    if (!session.autoPaused || player.adActive || hasRemoteHolds()) return;
    session.autoPaused = false;
    log("bekleme bitti, devam ediliyor");
    applyRemote(() => player.play());
  }

  // ---- Content identity ----------------------------------------------------------

  function readContentId() {
    let href = location.href;
    try {
      href = window.top.location.href;
    } catch {
      // Cross-origin player frame: fall back to its own URL.
    }
    const { pathname } = new URL(href);
    return pathname.match(/\/detail\/([^/]+)/)?.[1] ?? pathname;
  }

  // The URL alone doesn't change between episodes of a season, so duration is part of the identity.
  function checkContent(force = false) {
    if (!player.video) return;
    const duration = Number.isFinite(player.contentDuration) ? Math.round(player.contentDuration) : 0;
    const next = { contentId: readContentId(), duration };
    const changed =
      !localContent ||
      next.contentId !== localContent.contentId ||
      Math.abs(next.duration - localContent.duration) > DURATION_TOLERANCE_S;
    if (changed) {
      localContent = next;
      log("içerik:", next);
    }
    if ((changed || force) && session.joined) {
      transport.send({ type: "contentChanged", clientId, ...localContent });
    }
    if (changed) report();
  }

  function onRemoteContent(msg) {
    session.peerContent.set(msg.clientId, { contentId: msg.contentId, duration: msg.duration });
    if (!sameContent(msg, localContent)) log("diğer taraf başka bir bölüme geçti", msg);
    report();
  }

  function sameContent(a, b) {
    if (!a || !b) return true;
    if (a.contentId !== b.contentId) return false;
    return !a.duration || !b.duration || Math.abs(a.duration - b.duration) <= DURATION_TOLERANCE_S;
  }

  function contentMatches(peerId) {
    return sameContent(session.peerContent.get(peerId), localContent);
  }

  // ---- Status -----------------------------------------------------------------------

  function report() {
    if (stopped) return;
    const status = {
      roomId,
      hasVideo: !!player.video,
      connection: transport ? transport.status : "idle",
      detail: transport?.detail ?? null,
      peers: session.peers,
      isHost: session.isHost,
      driftMs: currentDriftMs(),
      rttMs: clock.rtt === null ? null : Math.round(clock.rtt),
      warnings: collectWarnings(),
    };
    overlay.update(status);

    if (!status.hasVideo && !transport && !reported) return;
    const key = JSON.stringify(status);
    if (key === lastReportKey) return;
    lastReportKey = key;
    reported = true;
    sendToBackground({ type: "status", status });
  }

  function currentDriftMs() {
    const { peerDrift, isHost, hostId, joined } = session;
    if (!joined) return null;
    let diff;
    if (!isHost) {
      diff = peerDrift.get(hostId);
    } else {
      for (const d of peerDrift.values()) {
        if (diff === undefined || Math.abs(d) > Math.abs(diff)) diff = d;
      }
    }
    return diff === undefined ? null : Math.round(diff * 1000);
  }

  function collectWarnings() {
    const warnings = [];
    if (!session.joined) return warnings;
    if ([...session.peerContent.values()].some((c) => !sameContent(c, localContent))) {
      warnings.push("Diğer taraf başka bir bölüm izliyor");
    }
    if (player.adActive) warnings.push("Reklam oynuyor");
    if (session.remoteAds.size) warnings.push("Diğer tarafta reklam var, bekleniyor");
    if (session.bufferingReported) warnings.push("Yükleniyor, diğerleri bekliyor");
    if (session.remoteBuffering.size) warnings.push("Diğer taraf yükleniyor, bekleniyor");
    return warnings;
  }

  // Logs why no video was picked, but only when the picture changes.
  function logVideoSearch() {
    if (player.video) {
      lastSearchKey = null;
      return;
    }
    const videos = player.describeVideos();
    const key = JSON.stringify(videos.map(({ duration, size, verdict, inShadow }) => [duration, size, verdict, inShadow]));
    if (key === lastSearchKey) return;
    lastSearchKey = key;
    if (videos.length === 0) log("sayfada <video> yok");
    else log(`uygun video yok, ${videos.length} aday:`, videos);
  }

  // Per-frame snapshot for the popup's debug panel.
  function sendDiagnostics() {
    const videos = player.describeVideos();
    if (PCP.frameLabel !== "top" && videos.length === 0 && !transport) return;
    const diag = {
      frame: PCP.frameLabel,
      url: location.href.slice(0, 200),
      roomId,
      serverUrl: settings.serverUrl,
      connection: transport?.status ?? "idle",
      detail: transport?.detail ?? null,
      hasVideo: Boolean(player.video),
      videos,
      logs: PCP.logs.slice(-25),
    };
    const key = JSON.stringify(diag);
    if (key === lastDiagKey) return;
    lastDiagKey = key;
    sendToBackground({ type: "diag", diag });
  }

  function sendToBackground(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script must stop touching the page.
      shutdown();
    }
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    for (const id of intervals) clearInterval(id);
    transport?.close();
    transport = null;
    endSession();
    player.stop();
    overlay.setEnabled(false);
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // Context already invalidated.
    }
    if (PCP.shutdown === shutdown) PCP.shutdown = null;
    console.log("[PrimeCatParty] eski içerik betiği kapatıldı");
  }
})();
