import * as THREE from 'three';
import './style.css';
import { createWorldItemSystem, WORLD_ITEMS_CHANNEL_LABEL } from './world-items.js';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const COLORS = ['#f2ad78', '#86c3b2', '#f19a9a', '#a997df', '#e6c35f', '#78aeda', '#ed91b9', '#94be70'];
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const DEFAULT_ICE_CONFIGURATION = { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' };
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanPlayerName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 16)
    .join('');
}

function readSavedName() {
  try {
    return cleanPlayerName(localStorage.getItem('kokopla-name') || '');
  } catch {
    return '';
  }
}

function wrapAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function cleanPeer(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string'
    || !/^[\da-f-]{36}$/i.test(value.id)) return null;
  return {
    id: value.id,
    name: cleanPlayerName(value.name) || 'Guest',
    color: typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : COLORS[0],
  };
}

const state = {
  name: readSavedName(),
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
  position: { x: 0, y: 0, z: 3.6 },
  yaw: 0,
  pitch: -0.22,
  movementMode: 'walk',
  cameraMode: 'first',
  jumpVelocity: 0,
  viewAngles: { x: 0, y: 0, z: 0 },
  pressed: new Set(),
  playerId: null,
  roomCode: null,
  roomJoined: false,
  roomAttempt: 0,
  signalingSocket: null,
  iceServers: DEFAULT_ICE_SERVERS,
  iceTransportPolicy: 'all',
  peerConnections: new Map(),
  remoteAvatars: new Map(),
  lastNetworkUpdate: 0,
};

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dcecf0');
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 40);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(800, 600, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('#scene-canvas').appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight('#ffffff', '#b6c3b8', 2.2));
const sun = new THREE.DirectionalLight('#fff4d8', 1.4);
sun.position.set(-4, 9, 5);
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshStandardMaterial({ color: '#e8eee8', roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.02;
scene.add(floor);

const grid = new THREE.GridHelper(10, 10, '#779580', '#b8c9bb');
grid.position.y = 0.005;
grid.material.transparent = true;
grid.material.opacity = 0.84;
scene.add(grid);

const boundaryMaterial = new THREE.MeshBasicMaterial({ color: '#698c75' });
const boundaryGeometry = new THREE.BoxGeometry(10, 0.045, 0.045);
const sideGeometry = new THREE.BoxGeometry(0.045, 0.045, 10);
for (const z of [-5, 5]) {
  const edge = new THREE.Mesh(boundaryGeometry, boundaryMaterial);
  edge.position.set(0, 0.035, z);
  scene.add(edge);
}
for (const x of [-5, 5]) {
  const edge = new THREE.Mesh(sideGeometry, boundaryMaterial);
  edge.position.set(x, 0.035, 0);
  scene.add(edge);
}
const cornerGeometry = new THREE.BoxGeometry(0.12, 0.3, 0.12);
const cornerMaterial = new THREE.MeshStandardMaterial({ color: '#e4a27f', roughness: 1 });
for (const x of [-4.94, 4.94]) for (const z of [-4.94, 4.94]) {
  const marker = new THREE.Mesh(cornerGeometry, cornerMaterial);
  marker.position.set(x, 0.15, z);
  scene.add(marker);
}

const avatarGeometry = new THREE.CapsuleGeometry(0.25, 0.65, 2, 6);
const avatar = new THREE.Group();
const bodyMaterial = new THREE.MeshStandardMaterial({ color: state.color, roughness: 0.9, flatShading: true });
const body = new THREE.Mesh(avatarGeometry, bodyMaterial);
body.position.y = 0.55;
avatar.add(body);
let nameTag;

function makeNameTag(name, color = state.color) {
  const labelName = cleanPlayerName(name) || 'ユーザー';
  const labelColor = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : COLORS[0];
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 420;
  labelCanvas.height = 80;
  const context = labelCanvas.getContext('2d');
  context.fillStyle = 'rgba(255,255,252,.92)';
  context.beginPath();
  context.roundRect(12, 9, 396, 58, 24);
  context.fill();
  context.fillStyle = labelColor;
  context.beginPath();
  context.arc(37, 38, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#405252';
  context.font = '600 22px "Yu Gothic UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(labelName, 220, 39);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(2.3, 0.49, 1);
  sprite.position.y = 2.08;
  return sprite;
}

function updateNameTag() {
  if (nameTag) {
    avatar.remove(nameTag);
    nameTag.material.map?.dispose();
    nameTag.material.dispose();
  }
  nameTag = makeNameTag(state.name || 'ユーザー');
  avatar.add(nameTag);
}
updateNameTag();
avatar.visible = false;
scene.add(avatar);

function createLookGizmo() {
  const gizmo = new THREE.Group();
  gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.5, '#ef6868', 0.14, 0.08));
  gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.36, '#65a878', 0.12, 0.07));
  gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.36, '#688fe0', 0.12, 0.07));
  gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.82, '#ed8e54', 0.24, 0.13));
  return gizmo;
}

function createRemoteAvatar(player) {
  const root = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.9, flatShading: true });
  const remoteBody = new THREE.Mesh(avatarGeometry, bodyMaterial);
  remoteBody.position.y = 0.55;
  root.add(remoteBody);
  const label = makeNameTag(player.name, player.color);
  root.add(label);
  const lookGizmo = createLookGizmo();
  lookGizmo.position.y = 1.7;
  root.add(lookGizmo);
  scene.add(root);
  const remote = {
    root,
    bodyMaterial,
    label,
    lookGizmo,
    name: player.name,
    target: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
    pitch: 0,
  };
  state.remoteAvatars.set(player.id, remote);
  return remote;
}

function updateRemoteAvatar(player) {
  if (!player || typeof player.id !== 'string') return null;
  const name = cleanPlayerName(player.name) || 'Guest';
  const color = /^#[0-9a-f]{6}$/i.test(String(player.color)) ? player.color : COLORS[0];
  let remote = state.remoteAvatars.get(player.id);
  if (!remote) remote = createRemoteAvatar({ ...player, name, color });
  if (remote.name !== name) {
    remote.root.remove(remote.label);
    remote.label.material.map?.dispose();
    remote.label.material.dispose();
    remote.label = makeNameTag(name, color);
    remote.root.add(remote.label);
    remote.name = name;
  }
  remote.bodyMaterial.color.set(color);
  remote.target.x = Number.isFinite(player.x) ? player.x : 0;
  remote.target.y = Number.isFinite(player.y) ? player.y : 0;
  remote.target.z = Number.isFinite(player.z) ? player.z : 0;
  remote.target.yaw = Number.isFinite(player.yaw) ? player.yaw : 0;
  remote.target.pitch = Number.isFinite(player.pitch) ? clamp(player.pitch, -Math.PI / 2, Math.PI / 2) : 0;
  return remote;
}

function removeRemoteAvatar(playerId) {
  const remote = state.remoteAvatars.get(playerId);
  if (!remote) return;
  scene.remove(remote.root);
  remote.root.remove(remote.label);
  remote.label.material.map?.dispose();
  remote.label.material.dispose();
  remote.bodyMaterial.dispose();
  remote.lookGizmo.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose();
  });
  state.remoteAvatars.delete(playerId);
}

const lookGizmo = createLookGizmo();
lookGizmo.rotation.order = 'YXZ';
lookGizmo.visible = false;
scene.add(lookGizmo);

function toast(message) {
  const element = $('#app-toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 3000);
}

function sceneToast(message) {
  const element = $('#room-toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(sceneToast.timer);
  sceneToast.timer = setTimeout(() => element.classList.remove('visible'), 1800);
}

const ipfsConfigurationPromise = fetch('/ipfs-config', { cache: 'no-store' })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('IPFS設定を取得できませんでした。')))
  .then((config) => ({
    enabled: config.enabled === true,
    gateways: Array.isArray(config.gateways) ? config.gateways : [],
  }))
  .catch(() => ({ enabled: false, gateways: [] }));
const worldItemSystem = createWorldItemSystem({
  scene,
  camera,
  canvas: renderer.domElement,
  getConnections: () => state.peerConnections,
  getIpfsConfig: () => ipfsConfigurationPromise,
  getPlayerPose: () => ({ x: state.position.x, y: state.position.y + 1.6, z: state.position.z, yaw: state.yaw }),
  getRemoteEye: (peerId, target) => {
    const remote = state.remoteAvatars.get(peerId);
    if (!remote) return false;
    target.set(remote.root.position.x, remote.root.position.y + 1.6, remote.root.position.z);
    return true;
  },
  isRoomJoined: () => state.roomJoined,
  toast,
});

function sendSignaling(message) {
  const socket = state.signalingSocket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function updateRoomUi() {
  const active = Boolean(state.roomCode);
  const connectedPeers = [...state.peerConnections.values()].filter((connection) => connection.channel?.readyState === 'open').length;
  $('#create-room-button').hidden = active;
  $('#join-room-form').hidden = active;
  $('#active-room').hidden = !active;
  $('#copy-room-button').disabled = !state.roomJoined;
  $('#active-room-label').textContent = active
    ? state.roomJoined ? `ルーム ${state.roomCode} · ${state.peerConnections.size + 1}人` : `ルーム ${state.roomCode} に接続中`
    : '';
  if (!active) {
    $('#network-status').textContent = '未接続';
  } else if (!state.roomJoined || state.signalingSocket?.readyState !== WebSocket.OPEN) {
    $('#network-status').textContent = `ルーム ${state.roomCode} に接続中`;
  } else if (connectedPeers) {
    $('#network-status').textContent = `接続中 · ${connectedPeers + 1}人`;
  } else if (state.peerConnections.size) {
    $('#network-status').textContent = `接続を確立中 · ${state.peerConnections.size + 1}人`;
  } else {
    $('#network-status').textContent = `ルーム ${state.roomCode} · 参加者を待っています`;
  }
}

function sendPlayerState() {
  const message = JSON.stringify({
    type: 'player-state',
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
    yaw: state.yaw,
    pitch: state.pitch,
  });
  for (const connection of state.peerConnections.values()) {
    const channel = connection.channel;
    if (channel?.readyState === 'open' && channel.bufferedAmount < 16 * 1024) channel.send(message);
  }
}

function updateFromPeer(id, rawMessage) {
  if (typeof rawMessage !== 'string' || rawMessage.length > 1_024) return;
  const remote = state.remoteAvatars.get(id);
  if (!remote) return;
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'player-state') return;
  const bounded = (value) => Number.isFinite(value) ? clamp(value, -100, 100) : 0;
  remote.target.x = bounded(message.x);
  remote.target.y = bounded(message.y);
  remote.target.z = bounded(message.z);
  remote.target.yaw = Number.isFinite(message.yaw) ? wrapAngle(message.yaw) : 0;
  remote.target.pitch = Number.isFinite(message.pitch) ? clamp(message.pitch, -Math.PI / 2, Math.PI / 2) : 0;
}

function attachDataChannel(id, connection, channel) {
  if (state.peerConnections.get(id) !== connection) {
    channel.close();
    return;
  }
  if (connection.channel && connection.channel !== channel && connection.channel.readyState !== 'closed') {
    channel.close();
    return;
  }
  connection.channel = channel;
  channel.onopen = () => {
    if (state.peerConnections.get(id) !== connection) return;
    updateRoomUi();
    sendPlayerState();
  };
  connection.lastStateReceived = 0;
  channel.onmessage = (event) => {
    if (state.peerConnections.get(id) !== connection) return;
    const now = performance.now();
    if (now - connection.lastStateReceived < 20) return;
    connection.lastStateReceived = now;
    updateFromPeer(id, event.data);
  };
  channel.onclose = () => {
    if (state.peerConnections.get(id) === connection) updateRoomUi();
  };
  channel.onerror = () => {
    if (state.peerConnections.get(id) === connection) toast('通信が不安定です。');
  };
}

function closePeerConnection(id) {
  const connection = state.peerConnections.get(id);
  if (connection) {
    state.peerConnections.delete(id);
    clearTimeout(connection.restartTimer);
    worldItemSystem.closeConnection(connection);
    connection.pc.close();
  }
  removeRemoteAvatar(id);
  updateRoomUi();
}

function startPeerConnection(peer, shouldOffer) {
  if (!peer?.id || state.peerConnections.has(peer.id)) return state.peerConnections.get(peer?.id);
  updateRemoteAvatar({ id: peer.id, name: peer.name, color: peer.color, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: state.iceServers, iceTransportPolicy: state.iceTransportPolicy });
  } catch {
    removeRemoteAvatar(peer.id);
    toast('このブラウザーでは通信を開始できません。');
    return null;
  }
  const connection = { pc, channel: null, pendingCandidates: [], shouldOffer, restartTimer: null, restartAttempts: 0 };
  state.peerConnections.set(peer.id, connection);
  pc.onicecandidate = (event) => {
    if (state.peerConnections.get(peer.id) === connection && event.candidate) {
      sendSignaling({ type: 'signal', to: peer.id, signal: { candidate: event.candidate } });
    }
  };
  pc.ondatachannel = (event) => {
    if (state.peerConnections.get(peer.id) !== connection) {
      event.channel.close();
      return;
    }
    if (event.channel.label === 'player-state') attachDataChannel(peer.id, connection, event.channel);
    else if (event.channel.label === WORLD_ITEMS_CHANNEL_LABEL) {
      worldItemSystem.attachChannel(peer.id, connection, event.channel);
    } else event.channel.close();
  };
  pc.onconnectionstatechange = () => {
    if (state.peerConnections.get(peer.id) !== connection) return;
    updateRoomUi();
    if (pc.connectionState === 'connected') {
      clearTimeout(connection.restartTimer);
      connection.restartTimer = null;
      return;
    }
    if (pc.connectionState === 'closed') {
      closePeerConnection(peer.id);
      return;
    }
    if (connection.shouldOffer && ['failed', 'disconnected'].includes(pc.connectionState) && !connection.restartTimer) {
      const delay = pc.connectionState === 'failed' ? 750 : 3_000;
      connection.restartTimer = setTimeout(async () => {
        connection.restartTimer = null;
        if (state.peerConnections.get(peer.id) !== connection || pc.connectionState === 'connected'
          || !['failed', 'disconnected'].includes(pc.connectionState)
          || state.signalingSocket?.readyState !== WebSocket.OPEN) return;
        connection.restartAttempts += 1;
        sendSignaling({ type: 'restart-peer', to: peer.id });
        toast(`接続を再試行しています (${connection.restartAttempts})`);
      }, delay);
    }
  };

  if (shouldOffer) {
    const channel = pc.createDataChannel('player-state', { ordered: false, maxRetransmits: 0 });
    attachDataChannel(peer.id, connection, channel);
    const worldItemsChannel = pc.createDataChannel(WORLD_ITEMS_CHANNEL_LABEL);
    worldItemSystem.attachChannel(peer.id, connection, worldItemsChannel);
    void (async () => {
      try {
        const offer = await pc.createOffer();
        if (state.peerConnections.get(peer.id) !== connection) return;
        await pc.setLocalDescription(offer);
        if (state.peerConnections.get(peer.id) !== connection) return;
        sendSignaling({ type: 'signal', to: peer.id, signal: { description: pc.localDescription } });
      } catch {
        if (state.peerConnections.get(peer.id) !== connection) return;
        sendSignaling({ type: 'restart-peer', to: peer.id });
        toast('接続を開始できませんでした。');
      }
    })();
  }
  return connection;
}

async function resetPeerConnection(peer) {
  if (!peer?.id || peer.id === state.playerId || !state.playerId) return;
  const previousConnection = state.peerConnections.get(peer.id);
  const attempt = state.roomAttempt;
  const iceConfiguration = await loadIceConfiguration();
  if (attempt !== state.roomAttempt || !state.roomJoined
    || state.signalingSocket?.readyState !== WebSocket.OPEN
    || state.peerConnections.get(peer.id) !== previousConnection
    || !state.remoteAvatars.has(peer.id)) return;
  state.iceServers = iceConfiguration.iceServers;
  state.iceTransportPolicy = iceConfiguration.iceTransportPolicy;
  closePeerConnection(peer.id);
  startPeerConnection(peer, state.playerId < peer.id);
  updateRoomUi();
}

async function handleSignal(from, signal) {
  const connection = state.peerConnections.get(from);
  if (!connection || !signal || typeof signal !== 'object') return;
  const isCurrent = () => state.peerConnections.get(from) === connection;
  try {
    if (signal.description) {
      await connection.pc.setRemoteDescription(signal.description);
      if (!isCurrent()) return;
      for (const candidate of connection.pendingCandidates.splice(0)) {
        await connection.pc.addIceCandidate(candidate);
        if (!isCurrent()) return;
      }
      if (signal.description.type === 'offer') {
        const answer = await connection.pc.createAnswer();
        if (!isCurrent()) return;
        await connection.pc.setLocalDescription(answer);
        if (!isCurrent()) return;
        sendSignaling({ type: 'signal', to: from, signal: { description: connection.pc.localDescription } });
      }
    } else if (signal.candidate) {
      if (connection.pc.remoteDescription) {
        await connection.pc.addIceCandidate(signal.candidate);
        if (!isCurrent()) return;
      }
      else if (connection.pendingCandidates.length < 64) connection.pendingCandidates.push(signal.candidate);
    }
  } catch {
    if (!isCurrent()) return;
    sendSignaling({ type: 'restart-peer', to: from });
    toast('接続に失敗しました。ネットワークを確認してください。');
  }
}

let iceConfigurationPromise;
let cachedIceConfiguration = DEFAULT_ICE_CONFIGURATION;
let iceConfigurationCacheExpiresAt = 0;
function loadIceConfiguration() {
  if (iceConfigurationCacheExpiresAt > Date.now()) return Promise.resolve(cachedIceConfiguration);
  if (!iceConfigurationPromise) {
    iceConfigurationPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await fetch('/ice-config', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('ICE configuration unavailable');
        const config = await response.json();
        const iceServers = Array.isArray(config?.iceServers) ? config.iceServers.filter((server) => {
          if (!server || typeof server !== 'object') return false;
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          const validUrls = urls.length > 0 && urls.every((url) => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url));
          const hasTurn = urls.some((url) => typeof url === 'string' && /^(turn|turns):/i.test(url));
          return validUrls && (!hasTurn || (typeof server.username === 'string' && typeof server.credential === 'string'));
        }) : [];
        return {
          iceServers: iceServers.length ? iceServers : DEFAULT_ICE_SERVERS,
          iceTransportPolicy: config.iceTransportPolicy === 'relay' && iceServers.some((server) => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some((url) => /^turns?:/i.test(url));
          }) ? 'relay' : 'all',
        };
      } catch {
        return DEFAULT_ICE_CONFIGURATION;
      } finally {
        clearTimeout(timeout);
      }
    })().then((configuration) => {
      cachedIceConfiguration = configuration;
      iceConfigurationCacheExpiresAt = Date.now() + 8 * 60 * 1_000;
      return cachedIceConfiguration;
    }).finally(() => {
      iceConfigurationPromise = null;
    });
  }
  return iceConfigurationPromise;
}

async function connectToRoom(roomValue, create = false) {
  if (!state.name) {
    toast('先にユーザー名を設定してください。');
    return;
  }
  if (state.signalingSocket || state.roomCode) {
    toast('現在のルームから退出してから接続してください。');
    return;
  }
  const room = String(roomValue || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!/^[A-Z0-9]{8}$/.test(room)) {
    toast('ルームコードは8文字の英数字で入力してください。');
    return;
  }

  state.roomCode = room;
  state.roomJoined = false;
  const attempt = ++state.roomAttempt;
  updateRoomUi();
  const iceConfiguration = await loadIceConfiguration();
  state.iceServers = iceConfiguration.iceServers;
  state.iceTransportPolicy = iceConfiguration.iceTransportPolicy;
  if (attempt !== state.roomAttempt || state.roomCode !== room) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${location.host}/signal`);
  } catch {
    leaveRoom(false);
    toast('シグナリングサーバーに接続できません。');
    return;
  }
  state.signalingSocket = socket;
  updateRoomUi();
  socket.addEventListener('open', () => {
    if (state.signalingSocket !== socket) return;
    socket.send(JSON.stringify({ type: 'join', room, create, name: state.name, color: state.color }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'room-joined' && typeof message.room === 'string'
      && /^[A-Z0-9]{8}$/.test(message.room) && typeof message.playerId === 'string'
      && /^[\da-f-]{36}$/i.test(message.playerId) && Array.isArray(message.peers)) {
      state.roomCode = message.room;
      state.playerId = message.playerId;
      state.roomJoined = true;
      for (const peer of message.peers.slice(0, 7)) {
        const clean = cleanPeer(peer);
        if (clean) startPeerConnection(clean, state.playerId < clean.id);
      }
      updateRoomUi();
    } else if (message.type === 'peer-joined') {
      const peer = cleanPeer(message.peer);
      if (peer && state.playerId) startPeerConnection(peer, state.playerId < peer.id);
      updateRoomUi();
    } else if (message.type === 'peer-reset') {
      const peer = cleanPeer(message.peer);
      if (peer) resetPeerConnection(peer);
    } else if (message.type === 'peer-left' && typeof message.id === 'string') {
      closePeerConnection(message.id);
      sceneToast('参加者が退出しました');
    } else if (message.type === 'signal' && typeof message.from === 'string') {
      void handleSignal(message.from, message.signal);
    } else if (message.type === 'error') {
      toast(message.message || 'ルームに接続できませんでした。');
      leaveRoom(false);
    }
  });
  socket.addEventListener('close', () => {
    if (state.signalingSocket !== socket) return;
    leaveRoom(false);
    toast('シグナリングサーバーとの接続が切れました。');
  });
  socket.addEventListener('error', () => toast('シグナリングサーバーに接続できません。'));
}

function leaveRoom(showMessage = true) {
  const wasConnected = Boolean(state.roomCode || state.signalingSocket);
  state.roomAttempt += 1;
  const socket = state.signalingSocket;
  state.signalingSocket = null;
  state.roomCode = null;
  state.roomJoined = false;
  state.playerId = null;
  socket?.close();
  for (const id of [...state.peerConnections.keys()]) closePeerConnection(id);
  for (const id of [...state.remoteAvatars.keys()]) removeRemoteAvatar(id);
  worldItemSystem.clear();
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  updateRoomUi();
  if (showMessage && wasConnected) sceneToast('ルームから退出しました');
}

function createRoom() {
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const room = Array.from(bytes, (byte) => ROOM_ALPHABET[byte & 31]).join('');
    void connectToRoom(room, true);
  } catch {
    toast('安全なルームコードを作成できませんでした。');
  }
}

async function copyInviteLink() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.roomCode);
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('招待リンクをコピーしました。');
  } catch {
    window.prompt('招待リンクをコピーしてください', url.toString());
  }
}

function joinRoomFromUrl() {
  const room = new URLSearchParams(location.search).get('room');
  if (room) connectToRoom(room);
}

function updatePointerControls() {
  const isLocked = document.pointerLockElement === renderer.domElement;
  document.body.classList.toggle('cursor-locked', isLocked);
}

function updateMovementMode() {
  document.body.classList.toggle('mode-fly', state.movementMode === 'fly');
}

function updateCameraMode() {
  const isThirdPerson = state.cameraMode === 'third';
  avatar.visible = isThirdPerson;
  lookGizmo.visible = isThirdPerson;
}

function toggleCameraMode() {
  state.cameraMode = state.cameraMode === 'first' ? 'third' : 'first';
  updateCameraMode();
  sceneToast(state.cameraMode === 'third' ? '三人称視点' : '一人称視点');
}

const canvas = renderer.domElement;
canvas.tabIndex = 0;
function capturePointer() {
  if (!$('#video-backdrop').hidden) return;
  canvas.focus({ preventScroll: true });
  if (document.pointerLockElement === canvas) return;
  try {
    const request = canvas.requestPointerLock?.();
    request?.catch(() => toast('マウス操作を開始できませんでした。'));
  } catch {
    toast('マウス操作を開始できませんでした。');
  }
}

$('#username-input').value = state.name;
$('#username-backdrop').hidden = false;
requestAnimationFrame(() => $('#username-input').focus());
$('#username-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = cleanPlayerName($('#username-input').value);
  if (!name) {
    $('#username-input').focus();
    return;
  }
  state.name = name;
  try {
    localStorage.setItem('kokopla-name', name);
  } catch {
    // The current session can continue when browser storage is unavailable.
  }
  updateNameTag();
  $('#username-backdrop').hidden = true;
  joinRoomFromUrl();
});

$('#create-room-button').addEventListener('click', createRoom);
$('#join-room-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connectToRoom($('#room-code-input').value);
});
$('#copy-room-button').addEventListener('click', copyInviteLink);
$('#leave-room-button').addEventListener('click', () => leaveRoom());

updatePointerControls();
updateMovementMode();
updateCameraMode();
updateRoomUi();
canvas.addEventListener('click', capturePointer);
canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  state.movementMode = state.movementMode === 'walk' ? 'fly' : 'walk';
  state.jumpVelocity = 0;
  if (state.movementMode === 'walk') state.position.y = 0;
  updateMovementMode();
  sceneToast(state.movementMode === 'fly' ? '飛行モード' : '歩行モード');
});
canvas.addEventListener('auxclick', (event) => {
  if (event.button === 1) event.preventDefault();
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas) return;
  if (worldItemSystem.rotateGrabbed(event.movementX, event.movementY)) return;
  state.yaw = wrapAngle(state.yaw - event.movementX * 0.0022);
  state.pitch = clamp(state.pitch - event.movementY * 0.0022, -Math.PI / 2, Math.PI / 2);
});
document.addEventListener('pointerlockchange', updatePointerControls);
document.addEventListener('pointerlockerror', () => toast('マウス操作を開始できませんでした。'));

window.addEventListener('keydown', (event) => {
  if (!$('#video-backdrop').hidden) return;
  if (!$('#username-backdrop').hidden) {
    if (event.key === 'Escape') event.preventDefault();
    return;
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (key === 'f') {
    event.preventDefault();
    if (!event.repeat) toggleCameraMode();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    if (state.movementMode === 'fly') state.pressed.add('space');
    else if (state.position.y <= 0.001 && !event.repeat) state.jumpVelocity = 5.2;
    return;
  }
  if (['w', 'a', 's', 'd'].includes(key)) {
    event.preventDefault();
    state.pressed.add(key);
  }
});
window.addEventListener('keyup', (event) => {
  state.pressed.delete(event.key.toLowerCase());
  if (event.code === 'Space') state.pressed.delete('space');
});
window.addEventListener('blur', () => state.pressed.clear());

let lastTime = performance.now();
const viewDirection = new THREE.Vector3();
const viewRight = new THREE.Vector3();
const walkForward = new THREE.Vector3();
const walkRight = new THREE.Vector3();
const movement = new THREE.Vector3();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const forward = (state.pressed.has('w') ? 1 : 0) - (state.pressed.has('s') ? 1 : 0);
  const sideways = (state.pressed.has('d') ? 1 : 0) - (state.pressed.has('a') ? 1 : 0);
  const ascending = state.movementMode === 'fly' && state.pressed.has('space') ? 1 : 0;
  camera.rotation.set(state.pitch, state.yaw, 0);
  camera.updateMatrixWorld(true);
  state.viewAngles.x = Number(THREE.MathUtils.radToDeg(camera.rotation.x).toFixed(2));
  state.viewAngles.y = Number(THREE.MathUtils.radToDeg(camera.rotation.y).toFixed(2));
  state.viewAngles.z = Number(THREE.MathUtils.radToDeg(camera.rotation.z).toFixed(2));
  window.kokoplaViewAngles = state.viewAngles;
  viewDirection.set(0, 0, -1).applyQuaternion(camera.quaternion);
  viewRight.set(1, 0, 0).applyQuaternion(camera.quaternion);

  if (forward || sideways || ascending) {
    if (state.movementMode === 'fly') {
      movement.copy(viewDirection).multiplyScalar(forward).addScaledVector(viewRight, sideways);
      movement.y += ascending;
      movement.normalize();
    } else {
      walkForward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
      walkRight.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
      movement.copy(walkForward).multiplyScalar(forward).addScaledVector(walkRight, sideways).normalize();
    }
    const speed = state.movementMode === 'fly' ? 3.5 : 2.8;
    const distance = speed * dt;
    const nextX = state.position.x + movement.x * distance;
    const nextZ = state.position.z + movement.z * distance;
    state.position.x = state.movementMode === 'fly' ? nextX : clamp(nextX, -4.8, 4.8);
    state.position.z = state.movementMode === 'fly' ? nextZ : clamp(nextZ, -4.8, 4.8);
    if (state.movementMode === 'fly') state.position.y += movement.y * distance;
  }

  if (state.movementMode === 'walk') {
    state.position.y += state.jumpVelocity * dt;
    state.jumpVelocity -= 14 * dt;
    if (state.position.y <= 0) {
      state.position.y = 0;
      state.jumpVelocity = 0;
    }
  }

  avatar.position.set(state.position.x, state.position.y, state.position.z);
  avatar.rotation.y = state.yaw;
  for (const remote of state.remoteAvatars.values()) {
    remote.root.position.x += (remote.target.x - remote.root.position.x) * Math.min(1, dt * 18);
    remote.root.position.y += (remote.target.y - remote.root.position.y) * Math.min(1, dt * 18);
    remote.root.position.z += (remote.target.z - remote.root.position.z) * Math.min(1, dt * 18);
    const turn = Math.atan2(Math.sin(remote.target.yaw - remote.root.rotation.y), Math.cos(remote.target.yaw - remote.root.rotation.y));
    remote.root.rotation.y += turn * Math.min(1, dt * 18);
    remote.pitch += (remote.target.pitch - remote.pitch) * Math.min(1, dt * 18);
    remote.lookGizmo.rotation.x = remote.pitch;
  }
  const eyeHeight = state.position.y + 1.6;
  if (state.cameraMode === 'third') camera.position.set(state.position.x, eyeHeight, state.position.z).addScaledVector(viewDirection, -3.2);
  else camera.position.set(state.position.x, eyeHeight, state.position.z);
  camera.rotation.set(state.pitch, state.yaw, 0);
  camera.updateMatrixWorld(true);
  lookGizmo.position.set(state.position.x, state.position.y + 1.7, state.position.z);
  lookGizmo.quaternion.copy(camera.quaternion);
  worldItemSystem.update(now);
  if (now - state.lastNetworkUpdate >= 50) {
    sendPlayerState();
    state.lastNetworkUpdate = now;
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

const resizeObserver = new ResizeObserver(() => {
  const element = $('#scene-canvas');
  const width = Math.max(1, element.clientWidth);
  const height = Math.max(1, element.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
});
resizeObserver.observe($('#scene-canvas'));
