import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAberration: { value: 0.0015 },
    uVignette: { value: 0.9 },
    uDamage: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uDamage;
    varying vec2 vUv;
    float rand(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 c = vUv - 0.5;
      float d = length(c);
      vec2 off = c * (uAberration + uDamage*0.006) * (1.0 + d*2.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float vig = smoothstep(0.85, 0.25, d * uVignette);
      col *= mix(0.55, 1.0, vig);
      col += (rand(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.025;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** Bloom + tone mapping + lens (aberration, vignette, grain). */
export class PostFX {
  readonly composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private final: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, msaa: number) {
    const size = renderer.getSize(new THREE.Vector2());
    // The composer renders off-screen, so the canvas' own antialiasing does not
    // apply: use a multisampled HDR target instead.
    const target = new THREE.WebGLRenderTarget(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio(), {
      type: THREE.HalfFloatType,
      samples: msaa,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.5, 0.45, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  dispose() {
    this.bloom.dispose();
    this.composer.dispose();
  }

  render(time: number, damage: number) {
    this.final.uniforms.uTime.value = time % 100;
    this.final.uniforms.uDamage.value = damage;
    this.composer.render();
  }
}
