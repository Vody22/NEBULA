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

const planetFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uAtmo;
uniform float uKind; // 0 gas, 1 rocky, 2 ice
uniform float uSeed;
uniform float uTime;
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vPosW;
${NOISE_GLSL}
void main(){
  vec3 p = vObj + uSeed;
  vec3 albedo;
  float spec = 0.0;
  float clouds = 0.0;
  if (uKind < 0.5) {
    // Gas giant: latitude bands sheared by turbulence + storms.
    float lat = vObj.y;
    float turb = fbm(p*3.0 + vec3(uTime*0.002,0.0,0.0));
    float bands = sin(lat*22.0 + turb*2.5) * 0.5 + 0.5;
    float fine = sin(lat*70.0 + turb*5.0) * 0.5 + 0.5;
    albedo = mix(uColB, uColA, bands);
    albedo = mix(albedo, albedo*1.25, fine*0.25);
    float storm = smoothstep(0.75, 0.9, 1.0 - length((vObj - normalize(vec3(0.6,-0.25,0.75)))*vec3(1.0,2.2,1.0))*3.0);
    albedo = mix(albedo, vec3(0.95,0.75,0.6), storm*0.8);
  } else if (uKind < 1.5) {
    // Rocky ocean world: continents, ice caps, clouds.
    float h = fbm(p*2.2) + 0.5*ridged(p*4.0)*0.35;
    float land = smoothstep(0.02, 0.06, h);
    vec3 ocean = mix(uColA*0.5, uColA, smoothstep(-0.4, 0.02, h));
    vec3 ground = mix(vec3(0.18,0.32,0.12), uColB, smoothstep(0.05, 0.35, h));
    albedo = mix(ocean, ground, land);
    float ice = smoothstep(0.78, 0.86, abs(vObj.y) + fbm4(p*5.0)*0.08);
    albedo = mix(albedo, vec3(0.92), ice);
    spec = (1.0 - land) * (1.0 - ice);
    clouds = smoothstep(0.05, 0.55, fbm(p*3.0 + vec3(uTime*0.004, 0.0, uTime*0.002)));
  } else {
    float h = ridged(p*3.0);
    albedo = mix(uColB, uColA, smoothstep(0.3, 0.9, h));
    float cr = smoothstep(0.55, 0.6, fbm4(p*9.0));
    albedo *= 1.0 - cr*0.25;
  }
  albedo = mix(albedo, vec3(1.0), clouds*0.85);

  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vPosW);
  float ndl = dot(n, uSunDir);
  float diff = smoothstep(-0.08, 0.5, ndl) * max(ndl, 0.0) * 0.6 + max(ndl,0.0)*0.4;
  vec3 h = normalize(uSunDir + v);
  float sp = pow(max(dot(n,h),0.0), 60.0) * spec * 0.8 * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 col = albedo * diff * 1.6 + sp * vec3(1.0,0.9,0.8);
  // atmospheric scattering at the limb and a warm terminator
  float term = smoothstep(-0.25, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.35, ndl));
  col += uAtmo * fres * smoothstep(-0.3, 0.4, ndl) * 1.4;
  col += vec3(1.0,0.45,0.2) * term * 0.08;
  col += albedo * 0.006; // faint night side
  gl_FragColor = vec4(col, 1.0);
}`;

const atmoFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uAtmo;
varying vec3 vNormalW;
varying vec3 vPosW;
void main(){
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vPosW);
  float rim = 1.0 - abs(dot(n, v));
  float a = pow(rim, 5.0);
  float lit = smoothstep(-0.35, 0.5, dot(n, uSunDir));
  gl_FragColor = vec4(uAtmo * a * lit * 2.2, 1.0);
}`;

const ringFrag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uPlanetPos;
uniform float uPlanetR;
uniform float uInner;
uniform float uOuter;
varying vec3 vObj;
varying vec3 vPosW;
float hash(float n){ return fract(sin(n)*43758.5453); }
void main(){
  float r = length(vPosW - uPlanetPos);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float bands = 0.0;
  for (int i=0;i<6;i++){ float f = pow(1.9, float(i))*7.0 + hash(float(i)+3.0)*5.0; bands += sin(t*f*6.283 + hash(float(i))*6.0)*0.5/float(i+1); }
  float dens = smoothstep(0.0,0.06,t)*smoothstep(1.0,0.9,t)*(0.45+bands*0.3);
  dens *= 1.0 - smoothstep(0.48,0.5,t)*(1.0-smoothstep(0.52,0.56,t))*0.9; // Cassini-like gap
  // planet shadow on the rings
  vec3 toP = uPlanetPos - vPosW;
  float proj = dot(toP, -uSunDir);
  float shadow = 1.0;
  if (proj < 0.0) { vec3 closest = toP + uSunDir*proj; shadow = smoothstep(uPlanetR*0.95, uPlanetR*1.05, length(closest)); }
  vec3 col = mix(vec3(0.62,0.5,0.42), vec3(0.85,0.76,0.64), bands*0.5+0.5) * (0.25 + 0.75*shadow);
  gl_FragColor = vec4(col * 0.75, clamp(dens*0.8, 0.0, 0.75));
}`;

export class Planets {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];

  constructor(defs: PlanetDef[], sunDir: THREE.Vector3) {
    for (const d of defs) {
      const kind = d.kind === 'gas' ? 0 : d.kind === 'rocky' ? 1 : 2;
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
        },
      });
      this.mats.push(mat);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radius, 160, 96), mat);
      mesh.position.copy(d.position);
      mesh.rotation.z = kind === 0 ? 0.18 : 0.4;
      this.group.add(mesh);

      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(d.radius * (kind === 1 ? 1.035 : 1.02), 96, 64),
        new THREE.ShaderMaterial({
          vertexShader: planetVert,
          fragmentShader: atmoFrag,
          uniforms: { uSunDir: { value: sunDir }, uAtmo: { value: new THREE.Vector3(...d.atmosphere) } },
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
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(inner, outer, 256, 1),
          new THREE.ShaderMaterial({
            vertexShader: planetVert,
            fragmentShader: ringFrag,
            uniforms: {
              uSunDir: { value: sunDir },
              uPlanetPos: { value: d.position.clone() },
              uPlanetR: { value: d.radius },
              uInner: { value: inner },
              uOuter: { value: outer },
            },
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        ring.position.copy(d.position);
        ring.rotation.x = -Math.PI / 2 + 0.28;
        ring.rotation.y = 0.18;
        this.group.add(ring);
      }
    }
  }

  update(time: number) {
    for (const m of this.mats) m.uniforms.uTime.value = time;
  }
}
