import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Rooms, broadcast, CLOSE_INVALID, CLOSE_FULL, MAX_CLIENTS } from "./rooms.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
// LOG_LEVEL=debug also logs heartbeats and pings.
const DEBUG = process.env.LOG_LEVEL === "debug";
const LIVENESS_INTERVAL_MS = 30000;

const RELAYED_TYPES = new Set(["control", "heartbeat", "adBreak", "buffering", "contentChanged"]);
const CLOSE_REASONS = { [CLOSE_INVALID]: "geçersiz oda/istemci", [CLOSE_FULL]: `oda dolu (${MAX_CLIENTS})` };

// Monotonic clock: an NTP step during a ping exchange would corrupt client offsets with Date.now().
// Absolute accuracy is irrelevant, only consistency over the process lifetime.
const now = () => Number(process.hrtime.bigint() / 1000000n);

const rooms = new Rooms();
const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: 16 * 1024 });
let nextConnectionId = 1;

const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

function log(...args) {
  const time = new Date().toLocaleTimeString("tr-TR", { hour12: false });
  console.log(`[${time}]`, ...args);
}

const MAX_NAME_LENGTH = 32;
const MAX_CHAT_LENGTH = 300;
// Kept per room so a late joiner or a reconnect sees the recent conversation.
const CHAT_HISTORY = 30;
// Token bucket per connection: a burst of CHAT_BURST, then one message per CHAT_REFILL_MS.
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1000;
const CHAT_ID = /^[\w-]{1,64}$/;

// "#3 emre (1a2b3c4d)" — connection number, display name, start of the client id.
function who(ws) {
  if (!ws.clientId) return `#${ws.connectionId}`;
  return `#${ws.connectionId} ${ws.name || "isimsiz"} (${ws.clientId.slice(0, 8)})`;
}

const cleanName = (name) => (typeof name === "string" ? name.trim().slice(0, MAX_NAME_LENGTH) : "");

function takeChatToken(ws) {
  const t = now();
  ws.chatTokens = Math.min(CHAT_BURST, (ws.chatTokens ?? CHAT_BURST) + (t - (ws.chatRefilledAt ?? t)) / CHAT_REFILL_MS);
  ws.chatRefilledAt = t;
  if (ws.chatTokens < 1) return false;
  ws.chatTokens -= 1;
  return true;
}

// Name and time come from the server so nobody can speak as someone else. The id is the
// sender's, so its own copy (shown right away) and the history replay deduplicate.
function onChat(ws, room, msg) {
  const text = typeof msg.text === "string" ? msg.text.trim().slice(0, MAX_CHAT_LENGTH) : "";
  if (!text) return;
  const id = typeof msg.id === "string" && CHAT_ID.test(msg.id) ? msg.id : randomUUID();
  if (!takeChatToken(ws)) {
    log(`${who(ws)} çok hızlı yazıyor, sohbet mesajı atlandı`);
    return send(ws, { type: "chatRejected", id, reason: "rate" });
  }
  const chat = { type: "chat", id, clientId: ws.clientId, name: ws.name, text, at: Date.now() };
  room.chat.push(chat);
  if (room.chat.length > CHAT_HISTORY) room.chat.shift();
  // Only the length is logged; the conversation itself stays out of the server logs.
  log(`${who(ws)} → ${ws.roomId}: sohbet (${text.length} karakter) (${room.clients.size - 1} kişiye)`);
  broadcast(room, JSON.stringify(chat), ws);
}

const membersOf = (room) => [...room.clients].map((ws) => ({ clientId: ws.clientId, name: ws.name }));

function describeRoom(roomId, room) {
  const members = [...room.clients].map((ws) => (room.host === ws ? `${who(ws)} (host)` : who(ws)));
  return `oda ${roomId} [${room.clients.size}/${MAX_CLIENTS}]: ${members.join(", ")}`;
}

function logSummary() {
  log(`özet: ${wss.clients.size} bağlantı, ${rooms.size} oda`);
  for (const [roomId, room] of rooms.entries()) log(`  ${describeRoom(roomId, room)}`);
}

function describeMessage(msg) {
  const pos = typeof msg.position === "number" ? ` @ ${msg.position.toFixed(2)} sn` : "";
  switch (msg.type) {
    case "control":
      return `control ${msg.action}${pos}${msg.playing === undefined ? "" : msg.playing ? " (oynuyor)" : " (duraklatıldı)"}`;
    case "heartbeat":
      return `heartbeat${pos} ${msg.playing ? "oynuyor" : "duraklatıldı"}${msg.fromHost ? " (host)" : ""}`;
    case "adBreak":
      return `reklam ${msg.active ? "başladı" : "bitti"}`;
    case "buffering":
      return `buffer ${msg.active ? "boşaldı" : "doldu"}`;
    case "contentChanged":
      return `içerik ${msg.contentId} (${msg.duration} sn)`;
    default:
      return msg.type;
  }
}

wss.on("connection", (ws, req) => {
  ws.connectionId = nextConnectionId++;
  ws.isAlive = true;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress;
  log(`${who(ws)} bağlandı (${ip}), toplam ${wss.clients.size} bağlantı`);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log(`${who(ws)} bozuk JSON gönderdi`);
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ping") {
      if (DEBUG) log(`${who(ws)} ping`);
      return send(ws, { type: "pong", t0: msg.t0, t1: now() });
    }

    if (msg.type === "join") {
      if (ws.roomId) {
        log(`${who(ws)} zaten ${ws.roomId} odasında, ikinci join yok sayıldı`);
        return;
      }
      if (typeof msg.clientId !== "string" || msg.clientId.length === 0 || msg.clientId.length > 64) {
        log(`${who(ws)} reddedildi: geçersiz clientId`);
        return ws.close(CLOSE_INVALID);
      }
      const { room, created, error } = rooms.join(ws, msg.roomId);
      if (error) {
        log(`${who(ws)} ${JSON.stringify(msg.roomId)} odasına giremedi: ${CLOSE_REASONS[error]}`);
        return ws.close(error);
      }
      ws.roomId = msg.roomId;
      ws.clientId = msg.clientId;
      ws.name = cleanName(msg.name);
      const isHost = room.host === ws;
      if (created) log(`oda oluşturuldu: ${ws.roomId}`);
      log(`${who(ws)} ${ws.roomId} odasına katıldı${isHost ? " (host)" : ""}${room.state ? ", oda durumu gönderildi" : ""}`);
      log(`  ${describeRoom(ws.roomId, room)}`);
      send(ws, {
        type: "joined",
        isHost,
        hostId: room.host.clientId,
        peers: room.clients.size,
        members: membersOf(room),
        state: room.state,
        chat: room.chat,
        t1: now(),
      });
      broadcast(
        room,
        JSON.stringify({
          type: "peerJoined",
          clientId: ws.clientId,
          name: ws.name,
          peers: room.clients.size,
          hostId: room.host.clientId,
          members: membersOf(room),
        }),
        ws,
      );
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) {
      log(`${who(ws)} odaya girmeden ${msg.type} gönderdi, yok sayıldı`);
      return;
    }

    if (msg.type === "rename") {
      const previous = ws.name || "isimsiz";
      ws.name = cleanName(msg.name);
      log(`#${ws.connectionId} ismini değiştirdi: ${previous} → ${ws.name || "isimsiz"}`);
      broadcast(room, JSON.stringify({ type: "members", members: membersOf(room), hostId: room.host.clientId }));
      return;
    }
    if (msg.type === "chat") return onChat(ws, room, msg);
    if (!RELAYED_TYPES.has(msg.type)) {
      log(`${who(ws)} bilinmeyen mesaj: ${msg.type}`);
      return;
    }
    if (msg.type !== "heartbeat" || DEBUG) {
      log(`${who(ws)} → ${ws.roomId}: ${describeMessage(msg)} (${room.clients.size - 1} kişiye)`);
    }
    // Keep the latest state so a late joiner can sync in one step. Only the host's heartbeats count.
    if (msg.type === "control" || (msg.type === "heartbeat" && room.host === ws)) room.state = msg;
    broadcast(room, raw.toString(), ws);
  });

  ws.on("close", (code) => {
    const reason = CLOSE_REASONS[code] ? `, ${CLOSE_REASONS[code]}` : "";
    const left = rooms.leave(ws);
    log(`${who(ws)} ayrıldı (kod ${code}${reason}), toplam ${wss.clients.size} bağlantı`);
    if (!left) return;
    const { room, deleted, hostChanged } = left;
    if (deleted) {
      log(`oda kapandı: ${ws.roomId} (boş kaldı), toplam ${rooms.size} oda`);
      return;
    }
    if (hostChanged) log(`${ws.roomId} odasının yeni host'u: ${who(room.host)}`);
    log(`  ${describeRoom(ws.roomId, room)}`);
    broadcast(
      room,
      JSON.stringify({
        type: "peerLeft",
        clientId: ws.clientId,
        name: ws.name,
        peers: room.clients.size,
        hostId: room.host.clientId,
        members: membersOf(room),
      }),
    );
  });
});

const liveness = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      log(`${who(ws)} ping'e yanıt vermedi, bağlantı kesiliyor`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  if (wss.clients.size > 0) logSummary();
}, LIVENESS_INTERVAL_MS);

wss.on("close", () => clearInterval(liveness));
wss.on("listening", () => log(`PrimeCatParty sync sunucusu ws://${HOST}:${PORT} adresinde dinliyor${DEBUG ? " (debug)" : ""}`));
