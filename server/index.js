import { WebSocketServer, WebSocket } from "ws";
import { Rooms, broadcast, CLOSE_INVALID } from "./rooms.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const LIVENESS_INTERVAL_MS = 30000;

const RELAYED_TYPES = new Set(["control", "heartbeat", "adBreak", "buffering", "contentChanged"]);

// Monotonic clock: an NTP step during a ping exchange would corrupt client offsets with Date.now().
// Absolute accuracy is irrelevant, only consistency over the process lifetime.
const now = () => Number(process.hrtime.bigint() / 1000000n);

const rooms = new Rooms();
const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: 16 * 1024 });

const send = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ping") {
      return send(ws, { type: "pong", t0: msg.t0, t1: now() });
    }

    if (msg.type === "join") {
      if (ws.roomId) return;
      if (typeof msg.clientId !== "string" || msg.clientId.length === 0 || msg.clientId.length > 64) {
        return ws.close(CLOSE_INVALID);
      }
      const { room, error } = rooms.join(ws, msg.roomId);
      if (error) return ws.close(error);
      ws.roomId = msg.roomId;
      ws.clientId = msg.clientId;
      send(ws, {
        type: "joined",
        isHost: room.host === ws,
        hostId: room.host.clientId,
        peers: room.clients.size,
        state: room.state,
        t1: now(),
      });
      broadcast(
        room,
        JSON.stringify({ type: "peerJoined", clientId: ws.clientId, peers: room.clients.size, hostId: room.host.clientId }),
        ws,
      );
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || !RELAYED_TYPES.has(msg.type)) return;
    // Keep the latest state so a late joiner can sync in one step. Only the host's heartbeats count.
    if (msg.type === "control" || (msg.type === "heartbeat" && room.host === ws)) room.state = msg;
    broadcast(room, raw.toString(), ws);
  });

  ws.on("close", () => {
    const room = rooms.leave(ws);
    if (!room) return;
    broadcast(
      room,
      JSON.stringify({ type: "peerLeft", clientId: ws.clientId, peers: room.clients.size, hostId: room.host.clientId }),
    );
  });
});

const liveness = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, LIVENESS_INTERVAL_MS);

wss.on("close", () => clearInterval(liveness));
wss.on("listening", () => console.log(`PrimeCatParty sync server listening on ws://${HOST}:${PORT}`));
