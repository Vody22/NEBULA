// Hangar viewer: one ship under the game's own lights, sky reflections and
// post-processing. Orbit with the mouse; ?ship=falcon|warden|raider|marauder,
// ?view=hero|side|rear|top|front|cockpit|belly, ?clean hides the interface.
// Also used by scripts/ship-capture.mjs and to export a ship as GLB.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ShipView } from './client/render/ShipView';
import { buildSky } from './client/render/Sky';
import { PostFX } from './client/render/PostFX';
import { SHIP_CLASSES } from './shared/sim/shipClasses';
import type { ShipClassId } from './shared/sim/types';

const params = new URLSearchParams(location.search);
if (params.has('clean')) document.body.classList.add('clean');
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 250000);
// Same light rig as Game.buildWorld (zone 0 sun direction).
const sunDir = new THREE.Vector3(-0.8, 0.35, 0.12).normalize();
const sun = new THREE.DirectionalLight(0xfff0dc, 4.2);
sun.position.copy(sunDir).multiplyScalar(100);
const rim = new THREE.DirectionalLight(0x7d9cff, 0.32);
rim.position.copy(sunDir).multiplyScalar(-100).add(new THREE.Vector3(0, 40, 0));
scene.add(sun, rim, new THREE.HemisphereLight(0x6f86b0, 0x0c0a12, 0.07));
const sky = buildSky(renderer, sunDir, 1024);
scene.background = sky.background;
scene.environment = sky.environment;
scene.environmentIntensity = 0.55;
scene.add(sky.sun);

const post = params.has('direct') ? null : new PostFX(renderer, scene, camera, 4);
post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

let classId = (params.get('ship') as ShipClassId) || 'falcon';
let view: ShipView | null = null;
let angular: [number, number, number] = [0, 0, 0];
let throttle = 0.5;

function load(id: ShipClassId) {
  view?.dispose(scene);
  classId = id;
  view = new ShipView(id, scene, false);
  stats();
}

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  hero: { pos: [-15, 6, -20], target: [0, 0, 0], fov: 40 },
  side: { pos: [-30, 1.5, 0], target: [0, 0, 0], fov: 38 },
  rear: { pos: [-9, 4, 24], target: [0, 0, 1], fov: 40 },
  top: { pos: [0, 34, 0.01], target: [0, 0, 0], fov: 40 },
  front: { pos: [6, 2, -24], target: [0, 0, -1], fov: 40 },
  cockpit: { pos: [-3.2, 2.6, -6.2], target: [0, 1.1, -3.2], fov: 45 },
  belly: { pos: [-12, -9, -10], target: [0, 0, 0], fov: 40 },
};
function setView(name: string) {
  const v = VIEWS[name] ?? VIEWS.hero;
  // The views frame an 11 m shield (Falcon); scale them to the ship.
  const s = name === 'cockpit' || !view ? 1 : view.model.shieldScale.z / 11;
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.position.set(...v.pos).multiplyScalar(s);
  controls.target.set(...v.target).multiplyScalar(s);
  controls.update();
}

function stats() {
  if (!view) return;
  let tris = 0;
  let meshes = 0;
  const mats = new Set<THREE.Material>();
  view.model.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      meshes++;
      mats.add(o.material as THREE.Material);
      const g = o.geometry as THREE.BufferGeometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
  });
  const info = { classId, triangles: Math.round(tris), drawCalls: meshes, materials: mats.size, muzzle: muzzleError() };
  (document.getElementById('stats') as HTMLElement).textContent =
    `${classId} · ${info.triangles} triangles · ${info.drawCalls} appels de dessin (coque) · ${info.materials} matériaux · canons à ${info.muzzle.offset} m des points de tir`;
  return info;
}

/**
 * Bolts leave from the simulation's hardpoints, so each one must sit on the
 * axis of a gun, at its muzzle: the vertices within 25 cm of the hardpoint's
 * z plane and 60 cm of it are averaged. Returns the worst sideways offset and
 * the worst distance from the hardpoint to the front of the barrel, in metres
 * (Infinity when a hardpoint has no gun).
 */
function muzzleError() {
  if (!view) return { offset: Infinity, depth: Infinity };
  const root = view.model.root;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  let offset = 0;
  let depth = 0;
  for (const [hx, hy, hz] of SHIP_CLASSES[classId].weapon.hardpoints) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    let front = Infinity;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      m.multiplyMatrices(toRoot, o.matrixWorld);
      const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (Math.abs(v.z - hz) < 0.25 && Math.hypot(v.x - hx, v.y - hy) < 0.6) {
          sx += v.x;
          sy += v.y;
          n++;
          front = Math.min(front, v.z);
        }
      }
    });
    offset = Math.max(offset, n ? Math.hypot(sx / n - hx, sy / n - hy) : Infinity);
    depth = Math.max(depth, Math.abs(front - hz));
  }
  const mm = (x: number) => Math.round(x * 1000) / 1000;
  return { offset: mm(offset), depth: mm(depth) };
}

async function exportGlb(): Promise<ArrayBuffer> {
  if (!view) throw new Error('no ship');
  const root = view.model.root.clone();
  return (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
}

const ui = document.getElementById('ui')!;
const select = document.createElement('select');
for (const id of ['falcon', 'warden', 'raider', 'marauder']) select.add(new Option(id, id, id === classId, id === classId));
select.onchange = () => load(select.value as ShipClassId);
ui.append(select);
for (const name of Object.keys(VIEWS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => setView(name);
  ui.append(b);
}
const rcsBtn = document.createElement('button');
rcsBtn.textContent = 'RCS';
rcsBtn.onclick = () => (angular = angular[0] ? [0, 0, 0] : [0.9, 0.5, 0.7]);
const glbBtn = document.createElement('button');
glbBtn.textContent = 'Exporter GLB';
glbBtn.onclick = async () => {
  const buf = await exportGlb();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  a.download = `${classId}.glb`;
  a.click();
};
ui.append(rcsBtn, glbBtn);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
});

let frames = 0;
let time = 0;
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  time += dt;
  controls.update();
  view?.update(dt, time, throttle, false, camera.position, angular);
  sky.update(camera);
  if (post) post.render(time, 0);
  else renderer.render(scene, camera);
  frames++;
  requestAnimationFrame(frame);
}

load(classId);
setView(params.get('view') ?? 'hero');
frame();

// Script hooks (captures, GLB export).
(window as unknown as { __hangar: unknown }).__hangar = {
  load,
  setView,
  stats,
  get frames() {
    return frames;
  },
  set throttle(v: number) {
    throttle = v;
  },
  set angular(v: [number, number, number]) {
    angular = v;
  },
  place(pos: [number, number, number], target: [number, number, number], fov = 40) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.position.set(...pos);
    controls.target.set(...target);
    controls.update();
  },
  async exportGlbBase64() {
    const buf = new Uint8Array(await exportGlb());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
};
