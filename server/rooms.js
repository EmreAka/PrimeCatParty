import { WebSocket } from "ws";

export const MAX_CLIENTS = 8;
const ROOM_ID = /^[a-z0-9]{8}$/;

export const CLOSE_INVALID = 4000;
export const CLOSE_FULL = 4001;

export class Rooms {
  #rooms = new Map(); // roomId -> { clients: Set, state, host }

  get size() {
    return this.#rooms.size;
  }

  get(roomId) {
    return this.#rooms.get(roomId);
  }

  entries() {
    return this.#rooms.entries();
  }

  join(ws, roomId) {
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) return { error: CLOSE_INVALID };
    let room = this.#rooms.get(roomId);
    if (room && room.clients.size >= MAX_CLIENTS) return { error: CLOSE_FULL };
    const created = !room;
    if (!room) {
      room = { clients: new Set(), state: null, host: ws };
      this.#rooms.set(roomId, room);
    }
    room.clients.add(ws);
    return { room, created };
  }

  // Removes the client, promoting a new host or deleting the room when it empties.
  leave(ws) {
    const room = this.#rooms.get(ws.roomId);
    if (!room || !room.clients.delete(ws)) return null;
    if (room.clients.size === 0) {
      this.#rooms.delete(ws.roomId);
      return { room, deleted: true, hostChanged: false };
    }
    const hostChanged = room.host === ws;
    if (hostChanged) room.host = room.clients.values().next().value;
    return { room, deleted: false, hostChanged };
  }
}

export function broadcast(room, data, except = null) {
  for (const peer of room.clients) {
    if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(data);
  }
}
