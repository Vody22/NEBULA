import * as THREE from 'three';

/**
 * Many small things drawn in one call each: the glow points of every ship,
 * station and belt (navigation lights, strobes, thrusters, hull marks, fires,
 * traffic lights, dust clouds) and the engine flames of every ship. One
 * Sprite or Mesh per light cost one draw call each, several hundred in a big
 * fight; here a field holds them all and is refreshed right before each
 * render from the objects they are attached to.
 */
interface Batch {
  update(): void;
}

const live = new Set<Batch>();
/** Per refresh: whether a parent is drawn (its world matrix is then up to date). */
const parents = new Map<THREE.Object3D, boolean>();

/** Brings every field up to date with the objects it follows. Call right before rendering. */
export function updateBatches() {
  parents.clear();
  for (const b of live) b.update();
}

/** Visible all the way up to a scene, with a fresh world matrix. */
function shown(parent: THREE.Object3D): boolean {
  let on = parents.get(parent);
  if (on === undefined) {
    on = true;
    let top: THREE.Object3D = parent;
    for (let o: THREE.Object3D | null = parent; o; o = o.parent) {
      if (!o.visible) on = false;
      top = o;
    }
    if (!(top as THREE.Scene).isScene) on = false;
    if (on) parent.updateWorldMatrix(true, false);
    parents.set(parent, on);
  }
  return on;
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/** One glow point, positioned in its parent's frame (parents are assumed unscaled). */
export class Glow {
  readonly position = new THREE.Vector3();
  readonly color = new THREE.Color();
  /** Width in metres, like a sprite's scale. */
  size = 1;
  opacity = 1;
  rotation = 0;
  visible = true;
  constructor(readonly parent: THREE.Object3D) {}
}

const glowVert = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aColor;
attribute vec2 aShape;
varying vec2 vUv;
varying vec4 vColor;
void main(){
  vUv = uv;
  vColor = aColor;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float c = cos(aShape.y);
  float s = sin(aShape.y);
  vec2 p = position.xy * aShape.x;
  mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  gl_Position = projectionMatrix * mv;
}`;
// Same result as an additive SpriteMaterial: colour × texture, alpha × opacity.
const glowFrag = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main(){
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Camera-facing additive glows sharing one texture, in a single draw call.
 * The mesh can sit anywhere in the scene: it draws in world space.
 */
export class GlowField implements Batch {
  readonly mesh: THREE.Mesh;
  private glows: Glow[] = [];
  private geo = new THREE.InstancedBufferGeometry();
  private cap = 0;
  private aPos!: THREE.InstancedBufferAttribute;
  private aColor!: THREE.InstancedBufferAttribute;
  private aShape!: THREE.InstancedBufferAttribute;

  constructor(map: THREE.Texture, opts: { toneMapped?: boolean } = {}) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.grow(256);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        vertexShader: glowVert,
        fragmentShader: glowFrag,
        uniforms: { uMap: { value: map } },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        toneMapped: opts.toneMapped ?? false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Never folded into a merged static mesh (see mergeByMaterial).
    this.mesh.userData.dynamic = true;
    this.mesh.visible = false;
    live.add(this);
  }

  private grow(cap: number) {
    // Frees the old buffers; the quad is uploaded again with the new ones.
    if (this.cap) this.geo.dispose();
    this.cap = cap;
    const attr = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage);
    this.aPos = attr(3);
    this.aColor = attr(4);
    this.aShape = attr(2);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aColor', this.aColor);
    this.geo.setAttribute('aShape', this.aShape);
  }

  add(parent: THREE.Object3D, color: THREE.Color, size: number, pos: THREE.Vector3) {
    const g = new Glow(parent);
    g.color.copy(color);
    g.size = size;
    g.position.copy(pos);
    this.glows.push(g);
    return g;
  }

  remove(g: Glow) {
    const i = this.glows.indexOf(g);
    if (i < 0) return;
    this.glows[i] = this.glows[this.glows.length - 1];
    this.glows.pop();
  }

  get count() {
    return this.glows.length;
  }

  update() {
    // Not in a drawn scene (a zone left behind, a hidden group): nothing to do.
    if (!this.mesh.parent || !shown(this.mesh.parent)) {
      this.mesh.visible = false;
      return;
    }
    if (this.glows.length > this.cap) this.grow(Math.max(this.glows.length, this.cap * 2));
    let n = 0;
    for (const g of this.glows) {
      if (!g.visible || g.opacity <= 0.002 || !shown(g.parent)) continue;
      _v.copy(g.position).applyMatrix4(g.parent.matrixWorld);
      this.aPos.setXYZ(n, _v.x, _v.y, _v.z);
      this.aColor.setXYZW(n, g.color.r, g.color.g, g.color.b, g.opacity);
      this.aShape.setXY(n, g.size, g.rotation);
      n++;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.aPos.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aShape.needsUpdate = true;
    }
  }

  dispose() {
    live.delete(this);
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** One engine flame: a cone in its ship's frame, scaled and coloured each frame. */
export class Flame {
  readonly position = new THREE.Vector3();
  readonly scale = new THREE.Vector3(1, 1, 1);
  readonly color = new THREE.Color();
  power = 1;
  visible = true;
  constructor(readonly parent: THREE.Object3D) {}
}

/**
 * Instanced meshes with a per-instance colour and power: every engine flame
 * of every ship in one draw call. The material's shader reads `aColor` and
 * `aPower`; the mesh stays at the scene's origin.
 */
export class FlameField implements Batch {
  readonly mesh: THREE.InstancedMesh;
  private flames: Flame[] = [];
  private cap: number;

  constructor(
    private geometry: THREE.BufferGeometry,
    material: THREE.Material,
    cap = 256,
  ) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.attrs(cap);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.dynamic = true;
    this.mesh.count = 0;
    this.mesh.visible = false;
    live.add(this);
  }

  private attrs(cap: number) {
    this.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aPower', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
  }

  private grow(cap: number) {
    this.geometry.dispose();
    this.mesh.dispose();
    this.cap = cap;
    this.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16).setUsage(THREE.DynamicDrawUsage);
    this.attrs(cap);
  }

  add(parent: THREE.Object3D, pos: THREE.Vector3) {
    const f = new Flame(parent);
    f.position.copy(pos);
    this.flames.push(f);
    return f;
  }

  remove(f: Flame) {
    const i = this.flames.indexOf(f);
    if (i < 0) return;
    this.flames[i] = this.flames[this.flames.length - 1];
    this.flames.pop();
  }

  update() {
    if (!this.mesh.parent || !shown(this.mesh.parent)) {
      this.mesh.visible = false;
      return;
    }
    if (this.flames.length > this.cap) this.grow(Math.max(this.flames.length, this.cap * 2));
    const color = this.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute;
    const power = this.geometry.getAttribute('aPower') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (const f of this.flames) {
      if (!f.visible || !shown(f.parent)) continue;
      _m.compose(f.position, _q.identity(), f.scale).premultiply(f.parent.matrixWorld);
      this.mesh.setMatrixAt(n, _m);
      color.setXYZ(n, f.color.r, f.color.g, f.color.b);
      power.setX(n, f.power);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      color.needsUpdate = true;
      power.needsUpdate = true;
    }
  }

  dispose() {
    live.delete(this);
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
