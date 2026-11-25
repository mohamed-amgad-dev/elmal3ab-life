import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { GraphicsQuality } from '../types/game';

export class SceneManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private outputPass: OutputPass | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private boundWindowResize: () => void;
  private currentQuality: GraphicsQuality = 'high';
  private maxDpr = 2;
  private bypassComposer = false;
  private disposed = false;

  constructor(container?: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050918);
    this.scene.fog = new THREE.FogExp2(0x081026, 0.0042);

    const initialW =
      container?.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 1280) ||
      1280;
    const initialH =
      container?.clientHeight ||
      (typeof window !== 'undefined' ? window.innerHeight : 720) ||
      720;

    this.camera = new THREE.PerspectiveCamera(
      52,
      Math.max(1, initialW) / Math.max(1, initialH),
      0.1,
      450
    );
    this.camera.position.set(0, 32, 46);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });

    const dpr =
      typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, 2)
        : 1;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(Math.max(1, initialW), Math.max(1, initialH), false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    this.initPostProcessing(Math.max(1, initialW), Math.max(1, initialH), dpr);

    this.boundWindowResize = () => {
      if (!this.disposed) {
        this.resize();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.boundWindowResize);
    }

    if (container) {
      this.mount(container);
    }
  }

  private initPostProcessing(width: number, height: number, dpr: number): void {
    try {
      const composer = new EffectComposer(this.renderer);
      composer.setPixelRatio(dpr);
      composer.setSize(width, height);

      const renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(renderPass);

      // Threshold ~0.82, strength ~0.62, radius ~0.42 so floodlights, volumetric cones,
      // VAR beacon, ad boards, super shots & fireworks glow richly without blowing out players/turf
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.62,
        0.42,
        0.82
      );
      composer.addPass(bloomPass);

      const outputPass = new OutputPass();
      composer.addPass(outputPass);

      this.composer = composer;
      this.bloomPass = bloomPass;
      this.outputPass = outputPass;
    } catch {
      this.composer = null;
      this.bloomPass = null;
      this.outputPass = null;
    }
  }

  public mount(container: HTMLElement): void {
    if (this.disposed) return;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.container = container;
    const canvas = this.renderer.domElement;
    if (canvas.parentElement !== container) {
      if (canvas.parentElement) {
        canvas.parentElement.removeChild(canvas);
      }
      container.appendChild(canvas);
    }

    this.resize(container.clientWidth, container.clientHeight);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        if (this.disposed) return;
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            this.resize(width, height);
          }
        }
      });
      this.resizeObserver.observe(container);
    }
  }

  public add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  public remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }

  public resize(w?: number, h?: number): void {
    if (this.disposed) return;

    const fallbackW =
      this.container?.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 1280) ||
      1280;
    const fallbackH =
      this.container?.clientHeight ||
      (typeof window !== 'undefined' ? window.innerHeight : 720) ||
      720;

    const width = Math.max(1, Math.floor(w ?? fallbackW));
    const height = Math.max(1, Math.floor(h ?? fallbackH));
    const dpr =
      typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, this.maxDpr)
        : 1;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(width, height);
    }
    if (this.bloomPass) {
      this.bloomPass.resolution.set(width, height);
    }
  }

  public setQuality(quality: GraphicsQuality): void {
    if (this.disposed) return;
    this.currentQuality = quality;

    if (quality === 'high') {
      this.maxDpr = 2;
      this.bypassComposer = false;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.bloomPass) {
        this.bloomPass.strength = 0.62;
      }
    } else if (quality === 'medium') {
      this.maxDpr = 1.35;
      this.bypassComposer = false;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.bloomPass) {
        this.bloomPass.strength = 0.42;
      }
    } else {
      // 'low': DPR 1, shadows off, bypass composer/bloom completely for max FPS
      this.maxDpr = 1;
      this.bypassComposer = true;
      this.renderer.shadowMap.enabled = false;
      this.renderer.shadowMap.needsUpdate = true;
    }

    this.resize();
  }

  public getQuality(): GraphicsQuality {
    return this.currentQuality;
  }

  public render(): void {
    if (this.disposed) return;

    if (!this.bypassComposer && this.composer) {
      try {
        this.composer.render();
        return;
      } catch {
        this.composer = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  public setBloomStrength(strength: number): void {
    if (this.bloomPass) {
      this.bloomPass.strength = strength;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.boundWindowResize);
    }

    if (this.bloomPass) {
      this.bloomPass.dispose();
      this.bloomPass = null;
    }

    if (this.outputPass && 'dispose' in this.outputPass && typeof this.outputPass.dispose === 'function') {
      this.outputPass.dispose();
      this.outputPass = null;
    }

    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }

    this.renderer.dispose();

    const canvas = this.renderer.domElement;
    if (canvas && canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    this.container = null;
  }
}
