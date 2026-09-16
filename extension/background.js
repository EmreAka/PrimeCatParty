// Holds the per-tab room assignment and mirrors connection status into the badge.
// The WebSocket itself lives in the content script: MV3 service workers die when idle.

const PRIME_ORIGIN = "https://www.primevideo.com/";
const ROOM_ID = /^[a-z0-9]{8}$/;

const BADGE_COLORS = {
  connected: "#2e7d32",
  connecting: "#f9a825",
  reconnecting: "#f9a825",
  disconnected: "#c62828",
  error: "#c62828",
};

const roomKey = (tabId) => `room:${tabId}`;
const statusKey = (tabId) => `status:${tabId}`;
const diagPrefix = (tabId) => `diag:${tabId}:`;

// Chrome doesn't inject content scripts into tabs that were open before install/reload.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  const [script] = chrome.runtime.getManifest().content_scripts;
  const tabs = await chrome.tabs.query({ url: script.matches });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: script.js })
      .then(() => console.log(`[PrimeCatParty] içerik betiği açık sekmeye eklendi: ${tab.id}`))
      .catch((err) => console.warn(`[PrimeCatParty] sekmeye eklenemedi: ${tab.id}`, err));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;
  switch (message?.type) {
    case "getRoom":
      if (senderTabId === undefined) return false;
      getRoom(senderTabId).then((roomId) => sendResponse({ roomId }));
      return true;
    case "setRoom":
      console.log(`[PrimeCatParty] sekme ${message.tabId} oda: ${message.roomId ?? "yok"}`);
      setRoom(message.tabId, message.roomId ?? null).then(() => sendResponse({ ok: true }));
      return true;
    case "status":
      if (senderTabId !== undefined) updateStatus(senderTabId, message.status);
      return false;
    case "diag":
      if (senderTabId !== undefined) updateDiagnostics(senderTabId, sender.frameId ?? 0, message.diag);
      return false;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove([roomKey(tabId), statusKey(tabId), ...(await diagKeys(tabId))]);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url || changeInfo.url.startsWith(PRIME_ORIGIN)) return;
  if (await getRoom(tabId)) await setRoom(tabId, null);
});

async function getRoom(tabId) {
  const key = roomKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] ?? null;
}

async function setRoom(tabId, roomId) {
  if (typeof tabId !== "number") return;
  if (roomId !== null && !ROOM_ID.test(roomId)) return;
  if (roomId) {
    await chrome.storage.session.set({ [roomKey(tabId)]: roomId });
  } else {
    await chrome.storage.session.remove([roomKey(tabId), statusKey(tabId)]);
  }
  await updateBadge(tabId, null);
  chrome.tabs
    .sendMessage(tabId, { type: "roomChanged", roomId })
    .catch((err) => console.warn(`[PrimeCatParty] sekmeye oda iletilemedi (içerik betiği yok mu?): ${err.message}`));
}

async function updateStatus(tabId, status) {
  if (status) {
    await chrome.storage.session.set({ [statusKey(tabId)]: status });
  } else {
    await chrome.storage.session.remove(statusKey(tabId));
  }
  await updateBadge(tabId, status);
}

async function updateDiagnostics(tabId, frameId, diag) {
  const key = `${diagPrefix(tabId)}${frameId}`;
  if (diag) await chrome.storage.session.set({ [key]: { ...diag, frameId } });
  else await chrome.storage.session.remove(key);
}

async function diagKeys(tabId) {
  const prefix = diagPrefix(tabId);
  return Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith(prefix));
}

function badgeText(status) {
  switch (status?.roomId ? status.connection : null) {
    case "connected":
      return String(status.peers);
    case "connecting":
    case "reconnecting":
      return "…";
    case "disconnected":
    case "error":
      return "!";
    default:
      return "";
  }
}

async function updateBadge(tabId, status) {
  const text = badgeText(status);
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[status.connection] });
  } catch {
    // Tab closed in the meantime.
  }
}
