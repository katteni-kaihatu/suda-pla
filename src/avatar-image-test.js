import * as THREE from 'three';
import './avatar-image-test.css';

const width = 320;
const height = 480;
const source = document.createElement('canvas');
source.width = width;
source.height = height;
const renderer = new THREE.WebGLRenderer({
  canvas: source,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'low-power',
});
renderer.setPixelRatio(1);
renderer.setSize(width, height, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor('#00ff00', 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#00ff00');
scene.add(new THREE.HemisphereLight('#ffffff', '#8b9498', 2.5));
const key = new THREE.DirectionalLight('#fff1d8', 2.4);
key.position.set(-3, 6, 4);
scene.add(key);

const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 20);
camera.position.set(2.65, 2.0, 4.4);
camera.lookAt(0, 0.98, 0);

const avatar = new THREE.Group();
scene.add(avatar);
const material = (color, roughness = 0.82) => new THREE.MeshStandardMaterial({ color, roughness, flatShading: true });
const skin = material('#efc7a4');
const shirt = material('#dc8064');
const pants = material('#526f82');
const hair = material('#584839');
const shoes = material('#41474a');
const sphere = new THREE.SphereGeometry(1, 18, 14);
const capsule = new THREE.CapsuleGeometry(0.2, 0.45, 3, 8);

function addPart(geometry, mat, position, scale, rotationZ = 0) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.z = rotationZ;
  avatar.add(mesh);
  return mesh;
}

addPart(capsule, shirt, [0, 0.84, 0], [1.1, 1.0, 0.68]);
addPart(sphere, skin, [0, 1.55, -0.015], [0.31, 0.34, 0.3]);
addPart(sphere, hair, [0, 1.72, 0.005], [0.32, 0.2, 0.32]);
for (const x of [-0.105, 0.105]) addPart(sphere, shoes, [x, 1.57, -0.285], [0.035, 0.045, 0.018]);
addPart(new THREE.BoxGeometry(0.09, 0.018, 0.018), shoes, [0, 1.46, -0.294], [1, 1, 1]);
for (const x of [-0.29, 0.29]) addPart(capsule, shirt, [x, 0.92, -0.005], [0.48, 0.83, 0.5], x < 0 ? -0.15 : 0.15);
for (const x of [-0.13, 0.13]) {
  addPart(capsule, pants, [x, 0.32, 0], [0.52, 0.82, 0.58]);
  addPart(new THREE.BoxGeometry(0.2, 0.1, 0.34), shoes, [x, 0.055, -0.055], [1, 1, 1]);
}

const outCanvas = document.querySelector('#output');
const outContext = outCanvas.getContext('2d', { willReadFrequently: true });
const status = document.querySelector('#status');

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function renderOutput() {
  renderer.render(scene, camera);
  outContext.clearRect(0, 0, width, height);
  outContext.drawImage(source, 0, 0, width, height);
  const image = outContext.getImageData(0, 0, width, height);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];
    const excessGreen = Math.max(green - Math.max(red, blue), 0) / 255;
    let alpha = 1 - smoothstep(0.08, 0.28, excessGreen);
    if (alpha < 0.025) alpha = 0;
    if (alpha > 0 && alpha < 1) {
      pixels[i] = Math.min(255, Math.max(0, red / alpha));
      pixels[i + 1] = Math.min(255, Math.max(0, (green - (1 - alpha) * 255) / alpha));
      pixels[i + 2] = Math.min(255, Math.max(0, blue / alpha));
    }
    pixels[i + 3] = Math.round(alpha * 255);
  }
  outContext.putImageData(image, 0, 0);
  status.textContent = 'レンダー画像を表示中';
}

document.querySelector('#save').addEventListener('click', () => {
  outCanvas.toBlob((blob) => {
    if (!blob) {
      status.textContent = 'PNGを書き出せませんでした';
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'avatar-render.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    status.textContent = 'avatar-render.png を保存しました';
  }, 'image/png');
});

renderOutput();
if (new URLSearchParams(location.search).has('capture')) {
  setTimeout(() => {
    const base64 = outCanvas.toDataURL('image/png').split(',')[1];
    document.body.innerHTML = `<pre id="image-payload">${base64}</pre>`;
  }, 100);
}
