import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { NOISE_GLSL } from './glsl';
import { makeFlareRing, makeRadialTexture } from './textures';

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const skyFragment = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uGalN;
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
  vec3 col = vec3(0.0025,0.0035,0.008);
  float g = dot(dir, uGalN);
  float band = exp(-g*g*9.0);

  vec3 q = dir * 1.7;
  vec3 warp = vec3(fbm4(q*1.3+2.0), fbm4(q*1.3+7.5), fbm4(q*1.3-4.0));
  float n1 = fbm(q + warp*0.9);
  float neb = smoothstep(-0.05, 0.75, n1);
  float sel = fbm4(q*2.0+3.0);
  vec3 magenta = vec3(0.55,0.07,0.42);
  vec3 teal = vec3(0.03,0.38,0.55);
  vec3 ember = vec3(1.0,0.42,0.12);
  vec3 nebCol = mix(magenta, teal, smoothstep(-0.35, 0.45, sel));
  nebCol = mix(nebCol, ember, smoothstep(0.3, 0.75, fbm4(q*3.0-7.0)) * 0.55);
  float glow = pow(neb, 1.6);
  col += nebCol * glow * (0.18 + band*1.1);
  // bright filaments
  float fil = pow(max(0.0, 1.0-abs(fbm4(q*5.0+warp*2.0))), 12.0);
  col += mix(teal, vec3(0.8,0.6,1.0), 0.5) * fil * neb * 0.35;

  // milky way core glow + dust lanes
  col += vec3(0.20,0.18,0.26) * band * 0.10 * (0.6 + 0.6*fbm4(dir*6.0));
  float dust = smoothstep(0.05, 0.6, fbm4(dir*4.5+11.0));
  col *= mix(1.0, 0.25, dust * band * 0.9);

  // stars
  col += starLayer(dir, 70.0, 0.965, 0.07, 1.4);
  col += starLayer(dir, 160.0, 0.90, 0.06, 0.45);
  col += starLayer(dir, 330.0, mix(0.97, 0.80, band), 0.05, 0.22) * (0.4 + band);

  // sun halo baked into the sky (the disc itself is a live sprite)
  float s = max(dot(dir, uSunDir), 0.0);
  col += vec3(1.0,0.82,0.6) * (pow(s, 600.0)*2.0 + pow(s, 40.0)*0.12 + pow(s, 6.0)*0.03);

  gl_FragColor = vec4(col, 1.0);
}`;

export interface SkyResult {
  background: THREE.Texture;
  environment: THREE.Texture;
  sun: THREE.Group;
  update(camera: THREE.Camera): void;
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
      uGalN: { value: new THREE.Vector3(0.25, 0.92, 0.3).normalize() },
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

  // Live sun: core sprite + lens flare.
  const sun = new THREE.Group();
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
  const lens = new Lensflare();
  lens.addElement(new LensflareElement(flareMain, 380, 0, new THREE.Color(0.8, 0.7, 0.6)));
  lens.addElement(new LensflareElement(ring, 120, 0.3, new THREE.Color(0.25, 0.35, 0.5)));
  lens.addElement(new LensflareElement(flareHex, 50, 0.6, new THREE.Color(0.5, 0.5, 0.6)));
  lens.addElement(new LensflareElement(flareHex, 90, 0.75, new THREE.Color(0.4, 0.5, 0.6)));
  lens.addElement(new LensflareElement(flareHex, 130, 0.95, new THREE.Color(0.35, 0.4, 0.55)));
  lens.addElement(new LensflareElement(ring, 60, 1.1, new THREE.Color(0.5, 0.35, 0.25)));
  sun.add(lens);

  return {
    background: rt.texture,
    environment: env,
    sun,
    update(camera: THREE.Camera) {
      sun.position.copy(camera.position).addScaledVector(sunDir, 150000);
    },
  };
}
