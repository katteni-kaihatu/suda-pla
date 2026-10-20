import * as THREE from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

export const WORLD_ITEMS_CHANNEL_LABEL = 'kokopla-world-items';

const MAX_ITEM_COUNT = 16;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024;
const MAX_MESSAGE_LENGTH = 12 * 1024;
const TRANSFER_TIMEOUT_MS = 30_000;
const IPFS_FETCH_TIMEOUT_MS = 9_000;
const CARD_SIZE = 1.25;
const IMAGE_WORLD_SIZE = 1.5;
const MAX_URL_LENGTH = 2048;
const MIN_GRAB_DISTANCE = 0.2;
const MAX_GRAB_DISTANCE = 30;
const VIDEO_SYNC_INTERVAL_MS = 2500;
const VIDEO_POLL_INTERVAL_MS = 300;
const MIN_ITEM_SCALE = 0.15;
const MAX_ITEM_SCALE = 5;
const UUID_PATTERN = /^[\da-f-]{36}$/i;
const CID_V1_PATTERN = /^b[a-z2-7]{20,100}$/;

function cleanFileName(value) {
  if (typeof value !== 'string') return 'ファイル';
  const name = value.normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(name).slice(0, 64).join('') || 'ファイル';
}

function cleanMimeType(value) {
  return typeof value === 'string' && value.length <= 128
    && /^[a-z\d.+-]+\/[a-z\d.+-]+$/i.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

function normalizeWebUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_URL_LENGTH || /\s/.test(text)) return null;
  try {
    const url = new URL(/^www\./i.test(text) ? `https://${text}` : text);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.href.length > MAX_URL_LENGTH) return null;
    return url.href;
  } catch {
    return null;
  }
}

function itemUrl(item) {
  return item?.mimeType === 'text/uri-list' && item.bytes.length <= MAX_URL_LENGTH * 4
    ? normalizeWebUrl(new TextDecoder().decode(item.bytes)) : null;
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (/^\/(?:shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2];
    }
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

function drawPreviewLines(context, value, x, y, maxWidth, lineHeight, maxLines) {
  const words = Array.from(value || '');
  let line = '';
  let count = 0;
  for (const character of words) {
    if (line && context.measureText(line + character).width > maxWidth) {
      context.fillText(line, x, y + count * lineHeight);
      count += 1;
      line = '';
      if (count >= maxLines) return;
    }
    line += character;
  }
  if (line && count < maxLines) context.fillText(line, x, y + count * lineHeight);
}

function wrapAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function validTransform(message) {
  const values = [message.qx, message.qy, message.qz, message.qw];
  const hasRotation = values.some((value) => value !== undefined);
  const lengthSquared = values.reduce((sum, value) => sum + value * value, 0);
  return (!hasRotation || (values.every(Number.isFinite) && lengthSquared > 0.01 && lengthSquared < 100))
    && (message.scale === undefined || (Number.isFinite(message.scale)
      && message.scale >= MIN_ITEM_SCALE && message.scale <= MAX_ITEM_SCALE));
}

function itemRotation(message) {
  if (message.qx !== undefined) {
    return new THREE.Quaternion(message.qx, message.qy, message.qz, message.qw).normalize();
  }
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), message.yaw);
}

function poseFields(item) {
  return {
    x: item.x,
    y: item.y,
    z: item.z,
    yaw: item.yaw,
    qx: item.rotation.x,
    qy: item.rotation.y,
    qz: item.rotation.z,
    qw: item.rotation.w,
    scale: item.scale,
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function drawWrappedName(context, name) {
  const characters = Array.from(name);
  const lines = [];
  let line = '';
  let index = 0;
  while (index < characters.length && lines.length < 2) {
    const next = line + characters[index];
    if (line && context.measureText(next).width > 432) {
      lines.push(line);
      line = '';
    } else {
      line = next;
      index += 1;
    }
  }
  if (line && lines.length < 2) lines.push(line);
  if (index < characters.length && lines.length) {
    let last = lines.at(-1);
    while (last && context.measureText(`${last}…`).width > 432) last = Array.from(last).slice(0, -1).join('');
    lines[lines.length - 1] = `${last}…`;
  }
  lines.forEach((text, lineIndex) => context.fillText(text, 256, 425 + lineIndex * 27));
}

function createFileCardCanvas(item) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fffefa';
  context.beginPath();
  context.roundRect(8, 8, 496, 496, 28);
  context.fill();
  context.strokeStyle = '#dbe7dc';
  context.lineWidth = 5;
  context.stroke();

  context.fillStyle = '#e8f0e7';
  context.beginPath();
  context.roundRect(178, 98, 156, 210, 18);
  context.fill();
  context.fillStyle = '#6f9a77';
  context.font = '700 40px "Yu Gothic UI", sans-serif';
  context.textAlign = 'center';
  const extension = item.name.includes('.') ? item.name.split('.').at(-1).slice(0, 5).toUpperCase() : 'FILE';
  context.fillText(extension || 'FILE', 256, 220);

  context.fillStyle = '#405252';
  context.font = '600 21px "Yu Gothic UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  drawWrappedName(context, item.name);
  context.fillStyle = '#839087';
  context.font = '16px "Yu Gothic UI", sans-serif';
  context.fillText(`${item.mimeType} · ${formatFileSize(item.size)}`, 256, 482, 448);
  return { canvas, width: CARD_SIZE, height: CARD_SIZE };
}

async function createUrlCanvas(item) {
  const url = itemUrl(item);
  if (!url) return null;
  const videoId = youtubeVideoId(url);
  let preview = null;
  try {
    const response = await fetch(`/link-preview?url=${encodeURIComponent(url)}`);
    if (response.ok) preview = await response.json();
  } catch {
    // Keep the URL card usable when the destination blocks previews.
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 576;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#fffefa';
  context.beginPath();
  context.roundRect(5, 5, 1014, 566, 24);
  context.fill();
  context.fillStyle = videoId ? '#283a43' : '#e5efe8';
  context.fillRect(16, 16, 992, 330);
  if (videoId) {
    try {
      const response = await fetch(`/youtube-thumbnail?id=${videoId}`);
      if (response.ok) {
        const bitmap = await createImageBitmap(await response.blob());
        context.drawImage(bitmap, 16, 16, 992, 330);
        bitmap.close();
      }
    } catch {
      // A video still has a title and a working link without its thumbnail.
    }
    context.fillStyle = '#e43d38';
    context.beginPath();
    context.roundRect(456, 125, 112, 78, 20);
    context.fill();
    context.fillStyle = '#fff';
    context.beginPath();
    context.moveTo(500, 144);
    context.lineTo(500, 184);
    context.lineTo(534, 164);
    context.fill();
  } else {
    context.fillStyle = '#628b73';
    context.font = '700 96px "Yu Gothic UI", sans-serif';
    context.fillText('↗', 60, 208);
  }
  context.fillStyle = '#305342';
  context.font = '700 38px "Yu Gothic UI", sans-serif';
  drawPreviewLines(context, preview?.title || new URL(url).hostname, 44, 399, 936, 46, 2);
  context.fillStyle = '#6b8072';
  context.font = '25px "Yu Gothic UI", sans-serif';
  drawPreviewLines(context, preview?.description || url, 44, 485, 936, 34, 2);
  context.fillStyle = '#688d76';
  context.font = '22px "Yu Gothic UI", sans-serif';
  context.fillText(new URL(url).hostname, 44, 554, 936);
  return { canvas, width: 2, height: 1.125 };
}

async function createItemCanvas(item) {
  if (item.mimeType === 'text/uri-list' && item.bytes.length) {
    return await createUrlCanvas(item) || createFileCardCanvas(item);
  }
  if (item.mimeType.startsWith('image/') && item.bytes.length) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([item.bytes], { type: item.mimeType }));
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_777_216) {
        return createFileCardCanvas(item);
      }
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = width;
      imageCanvas.height = height;
      const context = imageCanvas.getContext('2d');
      if (!context) return createFileCardCanvas(item);
      context.drawImage(bitmap, 0, 0, width, height);
      const worldScale = IMAGE_WORLD_SIZE / Math.max(width, height);
      return { canvas: imageCanvas, width: width * worldScale, height: height * worldScale };
    } catch {
      // Invalid or unsupported image data is shown as a regular file card.
    } finally {
      bitmap?.close();
    }
  }
  return createFileCardCanvas(item);
}

export function createWorldItemSystem({ scene, cssScene, camera, canvas, getConnections, getPlayerPose, getRemoteEye, getIpfsConfig, isRoomJoined, toast }) {
  const items = new Map();
  const pendingItems = new Map();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const worldPoint = new THREE.Vector3();
  const viewDirection = new THREE.Vector3();
  const viewRight = new THREE.Vector3();
  const playerEye = new THREE.Vector3();
  const lineOrigin = new THREE.Vector3();
  const grabOffset = new THREE.Vector3();
  const grabRotation = new THREE.Quaternion();
  const grabWorldRotation = new THREE.Quaternion();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const videoNormal = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const rotationEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const dropHint = document.querySelector('#drop-hint');
  const videoSurface = document.createElement('div');
  videoSurface.className = 'video-surface';
  const videoContainer = document.createElement('div');
  videoContainer.className = 'video-player';
  videoSurface.append(videoContainer);
  const videoStates = new Map();
  const pendingVideoStates = new Map();
  const videoAuthor = crypto.randomUUID();
  let videoItemId = null;
  let videoPlayer = null;
  let videoObject = null;
  let videoReady = false;
  let videoPendingPlay = false;
  let videoAutoplayBlocked = false;
  let videoOpenToken = 0;
  let videoPollAt = 0;
  let videoBroadcastAt = 0;
  let suppressedVideoState = null;
  let youtubeApiPromise = null;
  let lastVideoSample = null;
  let totalBytes = 0;
  let pendingBytes = 0;
  let dropDepth = 0;
  let dropQueue = Promise.resolve();
  let grabbedItem = null;
  let rotateHeld = false;
  let lastPositionBroadcast = 0;
  const gatewaySeed = Math.floor(Math.random() * 2 ** 32);
  let gatewayCursor = 0;

  function discardPending(itemId) {
    const pending = pendingItems.get(itemId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingItems.delete(itemId);
    pendingBytes = Math.max(0, pendingBytes - pending.size);
  }

  function discardConnectionTransfers(connection) {
    for (const [itemId, pending] of pendingItems) {
      if (pending.connection === connection) discardPending(itemId);
    }
    for (const item of items.values()) {
      if (item.heldBy === connection.worldItemsPeerId) item.heldBy = null;
    }
  }

  function clear() {
    closeVideo(false);
    videoStates.clear();
    pendingVideoStates.clear();
    grabbedItem = null;
    rotateHeld = false;
    for (const itemId of [...pendingItems.keys()]) discardPending(itemId);
    for (const item of items.values()) {
      if (!item.mesh) continue;
      scene.remove(item.mesh);
      scene.remove(item.tether);
      item.tether.geometry.dispose();
      item.tether.material.dispose();
      item.outline.material.dispose();
      item.mesh.geometry.dispose();
      item.mesh.material.map?.dispose();
      item.mesh.material.dispose();
    }
    items.clear();
    totalBytes = 0;
  }

  function addItem(item) {
    if (items.has(item.id) || items.size + pendingItems.size >= MAX_ITEM_COUNT
      || totalBytes + pendingBytes + item.size > MAX_TOTAL_BYTES) return false;
    totalBytes += item.size;
    item.rotation ||= itemRotation(item);
    item.scale ??= 1;
    item.heldBy ||= null;
    items.set(item.id, item);
    void createItemCanvas(item).then((card) => {
      if (items.get(item.id) !== item) return;
      const texture = new THREE.CanvasTexture(card.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.01,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(card.width, card.height), material);
      mesh.position.set(item.x, item.y, item.z);
      mesh.quaternion.copy(item.rotation);
      mesh.scale.setScalar(item.scale);
      mesh.userData.worldItemId = item.id;
      const outline = new THREE.Mesh(mesh.geometry, new THREE.ShaderMaterial({
        uniforms: { itemTexture: { value: texture } },
        vertexShader: `
          varying vec2 itemUv;
          void main() {
            itemUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D itemTexture;
          varying vec2 itemUv;
          float shapeAt(vec2 point) {
            if (point.x < 0.0 || point.x > 1.0 || point.y < 0.0 || point.y > 1.0) return 0.0;
            return step(0.06, texture2D(itemTexture, point).a);
          }
          void main() {
            vec2 pixelX = dFdx(itemUv) * 3.0;
            vec2 pixelY = dFdy(itemUv) * 3.0;
            float center = shapeAt(itemUv);
            float edge = max(
              max(abs(center - shapeAt(itemUv + pixelX)), abs(center - shapeAt(itemUv - pixelX))),
              max(abs(center - shapeAt(itemUv + pixelY)), abs(center - shapeAt(itemUv - pixelY)))
            );
            if (edge < 0.5) discard;
            gl_FragColor = vec4(0.62, 0.91, 0.71, 0.9);
          }
        `,
        side: THREE.DoubleSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }));
      outline.position.z = 0.003;
      outline.renderOrder = 10;
      outline.visible = Boolean(item.heldBy);
      mesh.add(outline);
      const tetherGeometry = new THREE.BufferGeometry();
      const points = new THREE.BufferAttribute(new Float32Array(6), 3);
      points.setUsage(THREE.DynamicDrawUsage);
      tetherGeometry.setAttribute('position', points);
      const tether = new THREE.Line(tetherGeometry, new THREE.LineBasicMaterial({
        color: '#a47bdd', transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
      }));
      tether.frustumCulled = false;
      tether.renderOrder = 9;
      tether.visible = false;
      scene.add(mesh);
      scene.add(tether);
      item.mesh = mesh;
      item.outline = outline;
      item.tether = tether;
      if (item.id === videoItemId) setVideoMeshMask(item, true);
    }).catch(() => toast('データアイテムを表示できませんでした。'));
    return true;
  }

  function sendItem(connection, item) {
    const channel = connection.worldItemsChannel;
    if (channel?.readyState !== 'open') return;
    if (item.cid) {
      channel.send(JSON.stringify({
        type: 'world-item-ipfs',
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        cid: item.cid,
        ...poseFields(item),
      }));
      return;
    }
    const chunkCount = Math.ceil(item.bytes.length / CHUNK_SIZE);
    channel.send(JSON.stringify({
      type: 'world-item-start',
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      ...poseFields(item),
      chunkCount,
    }));
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * CHUNK_SIZE;
      const data = bytesToBase64(item.bytes.subarray(start, Math.min(start + CHUNK_SIZE, item.bytes.length)));
      channel.send(JSON.stringify({ type: 'world-item-chunk', id: item.id, index, data }));
    }
  }

  function broadcastItem(item) {
    for (const connection of getConnections().values()) sendItem(connection, item);
  }

  function addIncomingItem(pending) {
    discardPending(pending.id);
    const item = {
      id: pending.id,
      name: pending.name,
      mimeType: pending.mimeType,
      size: pending.size,
      cid: pending.cid || null,
      x: pending.x,
      y: pending.y,
      z: pending.z,
      yaw: pending.yaw,
      rotation: pending.rotation,
      scale: pending.scale,
      heldBy: pending.heldBy,
      bytes: pending.bytes,
    };
    if (!addItem(item)) return;
    const waitingVideoState = pendingVideoStates.get(item.id);
    if (waitingVideoState) {
      pendingVideoStates.delete(item.id);
      handleVideoState(waitingVideoState);
    }
    for (const connection of getConnections().values()) {
      if (connection !== pending.connection) sendItem(connection, item);
    }
  }

  function setItemPose(item, x, y, z, rotation, scale) {
    item.x = x;
    item.y = y;
    item.z = z;
    item.rotation.copy(rotation);
    item.yaw = wrapAngle(rotationEuler.setFromQuaternion(rotation).y);
    item.scale = scale;
    item.mesh?.position.set(x, y, z);
    if (item.mesh) {
      item.mesh.quaternion.copy(rotation);
      item.mesh.scale.setScalar(scale);
      item.mesh.updateMatrixWorld(true);
    }
  }

  function setVideoMeshMask(item, active) {
    if (!item?.mesh) return;
    const material = item.mesh.material;
    material.opacity = active ? 0 : 1;
  }

  function broadcastPosition(item) {
    const message = JSON.stringify({
      type: 'world-item-position',
      id: item.id,
      ...poseFields(item),
      holding: item.heldBy === 'local',
    });
    for (const connection of getConnections().values()) {
      const channel = connection.worldItemsChannel;
      if (channel?.readyState === 'open') channel.send(message);
    }
  }

  function videoPosition(state) {
    return Math.min(86_400, state.position + (state.playing
      ? Math.max(0, performance.now() - state.updatedAt) / 1000 : 0));
  }

  function sendVideoState(connection, itemId, state) {
    const channel = connection.worldItemsChannel;
    if (channel?.readyState !== 'open') return;
    channel.send(JSON.stringify({
      type: 'world-item-video', id: itemId, author: state.author, clock: state.clock,
      pulse: state.pulse, playing: state.playing, position: videoPosition(state),
    }));
  }

  function publishVideoState(playing, position) {
    const item = items.get(videoItemId);
    if (!item || !youtubeVideoId(itemUrl(item)) || !Number.isFinite(position)) return;
    const previous = videoStates.get(item.id);
    const state = {
      author: videoAuthor, clock: (previous?.clock || 0) + 1,
      pulse: 0, playing, position: THREE.MathUtils.clamp(position, 0, 86_400),
      updatedAt: performance.now(),
    };
    videoStates.set(item.id, state);
    for (const connection of getConnections().values()) sendVideoState(connection, item.id, state);
    videoBroadcastAt = performance.now();
    lastVideoSample = { position: state.position, at: performance.now(), playing };
  }

  function publishVideoProgress(position) {
    const state = videoStates.get(videoItemId);
    if (!state || state.author !== videoAuthor || !state.playing) return;
    state.position = THREE.MathUtils.clamp(position, 0, 86_400);
    state.updatedAt = performance.now();
    state.pulse += 1;
    for (const connection of getConnections().values()) sendVideoState(connection, videoItemId, state);
    videoBroadcastAt = performance.now();
  }

  function applyVideoState(state) {
    if (!videoReady || !videoPlayer) return;
    const target = videoPosition(state);
    const current = videoPlayer.getCurrentTime();
    if (!Number.isFinite(current) || Math.abs(current - target) > 0.75) {
      videoPlayer.seekTo(target, true);
    }
    const playerState = videoPlayer.getPlayerState();
    if (state.playing && playerState !== 1 && !videoAutoplayBlocked) {
      suppressedVideoState = { playing: true, until: performance.now() + 3000 };
      videoPlayer.playVideo();
    } else if (!state.playing && playerState !== 2) {
      suppressedVideoState = { playing: false, until: performance.now() + 3000 };
      videoPlayer.pauseVideo();
    }
    lastVideoSample = { position: target, at: performance.now(), playing: state.playing };
  }

  function handleVideoState(message) {
    if (typeof message.id !== 'string' || !UUID_PATTERN.test(message.id)
      || typeof message.author !== 'string' || !UUID_PATTERN.test(message.author)
      || !Number.isSafeInteger(message.clock) || message.clock < 1 || message.clock > 1_000_000_000
      || !Number.isSafeInteger(message.pulse) || message.pulse < 0 || message.pulse > 1_000_000_000
      || typeof message.playing !== 'boolean' || !Number.isFinite(message.position)
      || message.position < 0 || message.position > 86_400) return;
    const item = items.get(message.id);
    if (!item) {
      if (pendingVideoStates.size < MAX_ITEM_COUNT || pendingVideoStates.has(message.id)) {
        pendingVideoStates.set(message.id, message);
      }
      return;
    }
    if (!youtubeVideoId(itemUrl(item))) return;
    const previous = videoStates.get(item.id);
    if (previous && (message.clock < previous.clock
      || message.clock === previous.clock && message.author < previous.author
      || message.clock === previous.clock && message.author === previous.author
        && message.pulse <= previous.pulse)) return;
    const state = {
      author: message.author, clock: message.clock, pulse: message.pulse,
      playing: message.playing, position: message.position, updatedAt: performance.now(),
    };
    videoStates.set(item.id, state);
    if (state.playing && videoItemId === null) openVideo(item, true);
    else if (videoItemId === item.id) applyVideoState(state);
  }

  function handlePosition(message, peerId) {
    const item = items.get(message.id) || pendingItems.get(message.id);
    if (!item || ![message.x, message.y, message.z, message.yaw].every(Number.isFinite)
      || !validTransform(message)) return;
    if ([message.x, message.y, message.z].some((value) => Math.abs(value) > 100)) return;
    if (item === grabbedItem) return;
    if (message.holding === true) item.heldBy = peerId;
    else if (message.holding === false && item.heldBy === peerId) item.heldBy = null;
    if (pendingItems.get(message.id) === item) {
      item.x = message.x;
      item.y = message.y;
      item.z = message.z;
      item.yaw = wrapAngle(message.yaw);
      item.rotation = itemRotation(message);
      item.scale = message.scale ?? 1;
      return;
    }
    setItemPose(item, message.x, message.y, message.z, itemRotation(message), message.scale ?? 1);
  }

  function handleStart(connection, message) {
    if (typeof message.id !== 'string' || !UUID_PATTERN.test(message.id)
      || items.has(message.id) || pendingItems.has(message.id)
      || typeof message.name !== 'string' || message.name.length > 256
      || !Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_FILE_SIZE
      || !Number.isInteger(message.chunkCount) || message.chunkCount !== Math.ceil(message.size / CHUNK_SIZE)
      || ![message.x, message.y, message.z, message.yaw].every(Number.isFinite)
      || !validTransform(message)
      || [message.x, message.y, message.z].some((value) => Math.abs(value) > 100)) return;
    if (items.size + pendingItems.size >= MAX_ITEM_COUNT
      || totalBytes + pendingBytes + message.size > MAX_TOTAL_BYTES) return;

    const item = {
      id: message.id,
      name: cleanFileName(message.name),
      mimeType: cleanMimeType(message.mimeType),
      size: message.size,
      x: message.x,
      y: message.y,
      z: message.z,
      yaw: wrapAngle(message.yaw),
      rotation: itemRotation(message),
      scale: message.scale ?? 1,
      heldBy: null,
      bytes: new Uint8Array(message.size),
      nextChunk: 0,
      connection,
      timeout: null,
    };
    if (!message.size) {
      addIncomingItem(item);
      return;
    }
    item.timeout = setTimeout(() => discardPending(item.id), TRANSFER_TIMEOUT_MS);
    pendingItems.set(item.id, item);
    pendingBytes += item.size;
  }

  function handleChunk(connection, message) {
    const pending = pendingItems.get(message.id);
    if (!pending || pending.connection !== connection || !Number.isInteger(message.index)
      || message.index !== pending.nextChunk || typeof message.data !== 'string') return;
    try {
      const chunk = base64ToBytes(message.data);
      const expectedLength = Math.min(CHUNK_SIZE, pending.size - message.index * CHUNK_SIZE);
      if (!expectedLength || chunk.length !== expectedLength) return;
      pending.bytes.set(chunk, message.index * CHUNK_SIZE);
      pending.nextChunk += 1;
      if (pending.nextChunk === Math.ceil(pending.size / CHUNK_SIZE)) addIncomingItem(pending);
    } catch {
      discardPending(pending.id);
    }
  }

  async function fetchIpfsBytes(cid, expectedSize) {
    const config = await getIpfsConfig();
    const gateways = Array.isArray(config?.gateways)
      ? config.gateways.filter((gateway) => typeof gateway === 'string'
        && /^https:\/\//i.test(gateway) && gateway.endsWith('/ipfs/'))
      : [];
    if (!gateways.length) throw new Error('IPFSゲートウェイが設定されていません。');
    const startIndex = (gatewaySeed + gatewayCursor++) % gateways.length;
    let lastError;
    for (let attempt = 0; attempt < gateways.length; attempt += 1) {
      const gateway = gateways[(startIndex + attempt) % gateways.length];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${gateway}${cid}`, {
          cache: 'force-cache',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`IPFS gateway returned ${response.status}`);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE) {
          throw new Error('IPFSファイルが上限を超えています。');
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== expectedSize) throw new Error('IPFSファイルのサイズが一致しません。');
        return bytes;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('IPFSファイルを取得できませんでした。');
  }

  function handleIpfsStart(connection, message) {
    if (typeof message.id !== 'string' || !UUID_PATTERN.test(message.id)
      || items.has(message.id) || pendingItems.has(message.id)
      || typeof message.name !== 'string' || message.name.length > 256
      || typeof message.cid !== 'string' || !CID_V1_PATTERN.test(message.cid)
      || !Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_FILE_SIZE
      || ![message.x, message.y, message.z, message.yaw].every(Number.isFinite)
      || !validTransform(message)
      || [message.x, message.y, message.z].some((value) => Math.abs(value) > 100)) return;
    if (items.size + pendingItems.size >= MAX_ITEM_COUNT
      || totalBytes + pendingBytes + message.size > MAX_TOTAL_BYTES) return;

    const pending = {
      id: message.id,
      name: cleanFileName(message.name),
      mimeType: cleanMimeType(message.mimeType),
      size: message.size,
      cid: message.cid,
      x: message.x,
      y: message.y,
      z: message.z,
      yaw: wrapAngle(message.yaw),
      rotation: itemRotation(message),
      scale: message.scale ?? 1,
      heldBy: null,
      bytes: null,
      connection,
      timeout: setTimeout(() => discardPending(message.id), TRANSFER_TIMEOUT_MS),
    };
    pendingItems.set(pending.id, pending);
    pendingBytes += pending.size;
    void fetchIpfsBytes(pending.cid, pending.size).then((bytes) => {
      if (pendingItems.get(pending.id) !== pending) return;
      pending.bytes = bytes;
      addIncomingItem(pending);
    }).catch(() => {
      if (pendingItems.get(pending.id) !== pending) return;
      discardPending(pending.id);
      const channel = connection.worldItemsChannel;
      if (channel?.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'world-item-ipfs-fallback', id: pending.id }));
      }
      toast('共有データを取得できなかったため、別の転送方法に切り替えます。');
    });
  }

  function sendP2pFallback(connection, message) {
    if (typeof message.id !== 'string' || !UUID_PATTERN.test(message.id)) return;
    const item = items.get(message.id);
    if (!item || !item.bytes || item.bytes.byteLength !== item.size) return;
    const channel = connection.worldItemsChannel;
    if (channel?.readyState !== 'open') return;
    const chunkCount = Math.ceil(item.bytes.length / CHUNK_SIZE);
    channel.send(JSON.stringify({
      type: 'world-item-start',
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      ...poseFields(item),
      chunkCount,
    }));
    for (let index = 0; index < chunkCount; index += 1) {
      const offset = index * CHUNK_SIZE;
      const data = bytesToBase64(item.bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, item.bytes.length)));
      channel.send(JSON.stringify({ type: 'world-item-chunk', id: item.id, index, data }));
    }
  }

  function attachChannel(peerId, connection, channel) {
    if (getConnections().get(peerId) !== connection
      || (connection.worldItemsChannel && connection.worldItemsChannel !== channel
        && connection.worldItemsChannel.readyState !== 'closed')) {
      channel.close();
      return;
    }
    connection.worldItemsPeerId = peerId;
    connection.worldItemsChannel = channel;
    channel.onopen = () => {
      if (getConnections().get(peerId) !== connection) return;
      for (const item of items.values()) {
        sendItem(connection, item);
        const state = videoStates.get(item.id);
        if (state) sendVideoState(connection, item.id, state);
      }
    };
    channel.onmessage = (event) => {
      if (getConnections().get(peerId) !== connection || typeof event.data !== 'string'
        || event.data.length > MAX_MESSAGE_LENGTH) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'world-item-start') handleStart(connection, message);
      else if (message.type === 'world-item-chunk') handleChunk(connection, message);
      else if (message.type === 'world-item-position') handlePosition(message, peerId);
      else if (message.type === 'world-item-ipfs') handleIpfsStart(connection, message);
      else if (message.type === 'world-item-ipfs-fallback') sendP2pFallback(connection, message);
      else if (message.type === 'world-item-video') handleVideoState(message);
    };
    channel.onclose = () => discardConnectionTransfers(connection);
    channel.onerror = () => toast('データアイテムの同期に失敗しました。');
    if (channel.readyState === 'open') channel.onopen();
  }

  function getViewAnchor() {
    const pose = getPlayerPose();
    playerEye.set(pose.x, pose.y, pose.z);
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(viewDirection);
    viewRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    return pose;
  }

  function captureViewAnchor() {
    const pose = getViewAnchor();
    return {
      pose,
      origin: playerEye.clone(),
      direction: viewDirection.clone(),
      right: viewRight.clone(),
    };
  }

  function getDropPosition(anchor, lateralOffset = 0) {
    const forwardDistance = Math.sqrt(Math.max(0, 1 - lateralOffset * lateralOffset));
    worldPoint.copy(anchor.origin)
      .addScaledVector(anchor.direction, forwardDistance)
      .addScaledVector(anchor.right, lateralOffset);
    return {
      x: worldPoint.x,
      y: worldPoint.y,
      z: worldPoint.z,
      yaw: anchor.pose.yaw,
    };
  }

  async function uploadToIpfs(file) {
    const ticketResponse = await fetch('/ipfs-upload-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    const ticket = await ticketResponse.json().catch(() => null);
    if (!ticketResponse.ok || typeof ticket?.url !== 'string') {
      throw new Error(ticket?.error || 'アップロードURLを取得できませんでした。');
    }
    const url = new URL(ticket.url);
    if (url.protocol !== 'https:' || url.hostname !== 'uploads.pinata.cloud') {
      throw new Error('IPFSアップロードURLが無効です。');
    }
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('network', 'public');
    const response = await fetch(url, { method: 'POST', body: form });
    const result = await response.json().catch(() => null);
    const cid = result?.data?.cid;
    if (!response.ok || typeof cid !== 'string' || !CID_V1_PATTERN.test(cid)) {
      throw new Error(result?.error || 'IPFSへの保存に失敗しました。');
    }
    return cid;
  }

  async function addDroppedFiles(files, anchor) {
    let added = 0;
    const ipfsConfig = await getIpfsConfig();
    const spreadCount = Math.min(files.length, MAX_ITEM_COUNT);
    for (const [index, file] of files.entries()) {
      if (file.size > MAX_FILE_SIZE) {
        toast(`${cleanFileName(file.name)} は1ファイル5MBを超えています。`);
        continue;
      }
      if (items.size + pendingItems.size >= MAX_ITEM_COUNT) {
        toast('データアイテムは最大16件です。');
        break;
      }
      if (totalBytes + pendingBytes + file.size > MAX_TOTAL_BYTES) {
        toast('データアイテムは合計20MBまでです。');
        continue;
      }
      try {
        if (items.size + pendingItems.size >= MAX_ITEM_COUNT
          || totalBytes + pendingBytes + file.size > MAX_TOTAL_BYTES) {
          toast('データアイテムの合計上限に達しました。');
          continue;
        }
        const lateralOffset = spreadCount > 1
          ? THREE.MathUtils.clamp((index - (spreadCount - 1) / 2) * 0.3, -0.85, 0.85)
          : 0;
        const position = getDropPosition(anchor, lateralOffset);
        let cid = null;
        if (ipfsConfig.enabled) {
          try {
            cid = await uploadToIpfs(file);
          } catch {
            toast(`${cleanFileName(file.name)} を保存できませんでした。`);
            continue;
          }
        }
        const item = {
          id: crypto.randomUUID(),
          name: cleanFileName(file.name),
          mimeType: cleanMimeType(file.type),
          size: file.size,
          cid,
          x: position.x,
          y: position.y,
          z: position.z,
          yaw: position.yaw,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
        if (!addItem(item)) {
          toast('データアイテムの合計上限に達しました。');
          continue;
        }
        broadcastItem(item);
        added += 1;
      } catch {
        toast(`${cleanFileName(file.name)} を読み込めませんでした。`);
      }
    }
    if (added) {
      toast(isRoomJoined()
        ? `${added}件を配置し、ルーム参加者に共有しました。`
        : `${added}件を配置しました。ルーム参加中は参加者にも共有されます。`);
    }
  }

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  function onDragEnter(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth += 1;
    dropHint.hidden = false;
  }

  function onDragOver(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dropHint.hidden = false;
  }

  function onDragLeave(event) {
    if (!hasFiles(event)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) dropHint.hidden = true;
  }

  function onDrop(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth = 0;
    dropHint.hidden = true;
    const files = Array.from(event.dataTransfer.files || []);
    if (!files.length) return;
    const anchor = captureViewAnchor();
    dropQueue = dropQueue
      .then(() => addDroppedFiles(files, anchor))
      .catch(() => toast('ドロップしたファイルを処理できませんでした。'));
  }

  function onPaste(event) {
    if (document.pointerLockElement !== canvas || !event.clipboardData) return;
    const images = Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    let files = images;
    if (!files.length) {
      const url = normalizeWebUrl(event.clipboardData.getData('text/plain'));
      if (!url) return;
      files = [new File([url], `url-${new URL(url).hostname}.txt`, { type: 'text/uri-list' })];
    }
    event.preventDefault();
    const anchor = captureViewAnchor();
    dropQueue = dropQueue
      .then(() => addDroppedFiles(files, anchor))
      .catch(() => toast('貼り付けたデータを配置できませんでした。'));
  }

  function pickItem(event) {
    const bounds = canvas.getBoundingClientRect();
    if (document.pointerLockElement === canvas) pointer.set(0, 0);
    else {
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
    }
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    const meshes = [...items.values()].map((item) => item.mesh).filter(Boolean);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? items.get(hit.object.userData.worldItemId) : null;
  }

  function onMouseDown(event) {
    if (event.button === 0 && grabbedItem) {
      event.preventDefault();
      const url = itemUrl(grabbedItem);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      getViewAnchor();
      grabWorldRotation.setFromAxisAngle(worldUp, grabbedItem.yaw);
      grabRotation.copy(camera.quaternion).invert().multiply(grabWorldRotation);
      update(performance.now());
      return;
    }
    if (event.button === 0) {
      const item = pickItem(event);
      if (youtubeVideoId(itemUrl(item))) {
        event.preventDefault();
        openVideo(item, false);
        return;
      }
    }
    if (event.button !== 2) return;
    event.preventDefault();
    grabbedItem = pickItem(event) || null;
    if (!grabbedItem) return;
    grabbedItem.heldBy = 'local';
    getViewAnchor();
    grabWorldRotation.copy(camera.quaternion).invert();
    grabOffset.set(grabbedItem.x, grabbedItem.y, grabbedItem.z)
      .sub(playerEye).applyQuaternion(grabWorldRotation);
    if (grabOffset.lengthSq() < 0.0001) grabOffset.set(0, 0, -MIN_GRAB_DISTANCE);
    grabRotation.copy(grabWorldRotation).multiply(grabbedItem.rotation);
    broadcastPosition(grabbedItem);
  }

  function onMouseUp(event) {
    if (event.button !== 2 || !grabbedItem) return;
    const releasedItem = grabbedItem;
    grabbedItem = null;
    rotateHeld = false;
    releasedItem.heldBy = null;
    broadcastPosition(releasedItem);
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  function releaseGrab() {
    if (!grabbedItem) return;
    const releasedItem = grabbedItem;
    grabbedItem = null;
    rotateHeld = false;
    releasedItem.heldBy = null;
    broadcastPosition(releasedItem);
  }

  function onWheel(event) {
    if (!grabbedItem && event.shiftKey && videoReady && videoPlayer
      && document.pointerLockElement === canvas && pickItem(event)?.id === videoItemId) {
      event.preventDefault();
      const current = videoPlayer.getCurrentTime();
      const duration = videoPlayer.getDuration() || 86_400;
      const target = THREE.MathUtils.clamp(current + Math.sign(event.deltaY) * 5, 0, duration);
      const playing = videoPlayer.getPlayerState() === 1;
      suppressedVideoState = { playing, until: performance.now() + 3000 };
      videoPlayer.seekTo(target, true);
      publishVideoState(playing, target);
      return;
    }
    if (!grabbedItem) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const wheelDelta = event.shiftKey && !event.deltaY ? event.deltaX : event.deltaY;
    const delta = THREE.MathUtils.clamp(wheelDelta * unit, -500, 500);
    if (event.shiftKey) {
      grabbedItem.scale = THREE.MathUtils.clamp(
        grabbedItem.scale * Math.exp(-delta * 0.001), MIN_ITEM_SCALE, MAX_ITEM_SCALE,
      );
    } else {
      const distance = THREE.MathUtils.clamp(
        grabOffset.length() * Math.exp(-delta * 0.001), MIN_GRAB_DISTANCE, MAX_GRAB_DISTANCE,
      );
      grabOffset.setLength(distance);
    }
    update(performance.now());
  }

  function rotateGrabbed(movementX, movementY) {
    if (!grabbedItem || !rotateHeld || document.pointerLockElement !== canvas) return false;
    rotationStep.setFromEuler(rotationEuler.set(-movementY * 0.005, -movementX * 0.005, 0));
    grabRotation.premultiply(rotationStep).normalize();
    update(performance.now());
    return true;
  }

  function onKeyDown(event) {
    if (event.key.toLowerCase() !== 'e' || !grabbedItem
      || document.pointerLockElement !== canvas) return;
    event.preventDefault();
    rotateHeld = true;
  }

  function onKeyUp(event) {
    if (event.key.toLowerCase() === 'e') rotateHeld = false;
  }

  function loadYoutubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => reject(new Error('YouTube API timeout')), 12000);
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        resolve(window.YT);
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('YouTube API unavailable'));
      };
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.append(script);
    }).catch((error) => {
      youtubeApiPromise = null;
      throw error;
    });
    return youtubeApiPromise;
  }

  async function openVideo(item, remote) {
    const videoId = youtubeVideoId(itemUrl(item));
    if (!videoId) return;
    if (videoItemId === item.id) {
      if (remote) {
        const state = videoStates.get(item.id);
        if (state) applyVideoState(state);
      } else if (!videoReady) {
        videoPendingPlay = !videoPendingPlay;
      } else {
        videoAutoplayBlocked = false;
        const playerState = videoPlayer.getPlayerState();
        const playing = playerState === 1;
        const current = playerState === 0 ? 0 : videoPlayer.getCurrentTime();
        suppressedVideoState = { playing: !playing, until: performance.now() + 3000 };
        if (playing) videoPlayer.pauseVideo();
        else {
          if (playerState === 0) videoPlayer.seekTo(0, true);
          videoPlayer.playVideo();
        }
        publishVideoState(!playing, current);
      }
      return;
    }
    closeVideo();
    const token = ++videoOpenToken;
    videoItemId = item.id;
    videoPendingPlay = !remote;
    videoAutoplayBlocked = false;
    videoObject = new CSS3DObject(videoSurface);
    cssScene.add(videoObject);
    setVideoMeshMask(item, true);
    updateVideoSurface(item);
    try {
      const YT = await loadYoutubeApi();
      if (token !== videoOpenToken || videoItemId !== item.id) return;
      const frame = document.createElement('iframe');
      frame.title = 'YouTube動画';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; web-share';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&playsinline=1&controls=0&fs=0&origin=${encodeURIComponent(location.origin)}`;
      videoContainer.replaceChildren(frame);
      videoPlayer = new YT.Player(frame, {
        events: {
          onReady: () => {
            if (token !== videoOpenToken) return;
            videoReady = true;
            const state = videoStates.get(item.id);
            if (state && videoPendingPlay && !state.playing) {
              videoPlayer.seekTo(videoPosition(state), true);
              suppressedVideoState = null;
              videoPlayer.playVideo();
            } else if (state) applyVideoState(state);
            else if (videoPendingPlay) videoPlayer.playVideo();
          },
          onStateChange: (event) => {
            if (token !== videoOpenToken || !videoReady || ![0, 1, 2].includes(event.data)) return;
            const playing = event.data === 1;
            if (playing) videoAutoplayBlocked = false;
            if (suppressedVideoState && performance.now() < suppressedVideoState.until) {
              if (suppressedVideoState.playing === playing) suppressedVideoState = null;
              return;
            }
            suppressedVideoState = null;
            publishVideoState(playing, videoPlayer.getCurrentTime());
          },
          onAutoplayBlocked: () => {
            if (token !== videoOpenToken) return;
            videoAutoplayBlocked = true;
            suppressedVideoState = null;
            if (videoStates.get(item.id)?.author === videoAuthor
              && videoStates.get(item.id)?.playing) {
              publishVideoState(false, videoPlayer.getCurrentTime());
            }
            toast('自動再生が制限されました。動画カードをクリックして再生してください。');
          },
        },
      });
    } catch {
      if (token === videoOpenToken) {
        toast('YouTubeプレイヤーを読み込めませんでした。');
        closeVideo(false);
      }
    }
  }

  function closeVideo(pauseOwned = true) {
    if (videoItemId === null) return;
    if (pauseOwned && videoReady && videoPlayer && videoStates.get(videoItemId)?.author === videoAuthor
      && videoStates.get(videoItemId)?.playing) {
      publishVideoState(false, videoPlayer.getCurrentTime());
    }
    const item = items.get(videoItemId);
    setVideoMeshMask(item, false);
    videoOpenToken += 1;
    videoReady = false;
    videoPendingPlay = false;
    videoAutoplayBlocked = false;
    videoItemId = null;
    suppressedVideoState = null;
    lastVideoSample = null;
    videoPlayer?.destroy();
    videoPlayer = null;
    videoContainer.replaceChildren();
    if (videoObject) cssScene.remove(videoObject);
    videoObject = null;
    canvas.focus({ preventScroll: true });
  }

  function onVideoKeyDown(event) {
    if (event.key === 'Escape' && videoItemId !== null) closeVideo();
  }

  function updateVideoSurface(item) {
    if (!videoObject || !item || item.id !== videoItemId) return;
    videoObject.position.set(item.x, item.y, item.z)
      .addScaledVector(videoNormal.set(0, 0, 1).applyQuaternion(item.rotation), 0.006);
    videoObject.quaternion.copy(item.rotation);
    videoObject.scale.setScalar(item.scale * (2 / 960));
    const floorY = -0.02;
    const heightDifference = item.y - camera.position.y;
    const crossing = Math.abs(heightDifference) > 0.0001
      ? (floorY - camera.position.y) / heightDifference : -1;
    const crossesFloor = crossing > 0 && crossing < 1
      && Math.abs(camera.position.x + (item.x - camera.position.x) * crossing) <= 5
      && Math.abs(camera.position.z + (item.z - camera.position.z) * crossing) <= 5;
    videoSurface.style.visibility = crossesFloor ? 'hidden' : 'visible';
  }

  function update(now) {
    if (videoReady && videoPlayer && videoItemId && now - videoPollAt >= VIDEO_POLL_INTERVAL_MS) {
      videoPollAt = now;
      const current = videoPlayer.getCurrentTime();
      const playerState = videoPlayer.getPlayerState();
      const playing = playerState === 1;
      const shared = videoStates.get(videoItemId);
      if (Number.isFinite(current) && (playing || playerState === 2) && shared) {
        const sample = lastVideoSample;
        const expectedStep = sample?.playing ? (now - sample.at) / 1000 : 0;
        const jumped = sample && Math.abs(current - sample.position - expectedStep) > 1.5;
        if (jumped && !suppressedVideoState) publishVideoState(playing, current);
        else if (shared.author === videoAuthor && playing
          && now - videoBroadcastAt >= VIDEO_SYNC_INTERVAL_MS) publishVideoProgress(current);
        else if (shared.author !== videoAuthor && playing
          && Math.abs(current - videoPosition(shared)) > 2.5) {
          videoPlayer.seekTo(videoPosition(shared), true);
        }
        lastVideoSample = { position: current, at: now, playing };
      }
    }
    if (grabbedItem && items.get(grabbedItem.id) === grabbedItem) {
      getViewAnchor();
      worldPoint.copy(grabOffset).applyQuaternion(camera.quaternion).add(playerEye);
      grabWorldRotation.copy(camera.quaternion).multiply(grabRotation);
      setItemPose(grabbedItem, worldPoint.x, worldPoint.y, worldPoint.z,
        grabWorldRotation, grabbedItem.scale);
      if (now - lastPositionBroadcast >= 50) {
        broadcastPosition(grabbedItem);
        lastPositionBroadcast = now;
      }
    }
    if (videoItemId !== null) updateVideoSurface(items.get(videoItemId));
    for (const item of items.values()) {
      if (!item.tether) continue;
      item.outline.visible = Boolean(item.heldBy);
      if (!item.heldBy) {
        item.tether.visible = false;
        continue;
      }
      if (item.heldBy === 'local') {
        const pose = getPlayerPose();
        lineOrigin.set(pose.x, pose.y, pose.z);
      } else if (!getRemoteEye(item.heldBy, lineOrigin)) {
        item.tether.visible = false;
        continue;
      }
      const points = item.tether.geometry.attributes.position;
      points.setXYZ(0, lineOrigin.x, lineOrigin.y, lineOrigin.z);
      points.setXYZ(1, item.x, item.y, item.z);
      points.needsUpdate = true;
      item.tether.visible = true;
    }
  }

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('keydown', onVideoKeyDown);
  window.addEventListener('blur', releaseGrab);

  return {
    attachChannel,
    closeConnection: discardConnectionTransfers,
    clear,
    update,
    rotateGrabbed,
  };
}
