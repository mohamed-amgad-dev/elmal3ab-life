import * as THREE from 'three';
import type { IStadiumScene } from '../../types/engine';
import type { TeamId, Vec3 } from '../../types/game';
import {
  DEFAULT_STADIUM_CONFIG,
  type StadiumConfig,
} from '../../types/stadium';
import { NightLighting } from '../lighting/NightLighting';
import { DugoutAndVAR } from './DugoutAndVAR';
import { GoalNet } from './GoalNet';
import { PitchBuilder } from './PitchBuilder';
import { StandsAndCrowd } from './StandsAndCrowd';

interface FireworkRocket {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  targetY: number;
  colorHex: number;
  secondaryHex: number;
  trailTimer: number;
}

interface FireworkSpark {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  age: number;
  life: number;
}

const MAX_FIREWORK_SPARKS = 640;

export class StadiumScene implements IStadiumScene {
  public readonly group: THREE.Group;
  public readonly config: StadiumConfig;

  private lighting: NightLighting;
  private pitch: PitchBuilder;
  private goals: GoalNet;
  private standsAndCrowd: StandsAndCrowd;
  private dugoutAndVAR: DugoutAndVAR;

  private celebrationTeam: TeamId | null = null;
  private celebrationTimer = 0;
  private nextSalvoTimer = 0;

  // Built-in stadium sky fireworks & rocket system
  private rockets: FireworkRocket[] = [];
  private sparks: FireworkSpark[] = [];
  private sparkCursor = 0;
  private sparkGeometry!: THREE.BufferGeometry;
  private sparkMaterial!: THREE.PointsMaterial;
  private sparkTexture!: THREE.CanvasTexture;
  private sparkPositions!: Float32Array;
  private sparkColors!: Float32Array;
  private tempColor = new THREE.Color();

  constructor(config: StadiumConfig = DEFAULT_STADIUM_CONFIG) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'StadiumScene';

    this.lighting = new NightLighting(this.config);
    this.pitch = new PitchBuilder(this.config);
    this.goals = new GoalNet(this.config);
    this.standsAndCrowd = new StandsAndCrowd(this.config);
    this.dugoutAndVAR = new DugoutAndVAR(this.config);

    this.group.add(
      this.lighting.group,
      this.pitch.group,
      this.goals.group,
      this.standsAndCrowd.group,
      this.dugoutAndVAR.group
    );

    this.initFireworksSystem();
  }

  private initFireworksSystem(): void {
    this.sparkPositions = new Float32Array(MAX_FIREWORK_SPARKS * 3);
    this.sparkColors = new Float32Array(MAX_FIREWORK_SPARKS * 3);

    for (let i = 0; i < MAX_FIREWORK_SPARKS; i++) {
      this.sparkPositions[i * 3 + 1] = -500;
      this.sparks.push({
        active: false,
        x: 0,
        y: -500,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        r: 1,
        g: 1,
        b: 1,
        age: 0,
        life: 1,
      });
    }

    this.sparkGeometry = new THREE.BufferGeometry();
    this.sparkGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.sparkPositions, 3)
    );
    this.sparkGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.sparkColors, 3)
    );

    this.sparkTexture = this.createSparkSpriteTexture();
    this.sparkMaterial = new THREE.PointsMaterial({
      size: 1.15,
      map: this.sparkTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    points.frustumCulled = false;
    points.name = 'StadiumFireworks';
    this.group.add(points);
  }

  private createSparkSpriteTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.35, 'rgba(255, 250, 220, 0.85)');
    grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.25)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  private emitSpark(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    colorHex: number,
    life: number
  ): void {
    const s = this.sparks[this.sparkCursor];
    this.sparkCursor = (this.sparkCursor + 1) % MAX_FIREWORK_SPARKS;

    this.tempColor.setHex(colorHex);
    s.active = true;
    s.x = x;
    s.y = y;
    s.z = z;
    s.vx = vx;
    s.vy = vy;
    s.vz = vz;
    // Multiply RGB > 1 slightly so UnrealBloomPass catches the firework sparks vividly
    s.r = Math.min(1, this.tempColor.r * 1.15);
    s.g = Math.min(1, this.tempColor.g * 1.15);
    s.b = Math.min(1, this.tempColor.b * 1.15);
    s.age = 0;
    s.life = life;
  }

  private explodeRocket(rocket: FireworkRocket): void {
    const burstCount = 54;
    for (let i = 0; i < burstCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 5.5 + Math.random() * 8.5;

      const vx = Math.sin(phi) * Math.cos(theta) * speed;
      const vy = Math.cos(phi) * speed + 2.2;
      const vz = Math.sin(phi) * Math.sin(theta) * speed;

      const hex = i % 3 === 0 ? rocket.secondaryHex : rocket.colorHex;
      this.emitSpark(
        rocket.pos.x,
        rocket.pos.y,
        rocket.pos.z,
        vx,
        vy,
        vz,
        hex,
        0.95 + Math.random() * 0.65
      );
    }
  }

  public triggerGoalNetRipple(side: TeamId, impactPos: Vec3): void {
    this.goals.triggerGoalNetRipple(side, impactPos);
  }

  public triggerGoalCelebration(scoringTeam: TeamId): void {
    this.celebrationTeam = scoringTeam;
    this.celebrationTimer = 4.2;
    this.nextSalvoTimer = 0.55;
    this.standsAndCrowd.setCrowdExcitement(1.0);

    const primaryHex =
      scoringTeam === 'red'
        ? this.config.colors.redTeam
        : this.config.colors.blueTeam;
    const secondaryHex = 0xffd426; // Egyptian gold accent

    // Red scores into Blue's goal (+Z = +34); Blue scores into Red's goal (-Z = -34)
    const targetGoalZ =
      scoringTeam === 'red' ? this.config.halfLength + 4 : -this.config.halfLength - 4;

    // Launch celebratory rocket salvo behind the goal and above the corners
    const launchSites: [number, number][] = [
      [-14, targetGoalZ],
      [-7, targetGoalZ],
      [0, targetGoalZ],
      [7, targetGoalZ],
      [14, targetGoalZ],
      [-28, 0],
      [28, 0],
    ];

    for (const [lx, lz] of launchSites) {
      this.rockets.push({
        pos: new THREE.Vector3(
          lx + (Math.random() - 0.5) * 2,
          2.0,
          lz + (Math.random() - 0.5) * 2
        ),
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 2.5,
          22 + Math.random() * 6,
          (Math.random() - 0.5) * 2.5
        ),
        targetY: 19 + Math.random() * 7,
        colorHex: primaryHex,
        secondaryHex,
        trailTimer: 0,
      });
    }
  }

  public triggerCrowdFireworks(): void {
    this.standsAndCrowd.setCrowdExcitement(0.95);

    const carnivalColors = [
      this.config.colors.redTeam,
      this.config.colors.blueTeam,
      0xffd426,
      0x00f0ff,
      0xff2a85,
      0x22ff88,
    ];

    const ringPositions: [number, number][] = [
      [-33, -20],
      [-33, 20],
      [33, -20],
      [33, 20],
      [-16, -42],
      [16, -42],
      [-16, 42],
      [16, 42],
    ];

    ringPositions.forEach(([rx, rz], idx) => {
      const c1 = carnivalColors[idx % carnivalColors.length];
      const c2 = carnivalColors[(idx + 2) % carnivalColors.length];
      this.rockets.push({
        pos: new THREE.Vector3(rx, 8.0, rz),
        vel: new THREE.Vector3(
          -Math.sign(rx) * (1.2 + Math.random() * 1.5),
          20 + Math.random() * 6,
          -Math.sign(rz) * (1.2 + Math.random() * 1.5)
        ),
        targetY: 22 + Math.random() * 7,
        colorHex: c1,
        secondaryHex: c2,
        trailTimer: 0,
      });
    });
  }

  public setCrowdExcitement(level: number): void {
    this.standsAndCrowd.setCrowdExcitement(level);
  }

  public setVARActive(active: boolean): void {
    this.dugoutAndVAR.setVARActive(active);
  }

  public getBenchSeatPosition(team: TeamId, slotIndex: number): Vec3 {
    return this.dugoutAndVAR.getBenchSeatPosition(team, slotIndex);
  }

  public update(dt: number, elapsed: number): void {
    const clampedDt = Math.min(dt, 0.1);

    if (this.celebrationTimer > 0) {
      this.celebrationTimer = Math.max(0, this.celebrationTimer - clampedDt);

      // Launch follow-up celebratory firework bursts while goal celebration is active
      if (this.celebrationTimer > 1.1 && this.celebrationTeam) {
        this.nextSalvoTimer -= clampedDt;
        if (this.nextSalvoTimer <= 0) {
          this.nextSalvoTimer = 0.75;
          const primaryHex =
            this.celebrationTeam === 'red'
              ? this.config.colors.redTeam
              : this.config.colors.blueTeam;
          const angle = Math.random() * Math.PI * 2;
          const rx = Math.cos(angle) * 30;
          const rz = Math.sin(angle) * 38;
          this.rockets.push({
            pos: new THREE.Vector3(rx, 6, rz),
            vel: new THREE.Vector3(0, 22 + Math.random() * 5, 0),
            targetY: 21 + Math.random() * 6,
            colorHex: primaryHex,
            secondaryHex: 0xffd426,
            trailTimer: 0,
          });
        }
      }

      if (this.celebrationTimer === 0) {
        this.celebrationTeam = null;
      }
    }

    this.lighting.update(
      clampedDt,
      elapsed,
      this.celebrationTeam,
      this.celebrationTimer
    );
    this.pitch.update(elapsed);
    this.goals.update(clampedDt, elapsed);
    this.standsAndCrowd.update(
      clampedDt,
      elapsed,
      this.celebrationTeam,
      this.celebrationTimer
    );
    this.dugoutAndVAR.update(clampedDt, elapsed);
    this.updateFireworks(clampedDt);
  }

  private updateFireworks(dt: number): void {
    // Update ascending rockets
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.pos.addScaledVector(r.vel, dt);
      r.vel.y -= 6.5 * dt;

      r.trailTimer += dt;
      if (r.trailTimer >= 0.025) {
        r.trailTimer = 0;
        this.emitSpark(
          r.pos.x + (Math.random() - 0.5) * 0.2,
          r.pos.y,
          r.pos.z + (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 1.2,
          -2.0,
          (Math.random() - 0.5) * 1.2,
          0xffd426,
          0.32
        );
      }

      if (r.pos.y >= r.targetY || r.vel.y <= 1.0) {
        this.explodeRocket(r);
        this.rockets.splice(i, 1);
      }
    }

    // Update active starburst sparks
    let anyUpdated = false;
    for (let i = 0; i < MAX_FIREWORK_SPARKS; i++) {
      const s = this.sparks[i];
      const idx = i * 3;
      if (!s.active) continue;

      anyUpdated = true;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        this.sparkPositions[idx + 1] = -500;
        this.sparkColors[idx] = 0;
        this.sparkColors[idx + 1] = 0;
        this.sparkColors[idx + 2] = 0;
        continue;
      }

      // Air drag + gravity
      const drag = Math.max(0, 1 - dt * 1.6);
      s.vx *= drag;
      s.vz *= drag;
      s.vy = s.vy * drag - 9.2 * dt;

      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;

      const fade = 1.0 - s.age / s.life;
      this.sparkPositions[idx] = s.x;
      this.sparkPositions[idx + 1] = s.y;
      this.sparkPositions[idx + 2] = s.z;

      this.sparkColors[idx] = s.r * fade;
      this.sparkColors[idx + 1] = s.g * fade;
      this.sparkColors[idx + 2] = s.b * fade;
    }

    if (anyUpdated || this.rockets.length > 0) {
      (
        this.sparkGeometry.attributes.position as THREE.BufferAttribute
      ).needsUpdate = true;
      (
        this.sparkGeometry.attributes.color as THREE.BufferAttribute
      ).needsUpdate = true;
    }
  }

  public dispose(): void {
    this.lighting.dispose();
    this.pitch.dispose();
    this.goals.dispose();
    this.standsAndCrowd.dispose();
    this.dugoutAndVAR.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
    this.sparkTexture.dispose();
    this.rockets = [];
  }
}
