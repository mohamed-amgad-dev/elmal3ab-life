import * as THREE from 'three';
import type { IEffectsManager } from '../../types/engine';
import type { Vec3 } from '../../types/game';

interface SparkParticle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
  age: number;
  lifetime: number;
  baseScale: number;
  rotSpeed: number;
  twinkle: boolean;
  r: number;
  g: number;
  b: number;
}

interface DustParticle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  lifetime: number;
  startScale: number;
  endScale: number;
  r: number;
  g: number;
  b: number;
}

interface StarParticle {
  alive: boolean;
  cx: number;
  cy: number;
  cz: number;
  orbitRadius: number;
  orbitAngle: number;
  orbitSpeed: number;
  bobOffset: number;
  age: number;
  lifetime: number;
  baseScale: number;
}

const MAX_SPARKS = 640;
const MAX_DUST = 180;
const MAX_STARS = 96;

const FIRE_PALETTE = [0xff4d00, 0xff9900, 0xffe600, 0xff1e56, 0x00f5ff];
const FIREWORK_ACCENTS = [0xffe600, 0x00f5ff, 0xff2e88, 0xa3ff12, 0xffffff];

function createStarGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const points = 5;
  const outerR = 0.22;
  const innerR = 0.095;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.05,
    bevelEnabled: false,
  });
  geo.center();
  return geo;
}

/**
 * Pooled Three.js VFX particle manager using compact InstancedMesh batches
 * (zero per-frame heap allocations) for kicks, super-shot fiery trails,
 * turf slide dust, comic spinning dive stars, and vibrant night fireworks.
 */
export class EffectsManager implements IEffectsManager {
  public readonly group: THREE.Group;

  private readonly sparkPool: SparkParticle[] = [];
  private readonly dustPool: DustParticle[] = [];
  private readonly starPool: StarParticle[] = [];

  private sparkCursor = 0;
  private dustCursor = 0;
  private starCursor = 0;

  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly dustMesh: THREE.InstancedMesh;
  private readonly starMesh: THREE.InstancedMesh;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  // Reusable scratch objects (zero per-frame allocations)
  private readonly dummy = new THREE.Object3D();
  private readonly colorTmp = new THREE.Color();
  private trailAccumulator = 0;
  private prevBallX = 0;
  private prevBallY = 0.42;
  private prevBallZ = 0;
  private hasPrevBall = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'effects_manager';

    // Initialize spark pool
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparkPool.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 12,
        drag: 1.5,
        age: 0,
        lifetime: 1,
        baseScale: 0.14,
        rotSpeed: 6,
        twinkle: false,
        r: 1,
        g: 1,
        b: 1,
      });
    }

    // Initialize dust pool
    for (let i = 0; i < MAX_DUST; i++) {
      this.dustPool.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        lifetime: 0.8,
        startScale: 0.14,
        endScale: 0.48,
        r: 0.85,
        g: 0.9,
        b: 0.8,
      });
    }

    // Initialize comic dive stars pool
    for (let i = 0; i < MAX_STARS; i++) {
      this.starPool.push({
        alive: false,
        cx: 0,
        cy: 0,
        cz: 0,
        orbitRadius: 0.65,
        orbitAngle: 0,
        orbitSpeed: 5,
        bobOffset: 0,
        age: 0,
        lifetime: 2.2,
        baseScale: 1,
      });
    }

    // 1. Sparks InstancedMesh (additive vibrant arcade glow)
    const sparkGeo = this.track(new THREE.OctahedronGeometry(0.16, 0));
    const sparkMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this.sparkMesh = this.track(new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS));
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.count = 0;
    this.sparkMesh.visible = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparkMesh.setColorAt(i, this.colorTmp.setHex(0xffffff));
    }
    this.group.add(this.sparkMesh);

    // 2. Slide Dust InstancedMesh (soft stylized turf puffs)
    const dustGeo = this.track(new THREE.DodecahedronGeometry(0.24, 0));
    const dustMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      })
    );
    this.dustMesh = this.track(new THREE.InstancedMesh(dustGeo, dustMat, MAX_DUST));
    this.dustMesh.frustumCulled = false;
    this.dustMesh.count = 0;
    this.dustMesh.visible = false;
    for (let i = 0; i < MAX_DUST; i++) {
      this.dustMesh.setColorAt(i, this.colorTmp.setHex(0xd8e8d0));
    }
    this.group.add(this.dustMesh);

    // 3. Comic Spinning Dive Stars InstancedMesh
    const starGeo = this.track(createStarGeometry());
    const starMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xffe600,
        toneMapped: false,
      })
    );
    this.starMesh = this.track(new THREE.InstancedMesh(starGeo, starMat, MAX_STARS));
    this.starMesh.frustumCulled = false;
    this.starMesh.count = 0;
    this.starMesh.visible = false;
    for (let i = 0; i < MAX_STARS; i++) {
      this.starMesh.setColorAt(i, this.colorTmp.setHex(0xffe600));
    }
    this.group.add(this.starMesh);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private allocSpark(): SparkParticle {
    const p = this.sparkPool[this.sparkCursor];
    this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
    return p;
  }

  private allocDust(): DustParticle {
    const p = this.dustPool[this.dustCursor];
    this.dustCursor = (this.dustCursor + 1) % MAX_DUST;
    return p;
  }

  private allocStar(): StarParticle {
    const p = this.starPool[this.starCursor];
    this.starCursor = (this.starCursor + 1) % MAX_STARS;
    return p;
  }

  public spawnBurst(pos: Vec3, color: number, count = 20, spread = 6.5): void {
    this.colorTmp.setHex(color);
    const cr = this.colorTmp.r;
    const cg = this.colorTmp.g;
    const cb = this.colorTmp.b;

    const total = Math.max(1, Math.min(count, 80));
    for (let i = 0; i < total; i++) {
      const p = this.allocSpark();
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.72;
      const spd = spread * (0.45 + Math.random() * 0.85);

      p.alive = true;
      p.x = pos.x + (Math.random() - 0.5) * 0.25;
      p.y = Math.max(0.12, pos.y + (Math.random() - 0.5) * 0.25);
      p.z = pos.z + (Math.random() - 0.5) * 0.25;
      p.vx = Math.sin(phi) * Math.cos(theta) * spd;
      p.vy = Math.cos(phi) * spd * 0.85 + 2.2;
      p.vz = Math.sin(phi) * Math.sin(theta) * spd;
      p.gravity = 16.5;
      p.drag = 2.1;
      p.age = 0;
      p.lifetime = 0.35 + Math.random() * 0.42;
      p.baseScale = 0.55 + Math.random() * 0.75;
      p.rotSpeed = 5 + Math.random() * 9;
      p.twinkle = false;

      // Slight hot highlight variance
      const boost = 0.85 + Math.random() * 0.3;
      p.r = Math.min(1, cr * boost);
      p.g = Math.min(1, cg * boost);
      p.b = Math.min(1, cb * boost);
    }
  }

  public spawnSlideDust(pos: Vec3): void {
    const count = 14;
    for (let i = 0; i < count; i++) {
      const d = this.allocDust();
      const angle = Math.random() * Math.PI * 2;
      const spd = 1.6 + Math.random() * 3.4;

      d.alive = true;
      d.x = pos.x + (Math.random() - 0.5) * 0.6;
      d.y = 0.14 + Math.random() * 0.16;
      d.z = pos.z + (Math.random() - 0.5) * 0.6;
      d.vx = Math.cos(angle) * spd;
      d.vy = 1.2 + Math.random() * 2.1;
      d.vz = Math.sin(angle) * spd;
      d.age = 0;
      d.lifetime = 0.48 + Math.random() * 0.36;
      d.startScale = 0.45 + Math.random() * 0.35;
      d.endScale = 1.55 + Math.random() * 0.85;

      // Mix of chalky beige dust & fresh grass-green spray
      if (i % 3 === 0) {
        d.r = 0.25;
        d.g = 0.78;
        d.b = 0.36;
      } else {
        d.r = 0.86;
        d.g = 0.84;
        d.b = 0.74;
      }
    }
  }

  public spawnDiveStars(pos: Vec3): void {
    const starCount = 7;
    const haloY = Math.max(0.85, pos.y + 1.15);
    for (let i = 0; i < starCount; i++) {
      const s = this.allocStar();
      s.alive = true;
      s.cx = pos.x;
      s.cy = haloY;
      s.cz = pos.z;
      s.orbitRadius = 0.62 + (i % 2) * 0.14;
      s.orbitAngle = (i * Math.PI * 2) / starCount;
      s.orbitSpeed = 4.6 + (i % 3) * 0.4;
      s.bobOffset = i * 1.1;
      s.age = 0;
      s.lifetime = 2.1 + Math.random() * 0.45;
      s.baseScale = 0.85 + (i % 2) * 0.3;
    }
    // Also spawn a tiny comic gold flash burst
    this.spawnBurst({ x: pos.x, y: haloY, z: pos.z }, 0xffe600, 12, 4.5);
  }

  public spawnFireworks(pos: Vec3, color: number): void {
    const primaryColor = this.colorTmp.setHex(color);
    const pr = primaryColor.r;
    const pg = primaryColor.g;
    const pb = primaryColor.b;

    const accentHex =
      FIREWORK_ACCENTS[Math.floor(Math.random() * FIREWORK_ACCENTS.length)];
    this.colorTmp.setHex(accentHex);
    const ar = this.colorTmp.r;
    const ag = this.colorTmp.g;
    const ab = this.colorTmp.b;

    // Outer spherical firework shell (38 bright streaks)
    const outerCount = 38;
    for (let i = 0; i < outerCount; i++) {
      const p = this.allocSpark();
      // Fibonacci-ish spherical shell distribution with light jitter
      const u = (i + 0.5) / outerCount;
      const phi = Math.acos(1 - 2 * u);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i + (Math.random() - 0.5) * 0.25;
      const spd = 8.5 + Math.random() * 4.5;

      p.alive = true;
      p.x = pos.x;
      p.y = pos.y;
      p.z = pos.z;
      p.vx = Math.sin(phi) * Math.cos(theta) * spd;
      p.vy = Math.cos(phi) * spd + 1.5;
      p.vz = Math.sin(phi) * Math.sin(theta) * spd;
      p.gravity = 5.4;
      p.drag = 1.65;
      p.age = 0;
      p.lifetime = 1.15 + Math.random() * 0.65;
      p.baseScale = 1.15 + Math.random() * 0.65;
      p.rotSpeed = 8;
      p.twinkle = true;
      p.r = pr;
      p.g = pg;
      p.b = pb;
    }

    // Inner bright accent core burst (20 particles)
    const innerCount = 20;
    for (let i = 0; i < innerCount; i++) {
      const p = this.allocSpark();
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const spd = 3.8 + Math.random() * 3.5;

      p.alive = true;
      p.x = pos.x;
      p.y = pos.y;
      p.z = pos.z;
      p.vx = Math.sin(phi) * Math.cos(theta) * spd;
      p.vy = Math.cos(phi) * spd + 0.8;
      p.vz = Math.sin(phi) * Math.sin(theta) * spd;
      p.gravity = 4.2;
      p.drag = 2.0;
      p.age = 0;
      p.lifetime = 0.8 + Math.random() * 0.55;
      p.baseScale = 0.85 + Math.random() * 0.5;
      p.rotSpeed = 12;
      p.twinkle = true;
      p.r = ar;
      p.g = ag;
      p.b = ab;
    }
  }

  private emitSuperShotTrail(ballPos: Vec3, dt: number): void {
    this.trailAccumulator += dt;
    const emitInterval = 0.014;
    let emitted = 0;
    while (this.trailAccumulator >= emitInterval && emitted < 6) {
      this.trailAccumulator -= emitInterval;
      emitted++;

      const frac = emitted / 6;
      const px = this.hasPrevBall
        ? this.prevBallX + (ballPos.x - this.prevBallX) * frac
        : ballPos.x;
      const py = this.hasPrevBall
        ? this.prevBallY + (ballPos.y - this.prevBallY) * frac
        : ballPos.y;
      const pz = this.hasPrevBall
        ? this.prevBallZ + (ballPos.z - this.prevBallZ) * frac
        : ballPos.z;

      const p = this.allocSpark();
      const hex = FIRE_PALETTE[Math.floor(Math.random() * FIRE_PALETTE.length)];
      this.colorTmp.setHex(hex);

      p.alive = true;
      p.x = px + (Math.random() - 0.5) * 0.34;
      p.y = Math.max(0.15, py + (Math.random() - 0.5) * 0.34);
      p.z = pz + (Math.random() - 0.5) * 0.34;
      p.vx = (Math.random() - 0.5) * 2.2;
      p.vy = 0.6 + Math.random() * 2.0;
      p.vz = (Math.random() - 0.5) * 2.2;
      p.gravity = -1.5; // Hot fire rises gently!
      p.drag = 3.2;
      p.age = 0;
      p.lifetime = 0.24 + Math.random() * 0.22;
      p.baseScale = 1.05 + Math.random() * 0.7;
      p.rotSpeed = 10;
      p.twinkle = false;
      p.r = this.colorTmp.r;
      p.g = this.colorTmp.g;
      p.b = this.colorTmp.b;
    }
  }

  public update(dt: number, ballPos: Vec3, isSuperShot: boolean): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);

    if (isSuperShot && safeDt > 0) {
      this.emitSuperShotTrail(ballPos, safeDt);
    } else {
      this.trailAccumulator = 0;
    }

    this.prevBallX = ballPos.x;
    this.prevBallY = ballPos.y;
    this.prevBallZ = ballPos.z;
    this.hasPrevBall = true;

    // 1. Update Sparks
    let sparkCount = 0;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const p = this.sparkPool[i];
      if (!p.alive) continue;

      p.age += safeDt;
      if (p.age >= p.lifetime) {
        p.alive = false;
        continue;
      }

      const dragFactor = Math.exp(-p.drag * safeDt);
      p.vx *= dragFactor;
      p.vz *= dragFactor;
      p.vy = p.vy * dragFactor - p.gravity * safeDt;

      p.x += p.vx * safeDt;
      p.y += p.vy * safeDt;
      p.z += p.vz * safeDt;

      if (p.y < 0.08) {
        p.y = 0.08;
        p.vy = Math.abs(p.vy) * 0.35;
      }

      const u = p.age / p.lifetime;
      let scale = p.baseScale * (1 - u * u);
      if (p.twinkle) {
        scale *= 0.65 + 0.55 * Math.abs(Math.sin(p.age * 24 + i));
      }

      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.age * p.rotSpeed, p.age * p.rotSpeed * 0.7, 0);
      this.dummy.scale.setScalar(Math.max(0.001, scale));
      this.dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(sparkCount, this.dummy.matrix);

      const fade = 1 - u * 0.7;
      this.colorTmp.setRGB(p.r * fade, p.g * fade, p.b * fade);
      this.sparkMesh.setColorAt(sparkCount, this.colorTmp);
      sparkCount++;
    }

    this.sparkMesh.count = sparkCount;
    this.sparkMesh.visible = sparkCount > 0;
    if (sparkCount > 0) {
      this.sparkMesh.instanceMatrix.needsUpdate = true;
      if (this.sparkMesh.instanceColor) {
        this.sparkMesh.instanceColor.needsUpdate = true;
      }
    }

    // 2. Update Dust Puffs
    let dustCount = 0;
    for (let i = 0; i < MAX_DUST; i++) {
      const d = this.dustPool[i];
      if (!d.alive) continue;

      d.age += safeDt;
      if (d.age >= d.lifetime) {
        d.alive = false;
        continue;
      }

      const dragF = Math.exp(-3.4 * safeDt);
      d.vx *= dragF;
      d.vz *= dragF;
      d.vy = d.vy * dragF - 2.6 * safeDt;

      d.x += d.vx * safeDt;
      d.y = Math.max(0.1, d.y + d.vy * safeDt);
      d.z += d.vz * safeDt;

      const u = d.age / d.lifetime;
      const scale = (d.startScale + (d.endScale - d.startScale) * u) * (1 - u * 0.65);

      this.dummy.position.set(d.x, d.y, d.z);
      this.dummy.rotation.set(d.age * 2.2, d.age * 1.8, 0);
      this.dummy.scale.setScalar(Math.max(0.001, scale));
      this.dummy.updateMatrix();
      this.dustMesh.setMatrixAt(dustCount, this.dummy.matrix);

      this.colorTmp.setRGB(d.r, d.g, d.b);
      this.dustMesh.setColorAt(dustCount, this.colorTmp);
      dustCount++;
    }

    this.dustMesh.count = dustCount;
    this.dustMesh.visible = dustCount > 0;
    if (dustCount > 0) {
      this.dustMesh.instanceMatrix.needsUpdate = true;
      if (this.dustMesh.instanceColor) {
        this.dustMesh.instanceColor.needsUpdate = true;
      }
    }

    // 3. Update Comic Spinning Dive Stars
    let starCount = 0;
    for (let i = 0; i < MAX_STARS; i++) {
      const s = this.starPool[i];
      if (!s.alive) continue;

      s.age += safeDt;
      if (s.age >= s.lifetime) {
        s.alive = false;
        continue;
      }

      s.orbitAngle += s.orbitSpeed * safeDt;
      const u = s.age / s.lifetime;
      const popIn = u < 0.12 ? u / 0.12 : 1;
      const fadeOut = u > 0.78 ? Math.max(0, (1 - u) / 0.22) : 1;
      const scale = s.baseScale * popIn * fadeOut;

      const x = s.cx + Math.cos(s.orbitAngle) * s.orbitRadius;
      const y = s.cy + Math.sin(s.age * 7 + s.bobOffset) * 0.16;
      const z = s.cz + Math.sin(s.orbitAngle) * s.orbitRadius;

      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0.35, s.age * 6.5, Math.sin(s.age * 9) * 0.35);
      this.dummy.scale.setScalar(Math.max(0.001, scale));
      this.dummy.updateMatrix();
      this.starMesh.setMatrixAt(starCount, this.dummy.matrix);

      // Alternate vibrant golden & bright white twinkle
      const flash = 0.8 + 0.2 * Math.sin(s.age * 18 + i);
      this.colorTmp.setRGB(1.0, 0.88 * flash, 0.15 * flash);
      this.starMesh.setColorAt(starCount, this.colorTmp);
      starCount++;
    }

    this.starMesh.count = starCount;
    this.starMesh.visible = starCount > 0;
    if (starCount > 0) {
      this.starMesh.instanceMatrix.needsUpdate = true;
      if (this.starMesh.instanceColor) {
        this.starMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  public dispose(): void {
    this.group.remove(this.sparkMesh);
    this.group.remove(this.dustMesh);
    this.group.remove(this.starMesh);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
