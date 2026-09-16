import { WebSocket } from "ws";

export const MAX_CLIENTS = 8;
const ROOM_ID = /^[a-z0-9]{8}$/;

export const CLOSE_INVALID = 4000;
export const CLOSE_FULL = 4001;

export class Rooms {
  #rooms = new Map(); // roomId -> { clients: Set, state, host }

  get(roomId) {
    return this.#rooms.get(roomId);
  }

  join(ws, roomId) {
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) return { error: CLOSE_INVALID };
    let room = this.#rooms.get(roomId);
    if (room && room.clients.size >= MAX_CLIENTS) return { error: CLOSE_FULL };
    if (!room) {
      room = { clients: new Set(), state: null, host: ws };
      this.#rooms.set(roomId, room);
    }
    room.clients.add(ws);
    return { room };
  }

  // Returns the room if it still has clients, promoting a new host when needed.
  leave(ws) {
    const room = this.#rooms.get(ws.roomId);
    if (!room || !room.clients.delete(ws)) return null;
    if (room.clients.size === 0) {
      this.#rooms.delete(ws.roomId);
      return null;
    }
    if (room.host === ws) room.host = room.clients.values().next().value;
    return room;
  }
}

export function broadcast(room, data, except = null) {
  for (const peer of room.clients) {
    if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(data);
  }
}
