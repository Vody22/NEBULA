import * as THREE from 'three';
import type { PlanetDef } from '../../shared/sim/zone';
import { NOISE_GLSL } from './glsl';

const planetVert = /* glsl */ `
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vPosW;
void main(){
  vObj = normalize(position);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position,1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Shared by planets and rings: distant worlds fade slightly toward the deep-space tint. */
const HAZE_GLSL = /* glsl */ `
uniform float uHaze;
vec3 haze(vec3 col){ return mix(col, vec3(0.012, 0.016, 0.03), uHaze); }
`;

const planetFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uAtmo;
uniform float uKind; // 0 gas, 1 rocky, 2 ice
uniform float uSeed;
uniform float uTime;
uniform float uCity;
uniform float uRingOn;
uniform vec3 uRingN;
uniform vec3 uCenter;
uniform float uRingIn;
uniform float uRingOut;
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vPosW;
${NOISE_GLSL}
${HAZE_GLSL}
void main(){
  vec3 p = vObj + uSeed;
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vPosW);
  float ndl = dot(n, uSunDir);
  vec3 albedo;
  float spec = 0.0;
  float clouds = 0.0;
  float cloudShadow = 0.0;
  float land = 0.0;
  if (uKind < 0.5) {
    // Gas giant: many belts and zones of different widths, edges churned by
    // turbulence (stronger where neighbouring bands shear), fine striations
    // along the flow, white ovals riding the belts and one great storm.
    float lat = vObj.y;
    vec3 flow = vec3(uTime*0.002, 0.0, 0.0);
    float w1 = fbm(p*3.0 + flow);
    float wl = lat + w1*0.035;
    float edge = 1.0 - abs(sin(wl*22.0));
    wl += fbm4(p*11.0 + flow*2.0 + w1)*0.018*(0.4 + edge);
    float b1 = sin(wl*22.0);
    float b2 = sin(wl*57.0 + 1.3);
    float b3 = sin(wl*9.0 + 0.4);
    vec3 zone = mix(uColA, vec3(0.95, 0.9, 0.82), 0.45);
    vec3 belt = uColB;
    vec3 mid = uColA;
    albedo = mix(belt, zone, smoothstep(-0.35, 0.35, b1));
    albedo = mix(albedo, mid, 0.4*smoothstep(0.1, 0.9, b2));
    albedo *= 0.85 + 0.15*b3;
    float stri = fbm4(vec3(p.x*5.0, p.y*70.0, p.z*5.0) + flow*3.0);
    albedo *= 0.92 + stri*0.16;
    // White ovals along the band edges.
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float la = sin(fi*2.3 + 0.5)*0.55;
      float lo = fi*1.05 + 0.3;
      vec3 c = normalize(vec3(cos(lo)*sqrt(1.0 - la*la), la, sin(lo)*sqrt(1.0 - la*la)));
      float d = length((vObj - c)*vec3(1.0, 2.4, 1.0));
      float r = 0.035 + 0.02*fract(fi*0.618);
      float oval = smoothstep(r, r*0.5, d);
      float ring = smoothstep(r*1.4, r, d) - oval;
      albedo = mix(albedo, vec3(0.97, 0.94, 0.88), oval*0.85);
      albedo *= 1.0 - ring*0.25;
    }
    // The great storm: a red oval with a darker swirling collar.
    vec3 sc = normalize(vec3(0.6, -0.25, 0.75));
    float sd = length((vObj - sc)*vec3(1.0, 2.2, 1.0));
    float sw = fbm4((vObj - sc)*18.0 + vec3(sd*30.0));
    float storm = smoothstep(0.12, 0.07, sd + sw*0.012);
    float collar = smoothstep(0.17, 0.12, sd) - storm;
    albedo = mix(albedo, vec3(0.78, 0.42, 0.3), storm*0.8);
    albedo = mix(albedo, albedo*0.75 + vec3(0.1, 0.06, 0.04), collar*0.7);
  } else if (uKind < 1.5) {
    // Rocky ocean world: warped continents with ragged coasts, biomes by
    // latitude and height, shallow seas, ice caps, and cloud bands stretched
    // by the winds, with a few cyclones.
    vec3 cw = vec3(fbm4(p*1.6 + 3.0), fbm4(p*1.6 - 5.0), fbm4(p*1.6 + 9.0));
    float h = fbm(p*2.2 + cw*0.3) + ridged(p*4.0 + cw*0.2)*0.12 + fbm4(p*16.0)*0.04;
    // The ridges lift the mean height: the sea level follows so oceans stay the larger part.
    land = smoothstep(0.19, 0.215, h);
    float shelf = smoothstep(0.13, 0.19, h);
    vec3 ocean = mix(uColA*0.16, uColA*0.55, smoothstep(-0.4, 0.05, h));
    ocean = mix(ocean, mix(uColA, vec3(0.25, 0.65, 0.68), 0.5), shelf*0.55);
    float lat = abs(vObj.y);
    float moist = fbm4(p*3.5 + 17.0);
    vec3 forest = vec3(0.1, 0.2, 0.08);
    vec3 grass = vec3(0.26, 0.33, 0.14);
    vec3 desert = uColB * 1.05;
    vec3 rock = vec3(0.35, 0.3, 0.26);
    vec3 ground = mix(grass, forest, smoothstep(-0.1, 0.25, moist));
    ground = mix(ground, desert, smoothstep(-0.02, -0.25, moist) * smoothstep(0.5, 0.15, lat));
    ground = mix(ground, rock, smoothstep(0.42, 0.62, h + fbm4(p*12.0)*0.06));
    ground = mix(ground, vec3(0.42, 0.4, 0.36), smoothstep(0.55, 0.72, lat));
    albedo = mix(ocean, ground, land);
    float ice = smoothstep(0.8, 0.87, lat + fbm4(p*5.0)*0.08);
    albedo = mix(albedo, vec3(0.88), ice);
    spec = (1.0 - land) * (1.0 - ice);
    vec3 drift = vec3(uTime*0.004, 0.0, uTime*0.002);
    vec3 cp = p + drift;
    vec3 cwarp = vec3(fbm4(cp*2.0 + 1.0), fbm4(cp*2.0 + 6.0), fbm4(cp*2.0 - 3.0));
    vec3 cq = vec3(cp.x*3.0, cp.y*7.5, cp.z*3.0) + cwarp*0.9;
    float cl = fbm(cq) + fbm4(cp*14.0 + cwarp)*0.18;
    // Cyclones: spirals around two low-pressure centres.
    for (int i = 0; i < 2; i++) {
      vec3 c = normalize(vec3(i == 0 ? 0.5 : -0.7, i == 0 ? 0.35 : -0.3, i == 0 ? 0.8 : 0.6));
      float dc = length(vObj - c);
      float ang = atan(dot(vObj - c, cross(c, vec3(0.0, 1.0, 0.0))), (vObj - c).y);
      cl += smoothstep(0.25, 0.0, dc) * 0.35 * sin(ang*2.0 + dc*40.0);
    }
    clouds = smoothstep(0.05, 0.55, cl);
    // Soft shadow of the cloud layer, offset away from the sun.
    vec3 sunObj = normalize(uSunDir); // planets are not rotated much: world ≈ object here
    vec3 sq = vec3((cp.x - sunObj.x*0.025)*3.0, (cp.y - sunObj.y*0.025)*7.5, (cp.z - sunObj.z*0.025)*3.0) + cwarp*0.9;
    cloudShadow = smoothstep(0.05, 0.55, fbm4(sq)) * 0.5;
  } else {
    float h = ridged(p*3.0);
    albedo = mix(uColB, uColA, smoothstep(0.3, 0.9, h));
    float cr = smoothstep(0.55, 0.6, fbm4(p*9.0));
    albedo *= 1.0 - cr*0.25;
  }
  albedo *= 1.0 - cloudShadow * (1.0 - clouds);
  albedo = mix(albedo, vec3(0.95), clouds*0.85);

  // Sharp terminator: the night side is black. Sunlight reddens where it
  // grazes through the atmosphere.
  float day = max(ndl, 0.0);
  // The rings' shadow across the disc: where the way to the sun crosses them.
  if (uRingOn > 0.5) {
    float denom = dot(uSunDir, uRingN);
    float tt = abs(denom) > 1e-4 ? dot(uCenter - vPosW, uRingN) / denom : -1.0;
    if (tt > 0.0) {
      float rr = (length(vPosW + uSunDir*tt - uCenter) - uRingIn) / (uRingOut - uRingIn);
      if (rr > 0.0 && rr < 1.0) {
        float dens = smoothstep(0.0, 0.05, rr) * (1.0 - smoothstep(0.92, 1.0, rr)) * (0.7 + 0.3*sin(rr*70.0));
        dens *= smoothstep(0.018, 0.026, abs(rr - 0.52));
        day *= 1.0 - 0.7*dens;
      }
    }
  }
  float hasAtmo = step(uKind, 1.5);
  vec3 sunCol = mix(vec3(1.0, 0.5, 0.3), vec3(1.0), mix(1.0, smoothstep(0.0, 0.28, ndl), hasAtmo));
  vec3 col = albedo * sunCol * day * 1.55;
  // Gas giants darken toward the limb.
  if (uKind < 0.5) col *= 0.55 + 0.45*pow(max(dot(n, v), 0.0), 0.35);
  vec3 hv = normalize(uSunDir + v);
  col += pow(max(dot(n, hv), 0.0), 80.0) * spec * 0.7 * step(0.0, ndl) * vec3(1.0, 0.9, 0.8);
  // Atmosphere: thin day-side haze, wider at the limb, warm at the terminator.
  float fres = pow(clamp(1.0 - dot(n, v), 0.0, 1.0), 3.0);
  vec3 atmoCol = mix(vec3(1.0, 0.45, 0.22), uAtmo, smoothstep(-0.05, 0.35, ndl));
  col += atmoCol * fres * smoothstep(-0.2, 0.3, ndl) * 1.2 * (0.4 + 0.6*hasAtmo);
  col += albedo * day * 0.04 * hasAtmo; // in-scattered daylight
  // City lights on the night side of inhabited worlds.
  float night = 1.0 - smoothstep(-0.12, 0.04, ndl);
  float cities = smoothstep(0.62, 0.8, fbm4(p*26.0)) * smoothstep(0.3, 0.7, fbm4(p*6.0 + 4.0));
  col += vec3(1.0, 0.62, 0.3) * cities * land * night * uCity * (1.0 - clouds*0.8) * 0.9;
  gl_FragColor = vec4(haze(col), 1.0);
}`;

const atmoFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uAtmo;
varying vec3 vNormalW;
varying vec3 vPosW;
${HAZE_GLSL}
void main(){
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vPosW);
  float rim = clamp(1.0 - abs(dot(n, v)), 0.0, 1.0);
  float ndl = dot(n, uSunDir);
  float lit = smoothstep(-0.3, 0.35, ndl);
  // Rayleigh-like: blue (or the world's tint) on the day limb, red at the terminator.
  vec3 c = mix(vec3(1.0, 0.42, 0.2), uAtmo, smoothstep(-0.1, 0.35, ndl));
  float a = pow(rim, 5.0) * 2.0 + pow(rim, 14.0) * 1.5;
  gl_FragColor = vec4(haze(c * a * lit), 1.0);
}`;

const ringFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uPlanetPos;
uniform vec3 uRingN;
uniform float uPlanetR;
uniform float uInner;
uniform float uOuter;
varying vec3 vObj;
varying vec3 vPosW;
${HAZE_GLSL}
float hash(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise(float x){ float i = floor(x); float f = fract(x); float u = f*f*(3.0-2.0*f); return mix(hash(i), hash(i+1.0), u); }
void main(){
  float r = length(vPosW - uPlanetPos);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  // Ringlets: value noise over the radius. Each octave fades out once its
  // bands get thinner than a couple of pixels, which removes the moiré.
  float w = max(fwidth(t), 1e-5);
  float dens = 0.0;
  float amp = 0.5;
  float freq = 7.0;
  float norm = 0.0;
  for (int i = 0; i < 7; i++) {
    float aa = 1.0 - smoothstep(0.12, 0.45, w * freq);
    dens += amp * mix(0.5, vnoise(t*freq + float(i)*17.0), aa);
    norm += amp;
    amp *= 0.62;
    freq *= 2.2;
  }
  dens = smoothstep(0.22, 0.78, dens / norm);
  dens *= smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.92, 1.0, t));
  // Divisions with crisp, antialiased edges.
  dens *= smoothstep(0.022 - w, 0.022 + w, abs(t - 0.52));
  dens *= mix(0.25, 1.0, smoothstep(0.004 - w, 0.004 + w, abs(t - 0.83)));
  dens *= 0.55 + 0.45 * smoothstep(0.0, 0.4, t);
  // Planet shadow.
  vec3 toP = uPlanetPos - vPosW;
  float proj = dot(toP, -uSunDir);
  float shadow = 1.0;
  if (proj < 0.0) { vec3 closest = toP + uSunDir*proj; shadow = smoothstep(uPlanetR*0.97, uPlanetR*1.03, length(closest)); }
  // Lit face vs. the far face, where only light scattered through the ice reaches the eye.
  vec3 v = normalize(cameraPosition - vPosW);
  float sameSide = step(0.0, dot(uRingN, uSunDir) * dot(uRingN, v));
  float bright = mix(0.35 + 0.5 * pow(max(dot(-v, uSunDir), 0.0), 4.0), 1.0, sameSide);
  vec3 tone = mix(vec3(0.5, 0.43, 0.37), vec3(0.8, 0.72, 0.62), vnoise(t*13.0 + 5.0));
  vec3 col = tone * (0.05 + 0.95*shadow) * bright * 0.8;
  gl_FragColor = vec4(haze(col), clamp(dens*0.85, 0.0, 0.85));
}`;

/** Atmospheric haze by apparent distance: farther, larger worlds read as far away. */
function hazeFor(d: PlanetDef) {
  const dist = d.position.length();
  return Math.min(0.3, Math.max(0, (dist - 20000) / 150000));
}

export class Planets {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];

  constructor(defs: PlanetDef[], sunDir: THREE.Vector3) {
    for (const d of defs) {
      const kind = d.kind === 'gas' ? 0 : d.kind === 'rocky' ? 1 : 2;
      const haze = hazeFor(d);
      const mat = new THREE.ShaderMaterial({
        vertexShader: planetVert,
        fragmentShader: planetFrag,
        uniforms: {
          uSunDir: { value: sunDir },
          uColA: { value: new THREE.Vector3(...d.colorA) },
          uColB: { value: new THREE.Vector3(...d.colorB) },
          uAtmo: { value: new THREE.Vector3(...d.atmosphere) },
          uKind: { value: kind },
          uSeed: { value: d.seed },
          uTime: { value: 0 },
          uCity: { value: kind === 1 ? 1 : 0 },
          uHaze: { value: haze },
          uRingOn: { value: 0 },
          uRingN: { value: new THREE.Vector3(0, 1, 0) },
          uCenter: { value: d.position.clone() },
          uRingIn: { value: 1 },
          uRingOut: { value: 2 },
        },
      });
      this.mats.push(mat);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radius, 160, 96), mat);
      mesh.position.copy(d.position);
      mesh.rotation.z = kind === 0 ? 0.18 : 0.4;
      this.group.add(mesh);

      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(d.radius * (kind === 1 ? 1.03 : 1.018), 96, 64),
        new THREE.ShaderMaterial({
          vertexShader: planetVert,
          fragmentShader: atmoFrag,
          uniforms: { uSunDir: { value: sunDir }, uAtmo: { value: new THREE.Vector3(...d.atmosphere) }, uHaze: { value: haze } },
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.FrontSide,
        }),
      );
      atmo.position.copy(d.position);
      this.group.add(atmo);

      if (d.rings) {
        const inner = d.radius * 1.35;
        const outer = d.radius * 2.3;
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 256, 1));
        ring.position.copy(d.position);
        ring.rotation.x = -Math.PI / 2 + 0.28;
        ring.rotation.y = 0.18;
        ring.updateMatrixWorld();
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion).normalize();
        mat.uniforms.uRingOn.value = 1;
        mat.uniforms.uRingN.value.copy(normal);
        mat.uniforms.uRingIn.value = inner;
        mat.uniforms.uRingOut.value = outer;
        ring.material = new THREE.ShaderMaterial({
          vertexShader: planetVert,
          fragmentShader: ringFrag,
          uniforms: {
            uSunDir: { value: sunDir },
            uPlanetPos: { value: d.position.clone() },
            uRingN: { value: normal },
            uPlanetR: { value: d.radius },
            uInner: { value: inner },
            uOuter: { value: outer },
            uHaze: { value: haze },
          },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        this.group.add(ring);
      }
    }
  }

  update(time: number) {
    for (const m of this.mats) m.uniforms.uTime.value = time;
  }
}
