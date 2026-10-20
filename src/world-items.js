import * as THREE from 'three';

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

function createUrlCanvas(item) {
  if (item.bytes.length > MAX_URL_LENGTH * 4) return null;
  const url = normalizeWebUrl(new TextDecoder().decode(item.bytes));
  if (!url) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.font = '600 42px "Yu Gothic UI", sans-serif';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 10;
  context.strokeStyle = '#ffffffee';
  context.fillStyle = '#244a3a';
  const characters = Array.from(url);
  const lines = [];
  let line = '';
  for (const character of characters) {
    if (line && context.measureText(line + character).width > 924) {
      lines.push(line);
      line = '';
      if (lines.length === 3) break;
    }
    line += character;
  }
  if (line && lines.length < 3) lines.push(line);
  if (lines.join('').length < characters.length && lines.length) {
    let last = lines.at(-1);
    while (last && context.measureText(`${last}…`).width > 924) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  const lineHeight = 60;
  const top = (canvas.height - lines.length * lineHeight) / 2 + lineHeight / 2;
  lines.forEach((text, index) => {
    const y = top + index * lineHeight;
    context.strokeText(text, 50, y);
    context.fillText(text, 50, y);
  });
  return { canvas, width: 2, height: 0.5 };
}

async function createItemCanvas(item) {
  if (item.mimeType === 'text/uri-list' && item.bytes.length) {
    return createUrlCanvas(item) || createFileCardCanvas(item);
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

export function createWorldItemSystem({ scene, camera, canvas, getConnections, getPlayerPose, getRemoteEye, getIpfsConfig, isRoomJoined, toast }) {
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
  const rotationStep = new THREE.Quaternion();
  const rotationEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const dropHint = document.querySelector('#drop-hint');
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
            vec2 pixelX = dFdx(itemUv);
            vec2 pixelY = dFdy(itemUv);
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
      for (const item of items.values()) sendItem(connection, item);
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
      getViewAnchor();
      grabWorldRotation.setFromAxisAngle(worldUp, grabbedItem.yaw);
      grabRotation.copy(camera.quaternion).invert().multiply(grabWorldRotation);
      update(performance.now());
      return;
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

  function update(now) {
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
  window.addEventListener('blur', releaseGrab);

  return {
    attachChannel,
    closeConnection: discardConnectionTransfers,
    clear,
    update,
    rotateGrabbed,
  };
}
