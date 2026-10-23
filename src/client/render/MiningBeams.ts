import * as THREE from 'three';

const MAX = 24;

const beamVert = /* glsl */ `
varying vec2 vUv;
varying float vLen;
void main(){
  vUv = uv;
  // The ribbon's length is the y scale of its instance matrix.
  vLen = length(instanceMatrix[1].xyz);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
// Across: a hot core in an amber sheath. Along: pulses run from the ship to
// the rock, every 9 m whatever the beam's length.
const beamFrag = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vLen;
void main(){
  float c = abs(vUv.x - 0.5) * 2.0;
  float core = exp(-c * c * 40.0);
  float glow = exp(-c * c * 5.0);
  float d = vUv.y * vLen;
  float pulse = 0.65 + 0.35 * sin(d * 0.7 - uTime * 26.0);
  float ends = smoothstep(0.0, 3.0, d) * (0.75 + 0.25 * smoothstep(vLen - 6.0, vLen, d));
  vec3 col = vec3(6.0, 4.6, 2.6) * core + vec3(2.6, 1.1, 0.25) * glow * pulse;
  gl_FragColor = vec4(col * ends, 1.0);
}`;

export interface BeamSegment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

/**
 * Mining beams: one camera-facing ribbon per mining ship, from its nose to
 * the rock (positions come from the snapshots, so every player sees every
 * beam). One instanced draw call.
 */
export class MiningBeams {
  readonly mesh: THREE.InstancedMesh;
  private uTime = { value: 0 };
  private m = new THREE.Matrix4();
  private dir = new THREE.Vector3();
  private side = new THREE.Vector3();
  private view = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor() {
    // Ribbon in the XY plane: x across, y along from the ship (y = 0) to the rock.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: beamVert,
        fragmentShader: beamFrag,
        uniforms: { uTime: this.uTime },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
      }),
      MAX,
    );
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /** Draws the first `count` segments of `beams`. */
  update(time: number, beams: BeamSegment[], count: number, camPos: THREE.Vector3) {
    this.uTime.value = time;
    let n = 0;
    for (let i = 0; i < count && n < MAX; i++) {
      const b = beams[i];
      this.dir.subVectors(b.to, b.from);
      const len = this.dir.length();
      if (len < 0.5) continue;
      this.dir.divideScalar(len);
      this.view.subVectors(camPos, b.from);
      this.side.crossVectors(this.dir, this.view);
      if (this.side.lengthSq() < 1e-8) continue;
      // A little wider far away so it stays visible.
      const width = Math.max(1.8, this.view.length() * 0.003);
      this.side.normalize().multiplyScalar(width);
      this.up.copy(this.dir).multiplyScalar(len);
      this.view.crossVectors(this.side, this.up).normalize();
      this.m.makeBasis(this.side, this.up, this.view).setPosition(b.from);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
