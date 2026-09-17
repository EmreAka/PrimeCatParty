(() => {
  const PCP = globalThis.PCP;
  if (!PCP) return;
  // Re-injection after an extension reload can share a world with the orphaned copy; retire it first.
  PCP.shutdown?.();
  PCP.shutdown = shutdown;

  const { Transport, ClockSync, DriftController, Player, Overlay, expectedPosition, log } = PCP;

  const DEFAULT_SETTINGS = { serverUrl: "ws://localhost:8080", overlay: true, notifications: true, displayName: "" };
  // Time window, not a flag: `seeked` can arrive 200-300 ms after a remote seek is applied.
  const SUPPRESS_MS = 400;
  // After we play/pause on someone's behalf, Prime may revert it. Within this window, play/pause
  // events are ours (never broadcast) and a revert is re-applied.
  const PLAY_INTENT_MS = 2500;
  const PLAY_VERIFY_MS = 700;
  const MAX_PLAY_ATTEMPTS = 3;
  const STATE_FIX_GAP_MS = 5000;
  const HEARTBEAT_MS = 3000;
  // Local events are grouped until the player is quiet this long (also lets ad transitions be detected first).
  const LOCAL_SETTLE_MS = 400;
  const LOCAL_BURST_TICK_MS = 100;
  const SEEK_RESUME_WAIT_MS = 2500;
  // A remote seek suppresses local events until `seeked` (at most MAX), plus a tail for Prime's resume.
  const REMOTE_SEEK_MAX_MS = 4000;
  const REMOTE_SEEK_TAIL_MS = 1000;
  const AD_EXIT_GRACE_MS = 1500;
  const CONTROL_GRACE_MS = 1500;
  const VIDEO_LOST_GRACE_MS = 15000;
  const BUFFER_REPORT_DELAY_MS = 500;
  const CONTENT_CHECK_MS = 1000;
  const LOCAL_CONTROL_EVENTS = new Set(["play", "pause", "seeking", "seeked", "ratechange"]);

  const clientId = crypto.randomUUID();
  let settings = { ...DEFAULT_SETTINGS };
  let roomId = null;
  let transport = null;
  let session = newSession();
  let suppressUntil = 0;
  let playIntent = null; // { playing, until, attempts }
  let remoteSeekUntil = 0;
  let localBurst = null;
  let adEndedAt = -Infinity;
  let localContent = null;
  let lostTimer = null;
  let bufferTimer = null;
  let reported = false;
  let lastReportKey = null;
  let lastDiagKey = null;
  let lastDiagSentAt = -Infinity;
  const DIAG_REFRESH_MS = 10000;
  const documentId = crypto.randomUUID();
  let lastSearchKey = null;
  let stopped = false;
  const intervals = [];

  const player = new Player({ onEvent: onPlayerEvent, onVideoChange, onAdChange });
  const clock = new ClockSync((t0) => transport?.send({ type: "ping", t0 }) ?? false);
  const drift = new DriftController({
    player,
    clock,
    canCorrect: () => canFollowHost() && !player.video.paused,
    hardSeek: (position) => seekFromRemote(position),
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
      members: new Map(), // clientId -> name
      lastStateFix: -Infinity,
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
    if (changes.notifications) {
      settings.notifications = changes.notifications.newValue ?? DEFAULT_SETTINGS.notifications;
    }
    if (changes.displayName) {
      settings.displayName = changes.displayName.newValue ?? "";
      log(`isim: ${myName()}`);
      if (session.joined) transport.send({ type: "rename", name: myName() });
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
    cancelLocalBurst();
    session = newSession();
  }

  function onTransportStatus(status, detail) {
    log(`bağlantı: ${status}${detail ? ` (${detail})` : ""}`);
    if (status !== "connected") endSession();
    report();
  }

  function onOpen() {
    endSession();
    transport.send({ type: "join", roomId, clientId, name: myName() });
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
      case "members":
        updateMembers(msg.members);
        return report();
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
    updateMembers(msg.members);
    clock.seed(msg.t1);
    log(`odaya katılındı: ${msg.peers} kişi, ${msg.isHost ? "host" : "misafir"}`);
    const others = [...session.members].filter(([id]) => id !== clientId).map(([, name]) => name);
    notify(others.length ? `Odaya katıldın · ${others.join(", ")} burada` : "Oda hazır, arkadaşını bekliyorsun");
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
    updateMembers(msg.members);
    const name = nameOf(msg.clientId, msg.name);
    log(`katılımcı geldi: ${name} (${msg.peers} kişi)`);
    notify(`${name} odaya katıldı`);
    checkContent(true);
    announceLocalHolds();
    report();
  }

  function onPeerLeft(msg) {
    const name = nameOf(msg.clientId, msg.name);
    session.peers = msg.peers;
    session.hostId = msg.hostId ?? session.hostId;
    updateMembers(msg.members);
    const wasHost = session.isHost;
    session.isHost = session.hostId === clientId;
    for (const collection of [session.remoteAds, session.remoteBuffering, session.peerContent, session.peerDrift]) {
      collection.delete(msg.clientId);
    }
    log(`katılımcı ayrıldı: ${name} (${msg.peers} kişi)`);
    notify(`${name} ayrıldı`);
    if (session.isHost && !wasHost) {
      log("host artık bu sekme");
      drift.reset();
    }
    resumeIfClear();
    report();
  }

  function updateMembers(members) {
    if (!Array.isArray(members)) return;
    session.members = new Map(members.map((m) => [m.clientId, m.name || "İsimsiz"]));
  }

  function nameOf(id, fallback) {
    return session.members.get(id) || fallback || "Biri";
  }

  function myName() {
    return settings.displayName.trim().slice(0, 32);
  }

  function notify(text) {
    if (settings.notifications) overlay.notify(text);
    else log(`bildirim (kapalı): ${text}`);
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // Tell newcomers about ad/buffer pauses they would otherwise never hear about.
  function announceLocalHolds() {
    if (player.adActive) transport?.send({ type: "adBreak", clientId, name: myName(), active: true });
    if (session.bufferingReported) transport?.send({ type: "buffering", clientId, active: true });
  }

  // ---- Echo suppression & applying remote state --------------------------------

  function applyRemote(fn) {
    suppressUntil = performance.now() + SUPPRESS_MS;
    fn();
  }

  function onRemoteControl(msg) {
    const name = nameOf(msg.clientId, msg.name);
    log(`uzak ${msg.action} (${name}) @ ${Number(msg.position).toFixed(2)}`);
    const text = {
      play: `${name} devam ettirdi`,
      pause: `${name} durdurdu`,
      seek: `${name} ${formatTime(msg.position)} konumuna sardı`,
      rate: `${name} hızı ${msg.rate}x yaptı`,
    }[msg.action];
    if (text) notify(text);
    if (!contentMatches(msg.clientId)) {
      log("farklı içerik, komut yok sayıldı");
      return;
    }
    applyControl(msg, `${name} ${msg.action}`);
  }

  function applyControl(state, reason = "uzak komut") {
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
    if (state.rate > 0) applyRemote(() => player.setBaseRate(state.rate));
    const threshold = state.action === "seek" ? 0.05 : 0.5;
    if (Math.abs(video.currentTime - target) > threshold) {
      log(`${reason}: ${video.currentTime.toFixed(2)} → ${target.toFixed(2)} konumuna sarılıyor`);
      seekFromRemote(target);
    }
    session.autoPaused = hold;
    setPlaying(state.playing && !hold, reason);
  }

  // Drives Prime into the wanted play state and keeps it there for PLAY_INTENT_MS.
  function setPlaying(playing, reason) {
    const video = player.video;
    if (!video) return;
    if (video.paused !== playing) {
      // Already there; drop an older opposite intent so it doesn't fight this state.
      if (playIntent && playIntent.playing !== playing) playIntent = null;
      return;
    }
    playIntent = { playing, until: performance.now() + PLAY_INTENT_MS, attempts: 0 };
    attemptPlaying(reason);
  }

  function attemptPlaying(reason) {
    const intent = playIntent;
    const video = player.video;
    if (!intent || !video || performance.now() > intent.until) return;
    const wanted = intent.playing ? "oynat" : "durdur";
    if (video.paused !== intent.playing) {
      if (intent.attempts > 0 && !intent.confirmed) log(`${wanted} tuttu (${intent.attempts}. denemede)`);
      intent.confirmed = true;
      return;
    }
    intent.confirmed = false;
    if (intent.attempts >= MAX_PLAY_ATTEMPTS) {
      log(`player "${wanted}" komutunu ${MAX_PLAY_ATTEMPTS} denemede uygulamadı, vazgeçildi`);
      return;
    }
    // Alternate between Prime's button and the element API in case one of them is ignored.
    const preferred = intent.attempts % 2 === 0 ? "button" : "element";
    intent.attempts += 1;
    let method;
    applyRemote(() => {
      method = player.setPlaying(intent.playing, preferred);
    });
    log(`${reason}: ${wanted} (${method === "button" ? "Prime butonu" : "video elementi"}, deneme ${intent.attempts})`);
    setTimeout(() => {
      if (playIntent === intent) attemptPlaying("doğrulama");
    }, PLAY_VERIFY_MS);
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
      // Rate-limited so a player that keeps reverting can't cause a seek-back loop.
      if (performance.now() - session.lastStateFix < STATE_FIX_GAP_MS) return;
      session.lastStateFix = performance.now();
      log(`oynatma durumu host ile uyuşmuyor (host ${msg.playing ? "oynuyor" : "duraklatmış"}), düzeltiliyor`);
      applyControl(msg, "host durumu");
    } else if (msg.playing) {
      drift.update(msg);
    } else if (Math.abs(video.currentTime - msg.position) > 0.5) {
      if (performance.now() - session.lastStateFix < STATE_FIX_GAP_MS) return;
      session.lastStateFix = performance.now();
      applyControl(msg, "host konumu");
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
    if ((type === "play" || type === "pause") && playIntent && performance.now() < playIntent.until) {
      if (video.paused === playIntent.playing) {
        log(`player durumu geri aldı (${type}), yeniden uygulanıyor`);
        attemptPlaying("geri alındı");
      }
      return;
    }
    if (type === "play" && performance.now() - adEndedAt < AD_EXIT_GRACE_MS && hasRemoteHolds()) {
      return holdPlayback();
    }
    if (!LOCAL_CONTROL_EVENTS.has(type) || internal) return;
    const now = performance.now();
    // Prime wraps a seek in pause/play; while our remote seek settles, none of that is the user's doing.
    if (now < remoteSeekUntil) {
      if (type === "seeked") remoteSeekUntil = now + REMOTE_SEEK_TAIL_MS;
      return;
    }
    if (now < suppressUntil) return;
    if (player.adActive || now - adEndedAt < AD_EXIT_GRACE_MS) return;
    if (type === "ratechange") return sendLocalControl("rate", video);
    recordLocalEvent(type, video);
  }

  // A user seek on Prime fires pause → seeking → seeked → play. Collect such bursts and send one
  // control once the player settles: "seek" if the burst moved, otherwise play/pause if the state flipped.
  function recordLocalEvent(type, video) {
    const now = performance.now();
    if (!localBurst) {
      const startPlaying = type === "pause" ? true : type === "play" ? false : !video.paused;
      localBurst = {
        video,
        session,
        startPlaying,
        sawSeek: false,
        events: [],
        lastEventAt: now,
        timer: setInterval(checkLocalBurst, LOCAL_BURST_TICK_MS),
      };
    }
    localBurst.events.push(type);
    localBurst.lastEventAt = now;
    if (type === "seeking" || type === "seeked") localBurst.sawSeek = true;
    session.lastControlLocal = now;
    drift.reset();
  }

  function checkLocalBurst() {
    const burst = localBurst;
    if (!burst) return;
    const video = player.video;
    if (burst.session !== session || burst.video !== video) return cancelLocalBurst();
    if (video.seeking) return;
    const idle = performance.now() - burst.lastEventAt;
    if (idle < LOCAL_SETTLE_MS) return;
    // Seeking while playing: Prime resumes on its own once buffered, so wait for that play.
    if (burst.sawSeek && burst.startPlaying && video.paused && idle < SEEK_RESUME_WAIT_MS) return;

    cancelLocalBurst();
    const playing = !video.paused;
    let action = null;
    if (burst.sawSeek) action = "seek";
    else if (playing !== burst.startPlaying) action = playing ? "play" : "pause";
    log(`yerel olaylar [${burst.events.join(" → ")}] → ${action ?? "değişiklik yok, gönderilmedi"}`);
    if (action) sendLocalControl(action, video);
  }

  function cancelLocalBurst() {
    if (!localBurst) return;
    clearInterval(localBurst.timer);
    localBurst = null;
  }

  function sendLocalControl(action, video) {
    if (!session.joined || player.adActive || !clock.usable) return;
    if (performance.now() - adEndedAt < AD_EXIT_GRACE_MS) return;
    const control = {
      type: "control",
      action,
      clientId,
      name: myName(),
      position: video.currentTime,
      playing: !video.paused,
      rate: player.baseRate,
      at: clock.now(),
    };
    if (action !== "rate") session.autoPaused = false;
    session.lastControlAt = control.at;
    session.lastControlLocal = performance.now();
    drift.reset();
    log(`yerel ${action} gönderiliyor @ ${control.position.toFixed(2)} (${control.playing ? "oynuyor" : "duraklatılmış"})`);
    transport?.send(control);
    report();
  }

  function seekFromRemote(position) {
    remoteSeekUntil = performance.now() + REMOTE_SEEK_MAX_MS;
    applyRemote(() => player.seekTo(position));
    drift.markHardSeek();
  }

  // ---- Ads ----------------------------------------------------------------------

  function onAdChange(active) {
    if (!active) adEndedAt = performance.now();
    if (!session.joined) return report();
    transport.send({ type: "adBreak", clientId, name: myName(), active });
    drift.reset();
    if (!active) {
      if (hasRemoteHolds()) holdPlayback();
      else if (session.pendingControl) applyControl(session.pendingControl);
    }
    report();
  }

  function onRemoteAd(msg) {
    const name = nameOf(msg.clientId, msg.name);
    log(`uzak reklam ${msg.active ? "başladı" : "bitti"} (${name})`);
    notify(msg.active ? `${name} reklamda, bekleniyor` : `${name} reklamdan çıktı`);
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
    setPlaying(false, "bekletme");
  }

  function resumeIfClear() {
    if (!session.autoPaused || player.adActive || hasRemoteHolds()) return;
    session.autoPaused = false;
    log("bekleme bitti, devam ediliyor");
    setPlaying(true, "bekleme bitti");
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

  // Identity is the URL's content id only. Duration can't be used: Prime stitches ads into the
  // stream, so the same title reports different durations per viewer (seen: 4888 vs 4905 s).
  // Duration is still sent, for logs only.
  function checkContent(force = false) {
    if (!player.video) return;
    const duration = Number.isFinite(player.contentDuration) ? Math.round(player.contentDuration) : 0;
    const next = { contentId: readContentId(), duration };
    const changed = !localContent || next.contentId !== localContent.contentId;
    localContent = next;
    if (changed) log("içerik:", next);
    if ((changed || force) && session.joined) {
      transport.send({ type: "contentChanged", clientId, name: myName(), ...localContent });
    }
    if (changed) report();
  }

  function onRemoteContent(msg) {
    const previous = session.peerContent.get(msg.clientId);
    const next = { contentId: msg.contentId, duration: msg.duration };
    session.peerContent.set(msg.clientId, next);
    const changed = !previous || previous.contentId !== next.contentId;
    if (changed && !sameContent(next, localContent)) {
      const name = nameOf(msg.clientId, msg.name);
      log(`${name} başka bir bölümde`, msg);
      notify(`${name} başka bir bölüm izliyor`);
    }
    report();
  }

  function sameContent(a, b) {
    if (!a || !b) return true;
    return a.contentId === b.contentId;
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
      members: [...session.members].map(([id, name]) => (id === clientId ? `${name} (sen)` : name)),
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
      name: myName(),
      playPauseButton: Boolean(player.video && player.findPlayPauseButton()),
      videos,
      logs: PCP.logs.slice(-25),
    };
    const key = JSON.stringify(diag);
    // Resend unchanged snapshots now and then: the popup treats silent frames as stale.
    if (key === lastDiagKey && performance.now() - lastDiagSentAt < DIAG_REFRESH_MS) return;
    lastDiagKey = key;
    lastDiagSentAt = performance.now();
    sendToBackground({ type: "diag", diag: { ...diag, documentId } });
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
