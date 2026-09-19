const DEFAULT_SETTINGS = { serverUrl: "ws://localhost:8080", overlay: true, notifications: true, chat: true, displayName: "" };
const PRIME_URL = /^https:\/\/www\.primevideo\.com\//;
const ROOM_ID = /^[a-z0-9]{8}$/;

const CONNECTION_LABELS = {
  idle: "Video bekleniyor",
  connecting: "Bağlanıyor",
  connected: "Bağlı",
  reconnecting: "Yeniden bağlanıyor",
  disconnected: "Kopuk",
  error: "Kopuk",
};

const DIAG_STALE_MS = 25000;
const RERENDER_MS = 5000;

const $ = (id) => document.getElementById(id);

let tabId = null;
let roomId = null;
let debugSnapshot = null;

init();

async function init() {
  await initSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !PRIME_URL.test(tab.url)) {
    $("not-prime").hidden = false;
    return;
  }
  tabId = tab.id;
  $("debug").hidden = false;
  bindActions();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    const relevant = Object.keys(changes).some(
      (key) => key === `room:${tabId}` || key === `status:${tabId}` || key.startsWith(`diag:${tabId}:`),
    );
    if (relevant) render();
  });
  // Re-render periodically so records age out even when storage is quiet.
  setInterval(render, RERENDER_MS);
  await render();
}

async function render() {
  const all = await chrome.storage.session.get(null);
  roomId = all[`room:${tabId}`] ?? null;
  const records = Object.entries(all)
    .filter(([key]) => key.startsWith(`diag:${tabId}:`))
    .map(([, value]) => value)
    .sort((a, b) => a.frameId - b.frameId);
  // Live frames resend every 10 s; anything quieter belongs to a page that is gone.
  const frames = records.filter((frame) => Date.now() - (frame.updatedAt ?? 0) < DIAG_STALE_MS);
  const staleFrames = records.length - frames.length;
  const rawStatus = all[`status:${tabId}`] ?? null;
  debugSnapshot = { tabId, roomId, status: rawStatus, frames, staleFrames };

  renderDebug(frames, staleFrames, rawStatus);

  $("lobby").hidden = Boolean(roomId);
  $("room").hidden = !roomId;
  if (!roomId) return;

  const status = rawStatus?.roomId === roomId ? rawStatus : null;
  const connection = status?.connection ?? "idle";
  const connected = connection === "connected";

  let label = (CONNECTION_LABELS[connection] ?? connection) + (status?.detail ? ` (${status.detail})` : "");
  let state = connection;
  if (!status && frames.length === 0) {
    label = "Sayfa betiği çalışmıyor, sekmeyi yenile";
    state = "error";
  }

  $("room-code").textContent = roomId;
  $("connection").dataset.state = state;
  $("connection-label").textContent = label;
  const names = status?.members?.length ? ` · ${status.members.join(", ")}` : "";
  $("peers").textContent = connected ? `${status.peers}${names}` : "–";
  $("role").textContent = connected ? (status.isHost ? "Host" : "Misafir") : "–";
  $("drift").textContent =
    connected && status.driftMs !== null ? `${status.driftMs > 0 ? "+" : ""}${status.driftMs} ms` : "–";
  $("warnings").replaceChildren(...(status?.warnings ?? []).map((text) => element("li", text)));
}

function renderDebug(frames, staleFrames, status) {
  const staleNote = staleFrames ? [element("p", `${staleFrames} eski sayfa kaydı gizlendi.`, "muted")] : [];
  if (frames.length === 0) {
    // The status channel works independently, so fall back to what it carries.
    if (status?.logs?.length) {
      const container = element("div", null, "frame");
      container.append(
        element("strong", "Durum kaydından"),
        ` · heartbeat: ${status.heartbeat ?? "–"} · karşıdan: ${
          status.peerHeartbeatAgeS === null || status.peerHeartbeatAgeS === undefined
            ? "hiç gelmedi"
            : `${status.peerHeartbeatAgeS} sn önce`
        }`,
      );
      if (status.lastError) container.append(element("div", `Son hata: ${status.lastError}`, "error"));
      container.append(element("pre", status.logs.join("\n")));
      $("debug-frames").replaceChildren(
        element("p", "Çerçeve kaydı gelmedi, durum kaydındaki bilgiler gösteriliyor.", "muted"),
        ...staleNote,
        container,
      );
      return;
    }
    $("debug-frames").replaceChildren(
      element("p", "Hiçbir çerçeveden bilgi gelmedi: içerik betiği bu sekmede çalışmıyor. Sekmeyi yenile.", "muted"),
      ...staleNote,
    );
    return;
  }
  $("debug-frames").replaceChildren(
    ...staleNote,
    ...frames.map((frame) => {
      const container = element("div", null, "frame");
      const connection = frame.connection + (frame.detail ? ` (${frame.detail})` : "");
      container.append(
        element("strong", `${frame.frame} #${frame.frameId}`),
        ` · oda: ${frame.roomId ?? "yok"} · ${connection}`,
        element("div", frame.url, "muted url"),
      );
      const videos = element("ul");
      if (frame.videos.length === 0) videos.append(element("li", "<video> yok"));
      for (const video of frame.videos) {
        const where = video.inShadow ? " · shadow" : "";
        videos.append(
          element("li", `${video.size} · ${video.duration} sn · rs${video.readyState}${where} → ${video.verdict}`),
        );
      }
      container.append(videos, element("pre", frame.logs.join("\n")));
      return container;
    }),
  );
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== null && text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function bindActions() {
  $("create").addEventListener("click", () => setRoom(crypto.randomUUID().slice(0, 8)));

  $("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("join-code").value.trim().toLowerCase();
    const valid = ROOM_ID.test(code);
    $("join-error").hidden = valid;
    if (valid) setRoom(code);
  });

  $("copy").addEventListener("click", () => copyWithFeedback($("copy"), roomId, "Kopyala"));
  $("debug-copy").addEventListener("click", () =>
    copyWithFeedback($("debug-copy"), JSON.stringify(debugSnapshot, null, 2), "Bilgiyi kopyala"),
  );

  $("leave").addEventListener("click", () => setRoom(null));
}

async function copyWithFeedback(button, text, label) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  button.textContent = "Kopyalandı";
  setTimeout(() => (button.textContent = label), 1500);
}

function setRoom(next) {
  return chrome.runtime.sendMessage({ type: "setRoom", tabId, roomId: next });
}

async function initSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const serverInput = $("server-url");
  const overlayInput = $("overlay");
  const notificationsInput = $("notifications");
  const chatInput = $("chat");
  const nameInput = $("display-name");
  serverInput.value = settings.serverUrl;
  overlayInput.checked = settings.overlay;
  notificationsInput.checked = settings.notifications;
  chatInput.checked = settings.chat;
  nameInput.value = settings.displayName;

  let nameTimer = null;
  const saveName = () => {
    clearTimeout(nameTimer);
    chrome.storage.local.set({ displayName: nameInput.value.trim() });
  };
  nameInput.addEventListener("input", () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(saveName, 500);
  });
  nameInput.addEventListener("change", saveName);
  notificationsInput.addEventListener("change", () =>
    chrome.storage.local.set({ notifications: notificationsInput.checked }),
  );

  serverInput.addEventListener("change", () => {
    const value = serverInput.value.trim();
    const valid = isWebSocketUrl(value);
    serverInput.setCustomValidity(valid ? "" : "ws:// veya wss:// ile başlamalı");
    if (valid) chrome.storage.local.set({ serverUrl: value });
  });
  overlayInput.addEventListener("change", () => chrome.storage.local.set({ overlay: overlayInput.checked }));
  chatInput.addEventListener("change", () => chrome.storage.local.set({ chat: chatInput.checked }));
}

function isWebSocketUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
