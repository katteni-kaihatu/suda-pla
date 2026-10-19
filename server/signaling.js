import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_ROOM_SIZE = 8;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,8}$/;
const DEFAULT_COLOR = '#86c3b2';

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function cleanName(value) {
  return String(value || 'Guest').trim().slice(0, 16) || 'Guest';
}

function cleanColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? value : DEFAULT_COLOR;
}

function cleanSignal(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.description && ['offer', 'answer'].includes(value.description.type)
    && typeof value.description.sdp === 'string' && value.description.sdp.length <= 12000) {
    return { description: { type: value.description.type, sdp: value.description.sdp } };
  }
  if (value.candidate && typeof value.candidate.candidate === 'string'
    && value.candidate.candidate.length <= 4096) {
    return { candidate: value.candidate };
  }
  return null;
}

export function cloudflareMultiplayer() {
  const rooms = new Map();
  const attachedServers = new WeakSet();

  function attach(httpServer) {
    if (!httpServer || attachedServers.has(httpServer)) return;
    attachedServers.add(httpServer);
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

    httpServer.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url, 'http://localhost');
      if (pathname !== '/signal') return;
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit('connection', client, request);
      });
    });

    webSockets.on('connection', (client) => {
      let roomCode = null;
      let player = null;

      client.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          send(client, { type: 'error', message: 'Invalid message' });
          return;
        }

        if (message.type === 'join' && !player) {
          const code = String(message.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
          if (!ROOM_CODE_PATTERN.test(code)) {
            send(client, { type: 'error', message: 'Enter a room code with 4–8 letters or numbers.' });
            return;
          }
          const room = rooms.get(code) || new Map();
          if (room.size >= MAX_ROOM_SIZE) {
            send(client, { type: 'error', message: 'This room is full.' });
            client.close(1008, 'Room full');
            return;
          }

          roomCode = code;
          player = { id: randomUUID(), name: cleanName(message.name), color: cleanColor(message.color) };
          const peers = [...room.values()].map((peer) => peer.player);
          room.set(player.id, { socket: client, player });
          rooms.set(code, room);
          send(client, { type: 'room-joined', room: code, playerId: player.id, peers });
          for (const peer of room.values()) {
            if (peer.player.id !== player.id) send(peer.socket, { type: 'peer-joined', peer: player });
          }
          return;
        }

        if (message.type === 'signal' && player && roomCode) {
          const targetId = String(message.to || '');
          const signal = cleanSignal(message.signal);
          const target = rooms.get(roomCode)?.get(targetId);
          if (target && signal) send(target.socket, { type: 'signal', from: player.id, signal });
        }
      });

      const leaveRoom = () => {
        if (!player || !roomCode) return;
        const room = rooms.get(roomCode);
        room?.delete(player.id);
        if (room?.size) {
          for (const peer of room.values()) send(peer.socket, { type: 'peer-left', id: player.id });
        } else {
          rooms.delete(roomCode);
        }
        player = null;
        roomCode = null;
      };

      client.on('close', leaveRoom);
      client.on('error', leaveRoom);
    });
  }

  return {
    name: 'kokopla-cloudflare-multiplayer',
    configureServer(server) {
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      attach(server.httpServer);
    },
  };
}
