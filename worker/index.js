import { DurableObject } from 'cloudflare:workers';

const MAX_ROOM_SIZE = 8;
const MAX_ROOMS = 128;
const MAX_TOTAL_CONNECTIONS = 512;
const MAX_IP_CONNECTIONS = 32;
const MAX_SOCKET_BUFFER = 64 * 1024;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_MESSAGES_PER_SOCKET = 80;
const MESSAGE_WINDOW_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;
const MAX_IPFS_UPLOAD_SIZE = 5 * 1024 * 1024;
const IPFS_UPLOAD_URL_TTL_SECONDS = 60;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{8}$/;
const UUID_PATTERN = /^[\da-f-]{36}$/i;
const DEFAULT_COLOR = '#86c3b2';
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const DEFAULT_IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow) {
  return new Response(null, { status: 405, headers: { Allow: allow, 'Cache-Control': 'no-store' } });
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    return ['http:', 'https:'].includes(originUrl.protocol)
      && originUrl.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function createRateLimiter(limit, windowMs) {
  const attempts = new Map();
  return (key) => {
    const now = Date.now();
    const hadKey = attempts.has(key);
    const times = (attempts.get(key) || []).filter((time) => time > now - windowMs);
    if (hadKey) attempts.delete(key);
    else if (attempts.size >= MAX_RATE_LIMIT_KEYS) attempts.delete(attempts.keys().next().value);
    const allowed = times.length < limit;
    if (allowed) times.push(now);
    attempts.set(key, times);
    return allowed;
  };
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Guest';
  const normalized = value.normalize('NFKC')
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

function send(socket, message) {
  if (socket.readyState !== 1) return false;
  try {
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
      socket.close(1013, 'Slow consumer');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    socket.close(1011, 'Send failed');
    return false;
  }
}

function getIpfsGateways(value) {
  const values = (value || DEFAULT_IPFS_GATEWAYS.join(',')).split(',').map((gateway) => gateway.trim());
  const gateways = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
      if (url.pathname !== '/' && !url.pathname.endsWith('/ipfs/')) continue;
      const gateway = `${url.origin}${url.pathname === '/' ? '/ipfs/' : url.pathname}`;
      if (!gateways.includes(gateway)) gateways.push(gateway);
    } catch {
      // Ignore an invalid gateway and keep any remaining valid entries.
    }
  }
  return gateways.length ? gateways : DEFAULT_IPFS_GATEWAYS;
}

async function getIceConfig(env) {
  const urls = (env.KOKOPLA_TURN_URLS || '').split(',').map((url) => url.trim())
    .filter((url) => /^turns?:[^\s,]+$/i.test(url));
  const secret = env.KOKOPLA_TURN_SHARED_SECRET || '';
  if (!urls.length || secret.length < 16) {
    return { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', turnConfigured: false };
  }
  const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS}:kokopla-${crypto.randomUUID()}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return {
    iceServers: [...DEFAULT_ICE_SERVERS, { urls, username, credential }],
    iceTransportPolicy: env.KOKOPLA_RELAY_ONLY === 'true' ? 'relay' : 'all',
    turnConfigured: true,
  };
}

async function allowed(env, kind, key) {
  const stub = env.ROOM_HUB.getByName('global');
  const response = await stub.fetch('https://internal/rate-limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, key }),
  });
  return response.ok;
}

async function issueIpfsTicket(env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const upstream = await fetch('https://uploads.pinata.cloud/v3/files/sign', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PINATA_JWT.trim()}`,
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
      return json(502, { error: 'IPFSアップロードURLを発行できませんでした。' });
    }
    const uploadUrl = new URL(payload.data);
    if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'uploads.pinata.cloud') {
      return json(502, { error: 'IPFSアップロードURLが無効です。' });
    }
    return json(200, { url: uploadUrl.toString() });
  } catch {
    return json(502, { error: 'IPFSサービスに接続できませんでした。' });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/signal') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket required', { status: 426 });
      }
      if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
      return env.ROOM_HUB.getByName('global').fetch(request);
    }
    if (pathname === '/ice-config') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      if (!await allowed(env, 'ice', clientKey(request))) {
        return json(429, { error: 'ICE設定の取得回数が上限に達しました。少し待ってから再試行してください。' }, { 'Retry-After': '60' });
      }
      return json(200, await getIceConfig(env));
    }
    if (pathname === '/ipfs-config') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return json(200, {
        enabled: Boolean(env.PINATA_JWT?.trim()),
        maxFileSize: MAX_IPFS_UPLOAD_SIZE,
        gateways: getIpfsGateways(env.KOKOPLA_IPFS_GATEWAYS),
      });
    }
    if (pathname === '/ipfs-upload-ticket') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (!sameOrigin(request)) return json(403, { error: '同じサイトからのリクエストのみ利用できます。' });
      if (!env.PINATA_JWT?.trim()) return json(503, { error: 'IPFSアップロードが設定されていません。' });
      if (!await allowed(env, 'ipfs', clientKey(request))) {
        return json(429, { error: 'アップロード回数が上限に達しました。少し待ってから再試行してください。' }, { 'Retry-After': '60' });
      }
      return issueIpfsTicket(env);
    }
    return env.ASSETS.fetch(request);
  },
};

export class RoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.joinTimers = new WeakMap();
    this.iceLimiter = createRateLimiter(20, 60_000);
    this.ipfsLimiter = createRateLimiter(20, 60_000);
    this.joinLimiter = createRateLimiter(20, 60_000);
    this.restartLimiter = createRateLimiter(8, 60_000);
    this.peerResetLimiter = createRateLimiter(1, 1_500);
  }

  peers(roomCode, exceptSocket = null) {
    return this.ctx.getWebSockets().flatMap((socket) => {
      if (socket === exceptSocket) return [];
      const data = socket.deserializeAttachment();
      return data?.roomCode === roomCode && data.player ? [{ socket, player: data.player }] : [];
    });
  }

  leave(socket) {
    clearTimeout(this.joinTimers.get(socket));
    this.joinTimers.delete(socket);
    const data = socket.deserializeAttachment();
    if (!data?.player || !data.roomCode) return;
    socket.serializeAttachment({ ...data, roomCode: null, player: null });
    for (const peer of this.peers(data.roomCode, socket)) send(peer.socket, { type: 'peer-left', id: data.player.id });
  }

  reject(socket, message, code = 1008) {
    clearTimeout(this.joinTimers.get(socket));
    this.joinTimers.delete(socket);
    send(socket, { type: 'error', message });
    socket.close(code, 'Invalid request');
  }

  async limit(kind, key) {
    if (typeof key !== 'string' || key.length > 128) return false;
    if (kind === 'ice') return this.iceLimiter(key);
    if (kind !== 'ipfs' || !this.ipfsLimiter(key)) return false;
    return this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const times = ((await txn.get('ipfs-global-times')) || []).filter((time) => time > now - 60 * 60_000);
      if (times.length >= 120) return false;
      times.push(now);
      await txn.put('ipfs-global-times', times);
      return true;
    });
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/rate-limit') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const input = await request.json().catch(() => null);
      return new Response(null, { status: await this.limit(input?.kind, input?.key) ? 204 : 429 });
    }
    if (pathname !== '/signal' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
      || !sameOrigin(request)) return new Response('Forbidden', { status: 403 });
    const sockets = this.ctx.getWebSockets();
    const key = clientKey(request);
    if (sockets.length >= MAX_TOTAL_CONNECTIONS) return new Response('Service Unavailable', { status: 503 });
    if (sockets.filter((socket) => socket.deserializeAttachment()?.clientKey === key).length >= MAX_IP_CONNECTIONS) {
      return new Response('Too Many Requests', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientKey: key, player: null, roomCode: null, invalidMessages: 0, messageTimes: [] });
    const timer = setTimeout(() => {
      this.joinTimers.delete(server);
      if (server.readyState !== 1 || server.deserializeAttachment()?.player) return;
      send(server, { type: 'error', message: '部屋への参加がタイムアウトしました。' });
      server.close(1008, 'Join timeout');
    }, JOIN_TIMEOUT_MS);
    this.joinTimers.set(server, timer);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, raw) {
    const data = socket.deserializeAttachment();
    if (!data) return socket.close(1008, 'Missing session');
    const now = Date.now();
    data.messageTimes = (data.messageTimes || []).filter((time) => time > now - MESSAGE_WINDOW_MS);
    data.messageTimes.push(now);
    socket.serializeAttachment(data);
    if (data.messageTimes.length > MAX_MESSAGES_PER_SOCKET) return socket.close(1008, 'Message rate exceeded');
    if (typeof raw !== 'string') return this.reject(socket, 'バイナリ形式のメッセージには対応していません。', 1003);
    if (raw.length > MAX_MESSAGE_LENGTH) return socket.close(1009, 'Message too large');
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      data.invalidMessages += 1;
      socket.serializeAttachment(data);
      if (data.invalidMessages >= 3) socket.close(1007, 'Invalid JSON');
      else send(socket, { type: 'error', message: 'JSONメッセージを読み取れませんでした。' });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return this.reject(socket, 'メッセージの形式が正しくありません。');
    }

    if (message.type === 'join' && !data.player) {
      if (!this.joinLimiter(data.clientKey)) {
        return this.reject(socket, '接続の試行回数が多すぎます。少し待ってから再試行してください。');
      }
      const code = typeof message.room === 'string' ? message.room.toUpperCase() : '';
      if (!ROOM_CODE_PATTERN.test(code)) return this.reject(socket, 'ルームコードは8文字の英数字で入力してください。');
      const peers = this.peers(code, socket);
      if (message.create === true && peers.length) {
        return this.reject(socket, 'そのルームコードは既に使われています。もう一度作成してください。');
      }
      if (message.create !== true && !peers.length) {
        return this.reject(socket, 'ルームが見つかりません。コードを確認してください。');
      }
      if (message.create === true) {
        const rooms = new Set(this.ctx.getWebSockets().map((peer) => peer.deserializeAttachment()?.roomCode).filter(Boolean));
        if (rooms.size >= MAX_ROOMS) {
          return this.reject(socket, 'ルーム数の上限に達しました。時間をおいて再試行してください。', 1013);
        }
      }
      if (peers.length >= MAX_ROOM_SIZE) return this.reject(socket, 'このルームは満員です。');
      const player = { id: crypto.randomUUID(), name: cleanName(message.name), color: cleanColor(message.color) };
      data.player = player;
      data.roomCode = code;
      socket.serializeAttachment(data);
      clearTimeout(this.joinTimers.get(socket));
      this.joinTimers.delete(socket);
      send(socket, { type: 'room-joined', room: code, playerId: player.id, peers: peers.map((peer) => peer.player) });
      for (const peer of peers) send(peer.socket, { type: 'peer-joined', peer: player });
      return;
    }

    if (message.type === 'signal' && data.player && data.roomCode) {
      const targetId = typeof message.to === 'string' ? message.to : '';
      const signal = cleanSignal(message.signal);
      if (!UUID_PATTERN.test(targetId) || !signal) return;
      const target = this.peers(data.roomCode, socket).find((peer) => peer.player.id === targetId);
      if (target) send(target.socket, { type: 'signal', from: data.player.id, signal });
    } else if (message.type === 'restart-peer' && data.player && data.roomCode) {
      const targetId = typeof message.to === 'string' ? message.to : '';
      if (!UUID_PATTERN.test(targetId) || !this.restartLimiter(data.player.id)) return;
      const target = this.peers(data.roomCode, socket).find((peer) => peer.player.id === targetId);
      if (!target) return;
      const pairKey = `${data.roomCode}:${[data.player.id, targetId].sort().join(':')}`;
      if (!this.peerResetLimiter(pairKey)) return;
      send(socket, { type: 'peer-reset', peer: target.player });
      send(target.socket, { type: 'peer-reset', peer: data.player });
    } else if (!data.player) {
      this.reject(socket, '先に有効なルームへ参加してください。');
    }
  }

  webSocketClose(socket) {
    this.leave(socket);
  }

  webSocketError(socket) {
    this.leave(socket);
    try { socket.close(1011, 'WebSocket error'); } catch { /* Already closed. */ }
  }
}
