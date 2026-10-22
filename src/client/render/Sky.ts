import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { NOISE_GLSL } from './glsl';
import { makeFlareRing, makeRadialTexture } from './textures';
import { mulberry32 } from '../../shared/rng';

const GALACTIC_NORTH = new THREE.Vector3(0.25, 0.92, 0.3).normalize();
/** Direction of the system's luminous nebula core (seen from the station toward +Z). */
const NEBULA_CORE = new THREE.Vector3(0.32, 0.38, 0.87).normalize();
const STAR_DISTANCE = 120000;

// Spectral classes of naked-eye stars: colour and share of the population.
const SPECTRAL: [THREE.Color, number][] = [
  [new THREE.Color(0.62, 0.72, 1.0), 0.08], // O, B
  [new THREE.Color(0.85, 0.9, 1.0), 0.2], // A
  [new THREE.Color(1.0, 0.98, 0.93), 0.2], // F
  [new THREE.Color(1.0, 0.91, 0.74), 0.2], // G
  [new THREE.Color(1.0, 0.76, 0.5), 0.24], // K
  [new THREE.Color(1.0, 0.58, 0.4), 0.08], // M
];

const starVert = /* glsl */ `
attribute float aSize;
attribute vec3 color;
uniform float uScale;
varying vec3 vColor;
void main(){
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale;
}`;
const starFrag = /* glsl */ `
varying vec3 vColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  // Sharp core with a faint static glint: a few pixels, never a blur.
  float a = exp(-r2 * 9.0) + exp(-r2 * 2.5) * 0.12;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

/**
 * Bright stars as live points at a fixed distance around the camera: they stay
 * pin-sharp at any resolution, unlike stars baked into the sky cubemap.
 */
function buildStarField(count: number) {
  const rand = mulberry32(4242);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Uniform directions, with extra stars crowding the galactic band.
    for (;;) {
      v.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      const l = v.length();
      if (l < 0.05 || l > 1) continue;
      v.divideScalar(l);
      const g = v.dot(GALACTIC_NORTH);
      if (rand() < 0.35 + 0.65 * Math.exp(-g * g * 12)) break;
    }
    v.multiplyScalar(STAR_DISTANCE);
    pos.set([v.x, v.y, v.z], i * 3);
    let pick = rand();
    let c = SPECTRAL[SPECTRAL.length - 1][0];
    for (const [sc, share] of SPECTRAL) {
      if (pick < share) {
        c = sc;
        break;
      }
      pick -= share;
    }
    // Magnitudes: many faint stars, very few bright ones.
    const m = Math.pow(rand(), 7);
    const b = 0.18 + m * 1.6;
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    size[i] = 2.2 + m * 3.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: starVert,
    fragmentShader: starFrag,
    uniforms: { uScale: { value: 1 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const skyFragment = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uGalN;
uniform vec3 uCore;
varying vec3 vDir;
${NOISE_GLSL}

vec3 starLayer(vec3 dir, float scale, float density, float sigma, float gain){
  vec3 p = dir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p);
  vec3 acc = vec3(0.0);
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 o = vec3(float(x),float(y),float(z));
    vec3 h = hash33(id + o);
    if (h.z < density) continue;
    vec3 sp = o + h;
    float d = length(f - sp);
    float b = exp(-d*d/(2.0*sigma*sigma));
    float mag = pow((h.z - density)/(1.0-density), 3.0);
    vec3 tint = mix(vec3(1.0,0.72,0.5), vec3(0.65,0.8,1.0), h.x);
    tint = mix(tint, vec3(1.0), 0.4);
    acc += tint * b * (0.15 + mag * 2.5) * gain;
  }
  return acc;
}

void main(){
  vec3 dir = normalize(vDir);
  // Blue-black base: most of the sky stays nearly empty so stars read.
  vec3 col = vec3(0.0016, 0.0022, 0.0042);
  float g = dot(dir, uGalN);
  float band = exp(-g*g*10.0);

  // Galactic band: unresolved starlight broken by dust lanes.
  float bandN = fbm4(dir*5.0 + 3.0);
  float bandDust = smoothstep(0.0, 0.55, fbm4(dir*4.5 + 11.0));
  col += vec3(0.12, 0.11, 0.14) * band * (0.4 + 0.5*bandN) * 0.16 * (1.0 - bandDust*0.8);

  // Large scale: where gas exists at all (about 60 % of the sky),
  // plus one luminous core per system.
  vec3 q = dir * 1.6;
  float coreD = max(dot(dir, uCore), 0.0);
  float core = pow(coreD, 5.0);
  float coreTight = pow(coreD, 60.0);
  float mass = smoothstep(-0.45, 0.22, fbm4(dir*0.85 + 5.3));
  mass = clamp(max(mass, core*1.3), 0.0, 1.0);

  // Medium scale: warped gas and filaments. Fine scale near the core.
  vec3 warp = vec3(fbm4(q*1.2 + 2.0), fbm4(q*1.2 + 7.5), fbm4(q*1.2 - 4.0));
  float gas = smoothstep(-0.25, 0.9, fbm(q*1.1 + warp*0.7));
  float fil = pow(max(0.0, 1.0 - abs(fbm4(q*3.2 + warp*1.4))), 12.0);
  float fine = 0.5 + 0.5*fbm4(q*9.0 + warp*3.0);
  float dens = gas * mass * (0.45 + 1.5*core);
  dens += fil * mass * 0.3 * (0.35 + core);
  dens *= mix(1.0, fine*1.3, 0.12 + 0.15*core);

  // Natural chromatic gradient away from the core: hot cyan-white,
  // then magenta (H-alpha), then amber dust at the edges.
  float k = 1.0 - coreD;
  vec3 cCore = vec3(0.3, 0.72, 0.95);
  vec3 cMid = vec3(0.58, 0.1, 0.42);
  vec3 cOut = vec3(0.16, 0.14, 0.5);
  vec3 neb = mix(cCore, cMid, smoothstep(0.02, 0.4, k + fbm4(q*2.0)*0.15));
  neb = mix(neb, cOut, smoothstep(0.5, 1.0, k + fbm4(q*2.5 + 9.0)*0.25));
  col += neb * dens * 0.42;
  col += vec3(0.85, 0.95, 1.0) * coreTight * gas * 0.3;

  // Absorption: dark dust lanes in front of the glowing gas give depth.
  float lanes = smoothstep(0.02, 0.5, fbm4(q*2.6 + warp*0.6 + 11.0));
  float lanesFine = smoothstep(0.15, 0.65, fbm4(q*5.0 + warp*0.8 - 3.0));
  col *= 1.0 - clamp(lanes*0.45 + lanesFine*0.12*mass, 0.0, 0.85);

  // Faint unresolved stars (bright stars are live points, see StarField).
  col += starLayer(dir, 330.0, mix(0.985, 0.9, band), 0.05, 0.14) * (0.35 + band);

  // Sun halo baked into the sky (the disc itself is a live sprite).
  float s = max(dot(dir, uSunDir), 0.0);
  col += vec3(1.0,0.82,0.6) * (pow(s, 600.0)*2.0 + pow(s, 40.0)*0.1 + pow(s, 6.0)*0.02);

  gl_FragColor = vec4(col, 1.0);
}`;

export interface SkyResult {
  background: THREE.Texture;
  environment: THREE.Texture;
  /** Live sky objects (sun, lens flare, bright stars), kept centred on the camera by update(). */
  sun: THREE.Group;
  update(camera: THREE.Camera): void;
  dispose(): void;
}

/** Bakes the procedural nebula sky into a cubemap once, and builds the live sun. */
export function buildSky(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, resolution: number): SkyResult {
  const skyScene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir.clone() },
      uGalN: { value: GALACTIC_NORTH },
      uCore: { value: NEBULA_CORE },
    },
  });
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  const rt = new THREE.WebGLCubeRenderTarget(resolution, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(0.1, 100, rt);
  cubeCam.update(renderer, skyScene);
  mat.dispose();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(rt.texture).texture;
  pmrem.dispose();

  // Everything live follows the camera: stars all around, the sun far away.
  const root = new THREE.Group();
  const stars = buildStarField(resolution >= 1024 ? 6000 : 3500);
  root.add(stars);
  const sun = new THREE.Group();
  sun.position.copy(sunDir).multiplyScalar(150000);
  root.add(sun);
  // Live sun: core sprite + lens flare.
  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeRadialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.12, 'rgba(255,245,220,1)'],
        [0.3, 'rgba(255,200,140,0.35)'],
        [1, 'rgba(255,160,90,0)'],
      ]),
      color: new THREE.Color(4, 3.4, 2.8),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  core.scale.setScalar(5500);
  sun.add(core);
  const flareMain = makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,230,200,0.6)'],
    [1, 'rgba(255,200,150,0)'],
  ]);
  const flareHex = makeRadialTexture([
    [0, 'rgba(140,180,255,0.25)'],
    [0.7, 'rgba(140,180,255,0.15)'],
    [1, 'rgba(140,180,255,0)'],
  ]);
  const ring = makeFlareRing();
  // Cinematic Realism: the star glows, the lens barely shows (no row of ghosts).
  const lens = new Lensflare();
  lens.addElement(new LensflareElement(flareMain, 300, 0, new THREE.Color(0.7, 0.62, 0.55)));
  lens.addElement(new LensflareElement(ring, 90, 0.35, new THREE.Color(0.08, 0.11, 0.16)));
  lens.addElement(new LensflareElement(flareHex, 70, 0.8, new THREE.Color(0.08, 0.09, 0.12)));
  sun.add(lens);

  return {
    background: rt.texture,
    environment: env,
    sun: root,
    update(camera: THREE.Camera) {
      root.position.copy(camera.position);
      // Point sizes are in pixels: follow the render scale (dynamic resolution).
      (stars.material as THREE.ShaderMaterial).uniforms.uScale.value = renderer.getPixelRatio();
    },
    dispose() {
      rt.dispose();
      env.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
    },
  };
}
