import * as THREE from 'three';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const COLORS = ['#f2ad78', '#86c3b2', '#f19a9a', '#a997df', '#e6c35f', '#78aeda', '#ed91b9', '#94be70'];
const state = {
  name: localStorage.getItem('kokopla-name')?.trim() || '',
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
  signalingSocket: null,
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
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 420;
  labelCanvas.height = 80;
  const context = labelCanvas.getContext('2d');
  context.fillStyle = 'rgba(255,255,252,.92)';
  context.beginPath();
  context.roundRect(12, 9, 396, 58, 24);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.arc(37, 38, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#405252';
  context.font = '600 22px "Yu Gothic UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(name.slice(0, 16), 220, 39);
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
  let remote = state.remoteAvatars.get(player.id);
  if (!remote) remote = createRemoteAvatar(player);
  if (remote.name !== player.name) {
    remote.root.remove(remote.label);
    remote.label.material.map?.dispose();
    remote.label.material.dispose();
    remote.label = makeNameTag(player.name, player.color);
    remote.root.add(remote.label);
    remote.name = player.name;
  }
  remote.bodyMaterial.color.set(player.color);
  remote.target.x = Number.isFinite(player.x) ? player.x : 0;
  remote.target.y = Number.isFinite(player.y) ? player.y : 0;
  remote.target.z = Number.isFinite(player.z) ? player.z : 0;
  remote.target.yaw = Number.isFinite(player.yaw) ? player.yaw : 0;
  remote.target.pitch = Number.isFinite(player.pitch) ? clamp(player.pitch, -Math.PI / 2, Math.PI / 2) : 0;
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
  $('#active-room-label').textContent = active ? `ルーム ${state.roomCode} · ${connectedPeers + 1}人` : '';
  if (!active) {
    $('#network-status').textContent = '未接続';
  } else if (state.signalingSocket?.readyState === WebSocket.CONNECTING) {
    $('#network-status').textContent = `ルーム ${state.roomCode} に接続中`;
  } else if (connectedPeers) {
    $('#network-status').textContent = `P2P接続中 · ${connectedPeers + 1}人`;
  } else {
    $('#network-status').textContent = `ルーム ${state.roomCode} · 参加者を待っています`;
  }
}

function sendPlayerState() {
  const message = JSON.stringify({
    type: 'player-state',
    name: state.name,
    color: state.color,
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
    yaw: state.yaw,
    pitch: state.pitch,
  });
  for (const connection of state.peerConnections.values()) {
    const channel = connection.channel;
    if (channel?.readyState === 'open' && channel.bufferedAmount < 64 * 1024) channel.send(message);
  }
}

function updateFromPeer(id, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }
  if (message.type !== 'player-state') return;
  const name = String(message.name || 'Guest').slice(0, 16);
  const color = /^#[0-9a-f]{6}$/i.test(String(message.color)) ? message.color : COLORS[0];
  const bounded = (value) => Number.isFinite(value) ? clamp(value, -100, 100) : 0;
  updateRemoteAvatar({
    id,
    name,
    color,
    x: bounded(message.x),
    y: bounded(message.y),
    z: bounded(message.z),
    yaw: Number.isFinite(message.yaw) ? message.yaw : 0,
    pitch: Number.isFinite(message.pitch) ? message.pitch : 0,
  });
}

function attachDataChannel(id, connection, channel) {
  connection.channel = channel;
  channel.onopen = () => {
    updateRoomUi();
    sendPlayerState();
  };
  channel.onmessage = (event) => updateFromPeer(id, event.data);
  channel.onclose = updateRoomUi;
  channel.onerror = () => toast('P2P通信が不安定です。');
}

function closePeerConnection(id) {
  const connection = state.peerConnections.get(id);
  if (connection) {
    state.peerConnections.delete(id);
    connection.pc.close();
  }
  removeRemoteAvatar(id);
  updateRoomUi();
}

function startPeerConnection(peer, shouldOffer) {
  if (!peer?.id || state.peerConnections.has(peer.id)) return state.peerConnections.get(peer?.id);
  updateRemoteAvatar({ id: peer.id, name: peer.name, color: peer.color, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const connection = { pc, channel: null, pendingCandidates: [] };
  state.peerConnections.set(peer.id, connection);
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignaling({ type: 'signal', to: peer.id, signal: { candidate: event.candidate } });
  };
  pc.ondatachannel = (event) => attachDataChannel(peer.id, connection, event.channel);
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closePeerConnection(peer.id);
  };

  if (shouldOffer) {
    const channel = pc.createDataChannel('player-state', { ordered: false, maxRetransmits: 0 });
    attachDataChannel(peer.id, connection, channel);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => sendSignaling({ type: 'signal', to: peer.id, signal: { description: pc.localDescription } }))
      .catch(() => toast('P2P接続を開始できませんでした。'));
  }
  return connection;
}

async function handleSignal(from, signal) {
  let connection = state.peerConnections.get(from);
  if (!connection) connection = startPeerConnection({ id: from, name: 'Guest', color: COLORS[0] }, false);
  if (!connection) return;
  try {
    if (signal.description) {
      await connection.pc.setRemoteDescription(signal.description);
      for (const candidate of connection.pendingCandidates.splice(0)) await connection.pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') {
        const answer = await connection.pc.createAnswer();
        await connection.pc.setLocalDescription(answer);
        sendSignaling({ type: 'signal', to: from, signal: { description: connection.pc.localDescription } });
      }
    } else if (signal.candidate) {
      if (connection.pc.remoteDescription) await connection.pc.addIceCandidate(signal.candidate);
      else connection.pendingCandidates.push(signal.candidate);
    }
  } catch {
    closePeerConnection(from);
    toast('P2P接続に失敗しました。ネットワークを確認してください。');
  }
}

function connectToRoom(roomValue) {
  if (!state.name) {
    toast('先にユーザー名を設定してください。');
    return;
  }
  if (state.signalingSocket || state.roomCode) {
    toast('現在のルームから退出してから接続してください。');
    return;
  }
  const room = String(roomValue || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!/^[A-Z0-9]{4,8}$/.test(room)) {
    toast('ルームコードは4〜8文字で入力してください。');
    return;
  }

  state.roomCode = room;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/signal`);
  state.signalingSocket = socket;
  updateRoomUi();
  socket.addEventListener('open', () => {
    if (state.signalingSocket !== socket) return;
    socket.send(JSON.stringify({ type: 'join', room, name: state.name, color: state.color }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'room-joined') {
      state.roomCode = message.room;
      state.playerId = message.playerId;
      for (const peer of message.peers) startPeerConnection(peer, state.playerId < peer.id);
      updateRoomUi();
    } else if (message.type === 'peer-joined') {
      startPeerConnection(message.peer, state.playerId < message.peer.id);
      updateRoomUi();
    } else if (message.type === 'peer-left') {
      closePeerConnection(message.id);
      sceneToast('参加者が退出しました');
    } else if (message.type === 'signal') {
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
  const socket = state.signalingSocket;
  state.signalingSocket = null;
  state.roomCode = null;
  state.playerId = null;
  socket?.close();
  for (const id of [...state.peerConnections.keys()]) closePeerConnection(id);
  for (const id of [...state.remoteAvatars.keys()]) removeRemoteAvatar(id);
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  updateRoomUi();
  if (showMessage && wasConnected) sceneToast('ルームから退出しました');
}

function createRoom() {
  const room = Math.random().toString(36).slice(2, 8).toUpperCase();
  connectToRoom(room);
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
  $('#immersive-status').textContent = isLocked ? 'マウス操作中 · Escで解除' : 'クリックして視点操作';
}

function updateMovementMode() {
  $('#movement-mode').textContent = state.movementMode === 'fly' ? '飛行モード' : '歩行モード';
}

function updateCameraMode() {
  const isThirdPerson = state.cameraMode === 'third';
  $('#camera-mode').textContent = isThirdPerson ? '三人称視点' : '一人称視点';
  avatar.visible = isThirdPerson;
  lookGizmo.visible = isThirdPerson;
}

function toggleCameraMode() {
  state.cameraMode = state.cameraMode === 'first' ? 'third' : 'first';
  updateCameraMode();
  sceneToast(state.cameraMode === 'third' ? '三人称視点' : '一人称視点');
}

const canvas = renderer.domElement;
function capturePointer() {
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
  const name = $('#username-input').value.trim().slice(0, 16);
  if (!name) {
    $('#username-input').focus();
    return;
  }
  state.name = name;
  localStorage.setItem('kokopla-name', name);
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
  state.yaw -= event.movementX * 0.0022;
  state.pitch = clamp(state.pitch - event.movementY * 0.0022, -Math.PI / 2, Math.PI / 2);
});
document.addEventListener('pointerlockchange', updatePointerControls);
document.addEventListener('pointerlockerror', () => toast('マウス操作を開始できませんでした。'));

window.addEventListener('keydown', (event) => {
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
  lookGizmo.position.set(state.position.x, state.position.y + 1.7, state.position.z);
  lookGizmo.quaternion.copy(camera.quaternion);
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
