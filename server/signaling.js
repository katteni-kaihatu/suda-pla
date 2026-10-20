import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { linkPreview, youtubeThumbnail } from './link-preview.js';

const MAX_ROOM_SIZE = 8;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{8}$/;
const DEFAULT_COLOR = '#86c3b2';
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_SOCKET_BUFFER = 64 * 1024;
const MAX_JOIN_ATTEMPTS = 20;
const JOIN_ATTEMPT_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_SOCKET = 80;
const MESSAGE_WINDOW_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
const MAX_IP_CONNECTIONS = 32;
const MAX_RATE_LIMIT_KEYS = 10_000;
const TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;
const ICE_CONFIG_REQUESTS_PER_MINUTE = 20;
const previewLimiter = createRateLimiter(60, 60_000);
const MAX_IPFS_UPLOAD_SIZE = 5 * 1024 * 1024;
const IPFS_UPLOAD_URL_TTL_SECONDS = 60;
const DEFAULT_IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

function readPositiveLimit(name, fallback, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const MAX_TOTAL_CONNECTIONS = readPositiveLimit('KOKOPLA_MAX_CONNECTIONS', 512, 10_000);
const MAX_ROOMS = readPositiveLimit('KOKOPLA_MAX_ROOMS', 128, 2_000);
function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
    socket.close(1013, 'Slow consumer');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Guest';
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(normalized).slice(0, 16).join('') || 'Guest';
}

function cleanColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_COLOR;
}

function cleanSignal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const description = value.description;
  if (description && typeof description === 'object'
    && ['offer', 'answer'].includes(description.type)
    && typeof description.sdp === 'string' && description.sdp.length <= 12_000) {
    return { description: { type: description.type, sdp: description.sdp } };
  }

  const candidate = value.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4_096) return null;

  const cleanCandidate = { candidate: candidate.candidate };
  if (candidate.sdpMid === null || (typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 256)) {
    cleanCandidate.sdpMid = candidate.sdpMid;
  }
  if (candidate.sdpMLineIndex === null
    || (Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 255)) {
    cleanCandidate.sdpMLineIndex = candidate.sdpMLineIndex;
  }
  if (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 256) {
    cleanCandidate.usernameFragment = candidate.usernameFragment;
  }
  return { candidate: cleanCandidate };
}

function getClientKey(request) {
  const cloudflareAddress = request.headers['cf-connecting-ip'];
  if (typeof cloudflareAddress === 'string' && isIP(cloudflareAddress)) return cloudflareAddress;
  return request.socket.remoteAddress || 'unknown';
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;

  try {
    const originUrl = new URL(origin);
    if (!['http:', 'https:'].includes(originUrl.protocol)) return false;
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createRateLimiter(limit, windowMs, maxKeys = MAX_RATE_LIMIT_KEYS) {
  const attempts = new Map();
  return (key) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const hadKey = attempts.has(key);
    const timestamps = (attempts.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (hadKey) attempts.delete(key);
    else if (attempts.size >= maxKeys) {
      const oldestKey = attempts.keys().next().value;
      if (oldestKey !== undefined) attempts.delete(oldestKey);
    }
    const allowed = timestamps.length < limit;
    if (allowed) timestamps.push(now);
    attempts.set(key, timestamps);
    return allowed;
  };
}

function getIceServers() {
  const urls = (process.env.KOKOPLA_TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^turns?:[^\s,]+$/i.test(url));
  const secret = process.env.KOKOPLA_TURN_SHARED_SECRET || '';
  if (!urls.length || secret.length < 16) {
    return { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', turnConfigured: false };
  }

  const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS}:kokopla-${randomUUID()}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return {
    iceServers: [...DEFAULT_ICE_SERVERS, { urls, username, credential }],
    iceTransportPolicy: process.env.KOKOPLA_RELAY_ONLY === 'true' ? 'relay' : 'all',
    turnConfigured: true,
  };
}

function installIceConfigMiddleware(server, issueLimiter) {
  server.middlewares.use((request, response, next) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return next();
    }
    if (pathname !== '/ice-config') return next();
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!issueLimiter(getClientKey(request))) {
      response.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '60',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify({ error: 'ICE設定の取得回数が上限に達しました。少し待ってから再試行してください。' }));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(getIceServers()));
  });
}

function installLinkPreviewMiddleware(server) {
  server.middlewares.use((request, response, next) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/link-preview' && pathname !== '/youtube-thumbnail') return next();
    if (!previewLimiter(getClientKey(request))) {
      response.writeHead(429, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
      response.end();
      return;
    }
    const host = request.headers.host || 'localhost';
    const source = new Request(`http://${host}${request.url}`, { method: request.method });
    const handler = pathname === '/link-preview' ? linkPreview : youtubeThumbnail;
    void handler(source).then(async (result) => {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    }).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
}

function getIpfsGateways() {
  const values = (process.env.KOKOPLA_IPFS_GATEWAYS || DEFAULT_IPFS_GATEWAYS.join(','))
    .split(',')
    .map((gateway) => gateway.trim())
    .filter(Boolean);
  const gateways = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
      if (url.pathname !== '/' && !url.pathname.endsWith('/ipfs/')) continue;
      const pathname = url.pathname === '/' ? '/ipfs/' : url.pathname;
      const gateway = `${url.origin}${pathname}`;
      if (!gateways.includes(gateway)) gateways.push(gateway);
    } catch {
      // Ignore invalid gateway entries and keep the remaining usable gateways.
    }
  }
  return gateways.length ? gateways : DEFAULT_IPFS_GATEWAYS;
}

function installIpfsMiddleware(server, ticketLimiter, globalTicketLimiter) {
  server.middlewares.use((request, response, next) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return next();
    }
    if (pathname !== '/ipfs-config' && pathname !== '/ipfs-upload-ticket') return next();
    const sendJson = (status, value) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };

    if (pathname === '/ipfs-config') {
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendJson(200, {
        enabled: Boolean(process.env.PINATA_JWT?.trim()),
        maxFileSize: MAX_IPFS_UPLOAD_SIZE,
        gateways: getIpfsGateways(),
      });
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!isAllowedOrigin(request)) {
      sendJson(403, { error: '同じサイトからのリクエストのみ利用できます。' });
      return;
    }
    if (!process.env.PINATA_JWT?.trim()) {
      sendJson(503, { error: 'IPFSアップロードが設定されていません。' });
      return;
    }
    const clientKey = getClientKey(request);
    if (!ticketLimiter(clientKey) || !globalTicketLimiter('all')) {
      response.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '60',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify({ error: 'アップロード回数が上限に達しました。少し待ってから再試行してください。' }));
      request.resume();
      return;
    }
    request.resume();
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const upstream = await fetch('https://uploads.pinata.cloud/v3/files/sign', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.PINATA_JWT.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            date: Math.floor(Date.now() / 1000),
            expires: IPFS_UPLOAD_URL_TTL_SECONDS,
            max_file_size: MAX_IPFS_UPLOAD_SIZE,
            cid_version: 'v1',
          }),
          signal: controller.signal,
        });
        const payload = await upstream.json().catch(() => null);
        if (!upstream.ok || typeof payload?.data !== 'string') {
          sendJson(502, { error: 'IPFSアップロードURLを発行できませんでした。' });
          return;
        }
        const uploadUrl = new URL(payload.data);
        if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'uploads.pinata.cloud') {
          sendJson(502, { error: 'IPFSアップロードURLが無効です。' });
          return;
        }
        sendJson(200, { url: uploadUrl.toString() });
      } catch {
        sendJson(502, { error: 'IPFSサービスに接続できませんでした。' });
      } finally {
        clearTimeout(timeout);
      }
    })();
  });
}

export function cloudflareMultiplayer() {
  const rooms = new Map();
  const attachedServers = new WeakSet();
  const joinLimiter = createRateLimiter(MAX_JOIN_ATTEMPTS, JOIN_ATTEMPT_WINDOW_MS);
  const restartLimiter = createRateLimiter(8, 60_000);
  const peerResetLimiter = createRateLimiter(1, 1_500);
  const iceConfigLimiter = createRateLimiter(ICE_CONFIG_REQUESTS_PER_MINUTE, 60_000);
  const ipfsTicketLimiter = createRateLimiter(20, 60_000);
  const ipfsGlobalTicketLimiter = createRateLimiter(120, 60 * 60_000, MAX_RATE_LIMIT_KEYS);
  const ipConnections = new Map();

  function attach(httpServer, rejectUnknownUpgrade = false) {
    if (!httpServer || attachedServers.has(httpServer)) return;
    attachedServers.add(httpServer);
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    });
    let activeConnections = 0;

    const heartbeat = setInterval(() => {
      for (const client of webSockets.clients) {
        if (client.readyState !== WebSocket.OPEN || client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 30_000);
    heartbeat.unref?.();
    httpServer.once('close', () => {
      clearInterval(heartbeat);
      for (const client of webSockets.clients) client.terminate();
    });

    httpServer.on('upgrade', (request, socket, head) => {
      let pathname;
      try {
        pathname = new URL(request.url || '/', 'http://localhost').pathname;
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (pathname !== '/signal') {
        if (rejectUnknownUpgrade) socket.destroy();
        return;
      }
      if (!isAllowedOrigin(request)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      const clientKey = getClientKey(request);
      if (activeConnections >= MAX_TOTAL_CONNECTIONS) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      if ((ipConnections.get(clientKey) || 0) >= MAX_IP_CONNECTIONS) {
        rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
      }

      activeConnections += 1;
      ipConnections.set(clientKey, (ipConnections.get(clientKey) || 0) + 1);
      let released = false;
      const releaseConnection = () => {
        if (released) return;
        released = true;
        activeConnections = Math.max(0, activeConnections - 1);
        const remaining = (ipConnections.get(clientKey) || 1) - 1;
        if (remaining <= 0) ipConnections.delete(clientKey);
        else ipConnections.set(clientKey, remaining);
      };
      socket.once('close', releaseConnection);
      socket.once('error', () => socket.destroy());

      try {
        webSockets.handleUpgrade(request, socket, head, (client) => {
          webSockets.emit('connection', client, request, clientKey);
        });
      } catch {
        releaseConnection();
        rejectUpgrade(socket, 400, 'Bad Request');
      }
    });

    webSockets.on('connection', (client, _request, clientKey) => {
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      let roomCode = null;
      let player = null;
      let closed = false;
      let invalidMessages = 0;
      const messageTimes = [];

      const joinTimer = setTimeout(() => {
        if (player || client.readyState !== WebSocket.OPEN) return;
        send(client, { type: 'error', message: '部屋への参加がタイムアウトしました。' });
        client.close(1008, 'Join timeout');
      }, JOIN_TIMEOUT_MS);

      const leaveRoom = () => {
        if (closed) return;
        closed = true;
        clearTimeout(joinTimer);
        if (!player || !roomCode) return;
        const room = rooms.get(roomCode);
        room?.delete(player.id);
        if (room?.size) {
          for (const peer of room.values()) send(peer.socket, { type: 'peer-left', id: player.id });
        } else {
          rooms.delete(roomCode);
        }
      };

      const rejectClient = (message, code = 1008) => {
        send(client, { type: 'error', message });
        client.close(code, 'Invalid request');
      };

      client.on('message', (raw, isBinary) => {
        const now = Date.now();
        while (messageTimes.length && messageTimes[0] <= now - MESSAGE_WINDOW_MS) messageTimes.shift();
        messageTimes.push(now);
        if (messageTimes.length > MAX_MESSAGES_PER_SOCKET) {
          client.close(1008, 'Message rate exceeded');
          return;
        }
        if (isBinary) {
          rejectClient('バイナリ形式のメッセージには対応していません。', 1003);
          return;
        }

        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          invalidMessages += 1;
          if (invalidMessages >= 3) client.close(1007, 'Invalid JSON');
          else send(client, { type: 'error', message: 'JSONメッセージを読み取れませんでした。' });
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          rejectClient('メッセージの形式が正しくありません。');
          return;
        }

        if (message.type === 'join' && !player) {
          if (!joinLimiter(clientKey)) {
            rejectClient('接続の試行回数が多すぎます。少し待ってから再試行してください。', 1008);
            return;
          }
          const code = typeof message.room === 'string' ? message.room.toUpperCase() : '';
          if (!ROOM_CODE_PATTERN.test(code)) {
            rejectClient('ルームコードは8文字の英数字で入力してください。');
            return;
          }

          const creating = message.create === true;
          let room = rooms.get(code);
          if (creating) {
            if (room) {
              rejectClient('そのルームコードは既に使われています。もう一度作成してください。');
              return;
            }
            if (rooms.size >= MAX_ROOMS) {
              rejectClient('ルーム数の上限に達しました。時間をおいて再試行してください。', 1013);
              return;
            }
            room = new Map();
            rooms.set(code, room);
          } else if (!room) {
            rejectClient('ルームが見つかりません。コードを確認してください。');
            return;
          }
          if (room.size >= MAX_ROOM_SIZE) {
            if (creating) rooms.delete(code);
            rejectClient('このルームは満員です。');
            return;
          }

          roomCode = code;
          player = { id: randomUUID(), name: cleanName(message.name), color: cleanColor(message.color) };
          clearTimeout(joinTimer);
          const peers = [...room.values()].map((peer) => peer.player);
          room.set(player.id, { socket: client, player });
          send(client, { type: 'room-joined', room: code, playerId: player.id, peers });
          for (const peer of room.values()) {
            if (peer.player.id !== player.id) send(peer.socket, { type: 'peer-joined', peer: player });
          }
          return;
        }

        if (message.type === 'signal' && player && roomCode) {
          const targetId = typeof message.to === 'string' ? message.to : '';
          const signal = cleanSignal(message.signal);
          if (!/^[\da-f-]{36}$/i.test(targetId) || !signal) return;
          const target = rooms.get(roomCode)?.get(targetId);
          if (target && target.player.id !== player.id) {
            send(target.socket, { type: 'signal', from: player.id, signal });
          }
        } else if (message.type === 'restart-peer' && player && roomCode) {
          const targetId = typeof message.to === 'string' ? message.to : '';
          if (!/^[\da-f-]{36}$/i.test(targetId) || !restartLimiter(player.id)) return;
          const target = rooms.get(roomCode)?.get(targetId);
          if (!target || target.player.id === player.id) return;
          const pairKey = `${roomCode}:${[player.id, targetId].sort().join(':')}`;
          if (!peerResetLimiter(pairKey)) return;
          send(client, { type: 'peer-reset', peer: target.player });
          send(target.socket, { type: 'peer-reset', peer: player });
        } else if (!player) {
          rejectClient('先に有効なルームへ参加してください。');
        }
      });

      client.on('close', leaveRoom);
      client.on('error', leaveRoom);
    });

    webSockets.on('error', () => {});
  }

  return {
    name: 'kokopla-cloudflare-multiplayer',
    configureServer(server) {
      installIceConfigMiddleware(server, iceConfigLimiter);
      installLinkPreviewMiddleware(server);
      installIpfsMiddleware(server, ipfsTicketLimiter, ipfsGlobalTicketLimiter);
      attach(server.httpServer, false);
    },
    configurePreviewServer(server) {
      installIceConfigMiddleware(server, iceConfigLimiter);
      installLinkPreviewMiddleware(server);
      installIpfsMiddleware(server, ipfsTicketLimiter, ipfsGlobalTicketLimiter);
      attach(server.httpServer, true);
    },
  };
}
