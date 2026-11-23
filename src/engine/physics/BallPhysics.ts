import * as THREE from 'three';
import type { BallTickResult, IBallPhysics } from '../../types/engine';
import type { BallStateSnapshot, TeamId, Vec3 } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

const BALL_RADIUS = 0.42;
const GRAVITY = 26.0;
const AIR_DRAG = 0.34;
const GRASS_FRICTION = 1.65;
const GROUND_RESTITUTION = 0.62;
const WALL_RESTITUTION = 0.72;
const POST_RESTITUTION = 0.78;
const POST_RADIUS = 0.15;
const MAGNUS_STRENGTH = 0.042;
const SPIN_DECAY = 1.15;
const MAX_SUBSTEP = 1 / 120;
const TRAJ_MAX_POINTS = 40;

/**
 * Generates a crisp stylized arcade football CanvasTexture with classic
 * dark pentagon patches, bright white panels, and subtle neon cyan/gold seams
 * that reads vividly under night stadium floodlights.
 */
function createFootballTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  // Crisp bright white base
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 512, 256);

  // Subtle geometric seam grid in electric cyan
  ctx.strokeStyle = '#00c2ff';
  ctx.lineWidth = 3;
  for (let y = 0; y <= 256; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  for (let x = 0; x <= 512; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 32, 128);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }

  // Draw stylized dark pentagon patches wrapped cleanly across equirectangular UV
  const drawPentagon = (cx: number, cy: number, r: number, color: string, glowColor: string) => {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = glowColor;
    ctx.stroke();
    ctx.restore();
  };

  // Top & bottom polar bands
  for (let x = 32; x < 512; x += 128) {
    drawPentagon(x, 34, 24, '#0f172a', '#ffd166');
    drawPentagon(x + 64, 222, 24, '#0f172a', '#ffd166');
  }
  // Equatorial iconic pentagons
  for (let x = 0; x <= 512; x += 128) {
    drawPentagon(x, 128, 30, '#0f172a', '#00e5ff');
    drawPentagon(x + 64, 128, 22, '#ff2e4c', '#ffd166');
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Computes closest point on segment AB to point P without allocating.
 */
function closestPointOnSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-8) {
    return out.set(ax, ay, az);
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / abLenSq)
  );
  return out.set(ax + abx * t, ay + aby * t, az + abz * t);
}

/**
 * Stylized 3D football with arcade physics (gravity, grass drag, bounce,
 * Magnus curve spin, super-shot fiery glow, goal-post/crossbar collisions,
 * goal-line detection, cushion bounds, VAR replay transform hooks, and
 * incoming GK trajectory visualization).
 */
export class BallPhysics implements IBallPhysics {
  public readonly mesh: THREE.Group;
  public readonly trajectoryLine: THREE.Group;
  public readonly state: BallStateSnapshot;

  private readonly ballSphere: THREE.Mesh;
  private readonly superShotAura: THREE.Mesh;
  private readonly superShotAuraMat: THREE.MeshBasicMaterial;
  private readonly shadowDisc: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;

  private readonly trajLineMesh: THREE.Line;
  private readonly trajPositions: Float32Array;
  private readonly trajGeo: THREE.BufferGeometry;
  private readonly trajTargetRing: THREE.Mesh;
  private readonly trajTargetMat: THREE.MeshBasicMaterial;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  private frozen = false;
  private scoredInsideNet: TeamId | null = null;
  private trajectoryVisible = false;
  private trajectoryTargetGoalZ = -34;
  private visualElapsed = 0;

  // Reusable scratch math objects (zero per-frame GC)
  private readonly rollAxis = new THREE.Vector3();
  private readonly rollDeltaQuat = new THREE.Quaternion();
  private readonly closestTmp = new THREE.Vector3();

  constructor() {
    this.state = {
      pos: { x: 0, y: BALL_RADIUS, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      spin: { x: 0, y: 0, z: 0 },
      isSuperShot: false,
      lastTouchPlayerId: null,
      lastTouchTeam: null,
    };

    this.mesh = new THREE.Group();
    this.mesh.name = 'football_root';

    // Stylized iconic football sphere
    const ballTex = this.track(createFootballTexture());
    const sphereGeo = this.track(new THREE.SphereGeometry(BALL_RADIUS, 24, 18));
    const sphereMat = this.track(
      new THREE.MeshStandardMaterial({
        map: ballTex,
        roughness: 0.34,
        metalness: 0.08,
        emissive: new THREE.Color(0x0b1528),
        emissiveIntensity: 0.16,
      })
    );
    this.ballSphere = new THREE.Mesh(sphereGeo, sphereMat);
    this.ballSphere.castShadow = true;
    this.ballSphere.receiveShadow = true;
    this.mesh.add(this.ballSphere);

    // Super-shot fiery glowing outer shell
    const auraGeo = this.track(new THREE.SphereGeometry(BALL_RADIUS * 1.38, 16, 12));
    this.superShotAuraMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xff6a00,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.superShotAura = new THREE.Mesh(auraGeo, this.superShotAuraMat);
    this.superShotAura.visible = false;
    this.mesh.add(this.superShotAura);

    // Soft ground contact shadow disc (stays pinned to turf Y = 0.03)
    const shadowGeo = this.track(new THREE.CircleGeometry(BALL_RADIUS * 1.25, 20));
    this.shadowMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x04070e,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this.shadowDisc = new THREE.Mesh(shadowGeo, this.shadowMat);
    this.shadowDisc.rotation.x = -Math.PI / 2;
    this.shadowDisc.position.y = 0.03 - BALL_RADIUS;
    this.mesh.add(this.shadowDisc);

    // Trajectory arc group (only visible in gk_first_person!)
    this.trajectoryLine = new THREE.Group();
    this.trajectoryLine.name = 'ball_trajectory_arc';
    this.trajectoryLine.visible = false;

    this.trajPositions = new Float32Array(TRAJ_MAX_POINTS * 3);
    this.trajGeo = this.track(new THREE.BufferGeometry());
    this.trajGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trajPositions, 3)
    );
    const trajMat = this.track(
      new THREE.LineDashedMaterial({
        color: 0x00f5ff,
        dashSize: 0.65,
        gapSize: 0.4,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    this.trajLineMesh = new THREE.Line(this.trajGeo, trajMat);
    this.trajLineMesh.frustumCulled = false;
    this.trajectoryLine.add(this.trajLineMesh);

    // Glowing impact target ring on the goal plane
    const ringGeo = this.track(new THREE.RingGeometry(0.45, 0.72, 28));
    this.trajTargetMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xffe600,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this.trajTargetRing = new THREE.Mesh(ringGeo, this.trajTargetMat);
    this.trajTargetRing.visible = false;
    this.trajectoryLine.add(this.trajTargetRing);

    this.syncVisualMesh();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  public reset(pos?: Vec3): void {
    const rx = pos ? pos.x : 0;
    const ry = pos ? Math.max(BALL_RADIUS, pos.y) : BALL_RADIUS;
    const rz = pos ? pos.z : 0;

    this.state.pos.x = rx;
    this.state.pos.y = ry;
    this.state.pos.z = rz;
    this.state.vel.x = 0;
    this.state.vel.y = 0;
    this.state.vel.z = 0;
    this.state.spin.x = 0;
    this.state.spin.y = 0;
    this.state.spin.z = 0;
    this.state.isSuperShot = false;
    this.state.lastTouchPlayerId = null;
    this.state.lastTouchTeam = null;
    this.scoredInsideNet = null;
    this.frozen = false;

    this.ballSphere.quaternion.identity();
    this.syncVisualMesh();
  }

  public kick(
    dir: Vec3,
    power: number,
    lift = 0,
    isSuperShot = false,
    byPlayerId?: string,
    byTeam?: TeamId
  ): void {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const nx = len > 1e-5 ? dir.x / len : 0;
    const ny = len > 1e-5 ? dir.y / len : 0;
    const nz = len > 1e-5 ? dir.z / len : 1;

    this.state.vel.x = nx * power;
    this.state.vel.y = Math.max(0, ny * power + lift);
    this.state.vel.z = nz * power;

    // Add lively arcade curve spin for angled/super shots
    const curveSign = nx >= 0 ? 1 : -1;
    this.state.spin.y = isSuperShot
      ? curveSign * Math.min(18, power * 0.42)
      : curveSign * Math.min(8, Math.abs(nx) * power * 0.25);
    this.state.spin.x = nz * (isSuperShot ? -8 : -3);
    this.state.spin.z = -nx * (isSuperShot ? -8 : -3);

    this.state.isSuperShot = isSuperShot;
    if (byPlayerId !== undefined) {
      this.state.lastTouchPlayerId = byPlayerId;
    }
    if (byTeam !== undefined) {
      this.state.lastTouchTeam = byTeam;
    }
    this.frozen = false;
  }

  public setPositionAndStop(pos: Vec3): void {
    this.state.pos.x = pos.x;
    this.state.pos.y = Math.max(BALL_RADIUS, pos.y);
    this.state.pos.z = pos.z;
    this.state.vel.x = 0;
    this.state.vel.y = 0;
    this.state.vel.z = 0;
    this.state.spin.x = 0;
    this.state.spin.y = 0;
    this.state.spin.z = 0;
    this.state.isSuperShot = false;
    this.scoredInsideNet = null;
    this.syncVisualMesh();
  }

  public setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  public setTrajectoryVisible(visible: boolean, targetGoalZ?: number): void {
    this.trajectoryVisible = visible;
    if (targetGoalZ !== undefined) {
      this.trajectoryTargetGoalZ = targetGoalZ;
    }
    if (!visible) {
      this.trajectoryLine.visible = false;
      this.trajTargetRing.visible = false;
    }
  }

  public update(dt: number, config: StadiumConfig): BallTickResult {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    this.visualElapsed += safeDt;

    if (this.frozen || safeDt <= 0) {
      this.updateVisualEffects();
      this.updateTrajectoryArc(config);
      const spd = Math.hypot(this.state.vel.x, this.state.vel.y, this.state.vel.z);
      return { goalScored: null, hitPost: false, bounced: false, speed: spd };
    }

    const substeps = Math.max(1, Math.min(4, Math.ceil(safeDt / MAX_SUBSTEP)));
    const subDt = safeDt / substeps;

    let goalScored: TeamId | null = null;
    let hitPost = false;
    let bounced = false;

    const goalHalfW = config.goalWidth * 0.5;
    const pos = this.state.pos;
    const vel = this.state.vel;
    const spin = this.state.spin;

    for (let s = 0; s < substeps; s++) {
      // Gravity
      vel.y -= GRAVITY * subDt;

      // Magnus curve force: cross(spin, vel) * MAGNUS_STRENGTH
      const mx = (spin.y * vel.z - spin.z * vel.y) * MAGNUS_STRENGTH;
      const my = (spin.z * vel.x - spin.x * vel.z) * MAGNUS_STRENGTH * 0.45;
      const mz = (spin.x * vel.y - spin.y * vel.x) * MAGNUS_STRENGTH;
      vel.x += mx * subDt;
      vel.y += my * subDt;
      vel.z += mz * subDt;

      // Air drag & spin decay
      const airFactor = Math.exp(-AIR_DRAG * subDt);
      vel.x *= airFactor;
      vel.z *= airFactor;
      const spinFactor = Math.exp(-SPIN_DECAY * subDt);
      spin.x *= spinFactor;
      spin.y *= spinFactor;
      spin.z *= spinFactor;

      // Integrate position
      pos.x += vel.x * subDt;
      pos.y += vel.y * subDt;
      pos.z += vel.z * subDt;

      // Ground collision & grass friction
      if (pos.y <= BALL_RADIUS) {
        pos.y = BALL_RADIUS;
        if (vel.y < -1.8) {
          vel.y = -vel.y * GROUND_RESTITUTION;
          bounced = true;
          spin.y *= 0.85;
        } else {
          vel.y = 0;
          // Rolling grass friction
          const grassFactor = Math.exp(-GRASS_FRICTION * subDt);
          vel.x *= grassFactor;
          vel.z *= grassFactor;
          if (Math.hypot(vel.x, vel.z) < 0.08) {
            vel.x = 0;
            vel.z = 0;
          }
        }
      }

      // Goalposts & crossbar collisions at both ends (+halfLength and -halfLength)
      if (this.collideGoalFrame(config.halfLength, goalHalfW, config.goalHeight)) {
        hitPost = true;
      }
      if (this.collideGoalFrame(-config.halfLength, goalHalfW, config.goalHeight)) {
        hitPost = true;
      }

      // Check goal mouth & net boundaries vs pitch cushion boundaries
      const insideGoalX = Math.abs(pos.x) < goalHalfW - 0.05;
      const insideGoalY = pos.y < config.goalHeight - 0.05;

      // Reset net flag if ball returns well onto the field
      if (Math.abs(pos.z) < config.halfLength - 1.0) {
        this.scoredInsideNet = null;
      }

      // +Z Goal (Blue's goal -> RED scores!)
      if (pos.z > config.halfLength) {
        if (insideGoalX && insideGoalY) {
          if (this.scoredInsideNet === null) {
            this.scoredInsideNet = 'red';
            goalScored = 'red';
          }
          // Soft net containment inside +Z goal
          const maxGoalZ = config.halfLength + config.goalDepth - BALL_RADIUS;
          if (pos.z > maxGoalZ) {
            pos.z = maxGoalZ;
            vel.z = -Math.abs(vel.z) * 0.22;
            vel.x *= 0.65;
            vel.y *= 0.65;
          }
          const maxNetX = goalHalfW - BALL_RADIUS;
          if (pos.x > maxNetX) {
            pos.x = maxNetX;
            vel.x = -Math.abs(vel.x) * 0.3;
          } else if (pos.x < -maxNetX) {
            pos.x = -maxNetX;
            vel.x = Math.abs(vel.x) * 0.3;
          }
          const maxNetY = config.goalHeight - BALL_RADIUS;
          if (pos.y > maxNetY) {
            pos.y = maxNetY;
            vel.y = -Math.abs(vel.y) * 0.3;
          }
        } else if (this.scoredInsideNet !== 'red') {
          // Pitch endline cushion bounce outside goal mouth
          pos.z = config.halfLength - BALL_RADIUS;
          vel.z = -Math.abs(vel.z) * WALL_RESTITUTION;
          bounced = true;
        }
      }

      // -Z Goal (Red's goal -> BLUE scores!)
      if (pos.z < -config.halfLength) {
        if (insideGoalX && insideGoalY) {
          if (this.scoredInsideNet === null) {
            this.scoredInsideNet = 'blue';
            goalScored = 'blue';
          }
          // Soft net containment inside -Z goal
          const minGoalZ = -(config.halfLength + config.goalDepth - BALL_RADIUS);
          if (pos.z < minGoalZ) {
            pos.z = minGoalZ;
            vel.z = Math.abs(vel.z) * 0.22;
            vel.x *= 0.65;
            vel.y *= 0.65;
          }
          const maxNetX = goalHalfW - BALL_RADIUS;
          if (pos.x > maxNetX) {
            pos.x = maxNetX;
            vel.x = -Math.abs(vel.x) * 0.3;
          } else if (pos.x < -maxNetX) {
            pos.x = -maxNetX;
            vel.x = Math.abs(vel.x) * 0.3;
          }
          const maxNetY = config.goalHeight - BALL_RADIUS;
          if (pos.y > maxNetY) {
            pos.y = maxNetY;
            vel.y = -Math.abs(vel.y) * 0.3;
          }
        } else if (this.scoredInsideNet !== 'blue') {
          pos.z = -config.halfLength + BALL_RADIUS;
          vel.z = Math.abs(vel.z) * WALL_RESTITUTION;
          bounced = true;
        }
      }

      // Sideline cushion bounces (±halfWidth)
      const maxX = config.halfWidth - BALL_RADIUS;
      if (pos.x > maxX) {
        pos.x = maxX;
        vel.x = -Math.abs(vel.x) * WALL_RESTITUTION;
        bounced = true;
      } else if (pos.x < -maxX) {
        pos.x = -maxX;
        vel.x = Math.abs(vel.x) * WALL_RESTITUTION;
        bounced = true;
      }
    }

    // Roll visual quaternion smoothly from linear velocity
    const horizSpeed = Math.hypot(vel.x, vel.z);
    const totalSpeed = Math.hypot(vel.x, vel.y, vel.z);
    if (horizSpeed > 0.05) {
      this.rollAxis.set(vel.z, 0, -vel.x).normalize();
      const rollAngle = (horizSpeed * safeDt) / BALL_RADIUS;
      this.rollDeltaQuat.setFromAxisAngle(this.rollAxis, rollAngle);
      this.ballSphere.quaternion.premultiply(this.rollDeltaQuat);
    }

    // Auto-clear super shot glow once ball slows down significantly
    if (this.state.isSuperShot && totalSpeed < 10.5) {
      this.state.isSuperShot = false;
    }

    this.syncVisualMesh();
    this.updateVisualEffects();
    this.updateTrajectoryArc(config);

    return {
      goalScored,
      hitPost,
      bounced,
      speed: totalSpeed,
    };
  }

  private collideGoalFrame(goalZ: number, goalHalfW: number, goalHeight: number): boolean {
    const pos = this.state.pos;
    // Quick Z broadphase reject
    if (Math.abs(pos.z - goalZ) > BALL_RADIUS + POST_RADIUS + 0.6) {
      return false;
    }

    let hit = false;
    const minDist = BALL_RADIUS + POST_RADIUS;

    // 1. Left Post: (-goalHalfW, 0, goalZ) -> (-goalHalfW, goalHeight, goalZ)
    hit =
      this.collideSegment(
        -goalHalfW,
        0,
        goalZ,
        -goalHalfW,
        goalHeight,
        goalZ,
        minDist
      ) || hit;

    // 2. Right Post: (+goalHalfW, 0, goalZ) -> (+goalHalfW, goalHeight, goalZ)
    hit =
      this.collideSegment(
        goalHalfW,
        0,
        goalZ,
        goalHalfW,
        goalHeight,
        goalZ,
        minDist
      ) || hit;

    // 3. Crossbar: (-goalHalfW, goalHeight, goalZ) -> (+goalHalfW, goalHeight, goalZ)
    hit =
      this.collideSegment(
        -goalHalfW,
        goalHeight,
        goalZ,
        goalHalfW,
        goalHeight,
        goalZ,
        minDist
      ) || hit;

    return hit;
  }

  private collideSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    minDist: number
  ): boolean {
    const pos = this.state.pos;
    const vel = this.state.vel;

    const cp = closestPointOnSegment(
      pos.x,
      pos.y,
      pos.z,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      this.closestTmp
    );
    const dx = pos.x - cp.x;
    const dy = pos.y - cp.y;
    const dz = pos.z - cp.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq >= minDist * minDist || distSq < 1e-10) {
      return false;
    }

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;

    // Push ball cleanly outside post/crossbar
    const overlap = minDist - dist;
    pos.x += nx * overlap;
    pos.y += ny * overlap;
    pos.z += nz * overlap;

    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) {
      const impulse = -(1 + POST_RESTITUTION) * vn;
      vel.x += nx * impulse;
      vel.y += ny * impulse;
      vel.z += nz * impulse;
      return true;
    }

    return false;
  }

  private syncVisualMesh(): void {
    const { x, y, z } = this.state.pos;
    this.mesh.position.set(x, y, z);

    // Keep ground shadow pinned flat on turf and fade/scale with altitude
    this.shadowDisc.position.y = 0.03 - y;
    const heightAboveGround = Math.max(0, y - BALL_RADIUS);
    const shadowScale = Math.max(0.35, 1 - heightAboveGround * 0.14);
    this.shadowDisc.scale.set(shadowScale, shadowScale, 1);
    this.shadowMat.opacity = Math.max(0.12, 0.46 - heightAboveGround * 0.08);
  }

  private updateVisualEffects(): void {
    if (this.state.isSuperShot) {
      this.superShotAura.visible = true;
      const pulse = 1 + Math.sin(this.visualElapsed * 28) * 0.16;
      this.superShotAura.scale.setScalar(pulse);
      this.superShotAuraMat.opacity = 0.55 + Math.sin(this.visualElapsed * 22) * 0.18;
    } else {
      this.superShotAura.visible = false;
      this.superShotAuraMat.opacity = 0;
    }
  }

  /**
   * Predicts incoming shot arc toward `trajectoryTargetGoalZ` without heap
   * allocations, giving `gk_first_person` players a crisp arcade read.
   */
  private updateTrajectoryArc(config: StadiumConfig): void {
    if (!this.trajectoryVisible) {
      this.trajectoryLine.visible = false;
      return;
    }

    const pos = this.state.pos;
    const vel = this.state.vel;
    const targetZ = this.trajectoryTargetGoalZ;
    const dirToGoal = targetZ - pos.z;

    // Show only when ball is meaningfully heading toward the keeper's goal
    const movingTowardGoal = dirToGoal * vel.z > 0 && Math.abs(vel.z) > 3.2;
    if (!movingTowardGoal) {
      this.trajectoryLine.visible = false;
      this.trajTargetRing.visible = false;
      return;
    }

    let sx = pos.x;
    let sy = pos.y;
    let sz = pos.z;
    let vx = vel.x;
    let vy = vel.y;
    let vz = vel.z;
    let spx = this.state.spin.x;
    let spy = this.state.spin.y;
    let spz = this.state.spin.z;

    const simDt = 0.05;
    let count = 0;
    let crossed = false;
    let crossX = sx;
    let crossY = sy;

    for (let i = 0; i < TRAJ_MAX_POINTS; i++) {
      this.trajPositions[i * 3] = sx;
      this.trajPositions[i * 3 + 1] = Math.max(0.12, sy);
      this.trajPositions[i * 3 + 2] = sz;
      count++;

      const prevX = sx;
      const prevY = sy;
      const prevZ = sz;

      // Forward Euler preview matching main physics
      vy -= GRAVITY * simDt;
      vx += (spy * vz - spz * vy) * MAGNUS_STRENGTH * simDt;
      vz += (spx * vy - spy * vx) * MAGNUS_STRENGTH * simDt;
      const airF = Math.exp(-AIR_DRAG * simDt);
      vx *= airF;
      vz *= airF;
      const spinF = Math.exp(-SPIN_DECAY * simDt);
      spx *= spinF;
      spy *= spinF;
      spz *= spinF;

      sx += vx * simDt;
      sy += vy * simDt;
      sz += vz * simDt;

      if (sy < BALL_RADIUS) {
        sy = BALL_RADIUS;
        if (vy < -1.5) vy = -vy * GROUND_RESTITUTION;
        else vy = 0;
      }

      // Check crossing targetGoalZ plane
      if ((prevZ - targetZ) * (sz - targetZ) <= 0 && Math.abs(sz - prevZ) > 1e-4) {
        const frac = (targetZ - prevZ) / (sz - prevZ);
        crossX = prevX + (sx - prevX) * frac;
        crossY = Math.max(BALL_RADIUS, prevY + (sy - prevY) * frac);
        if (count < TRAJ_MAX_POINTS) {
          this.trajPositions[count * 3] = crossX;
          this.trajPositions[count * 3 + 1] = crossY;
          this.trajPositions[count * 3 + 2] = targetZ;
          count++;
        }
        crossed = true;
        break;
      }
    }

    if (count < 2) {
      this.trajectoryLine.visible = false;
      this.trajTargetRing.visible = false;
      return;
    }

    this.trajectoryLine.visible = true;
    this.trajGeo.setDrawRange(0, count);
    (this.trajGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.trajLineMesh.computeLineDistances();

    // Show pulsing crosshair ring if incoming shot heads near the goal mouth
    const nearGoalMouth =
      crossed &&
      Math.abs(crossX) < config.goalWidth * 0.72 &&
      crossY < config.goalHeight + 1.4;
    this.trajTargetRing.visible = nearGoalMouth;
    if (nearGoalMouth) {
      const zOffset = targetZ > 0 ? -0.15 : 0.15;
      this.trajTargetRing.position.set(crossX, crossY, targetZ + zOffset);
      const pulse = 1 + Math.sin(this.visualElapsed * 14) * 0.16;
      this.trajTargetRing.scale.set(pulse, pulse, 1);
      const onTarget =
        Math.abs(crossX) < config.goalWidth * 0.5 && crossY < config.goalHeight;
      this.trajTargetMat.color.setHex(onTarget ? 0xff2e4c : 0xffe600);
    }
  }

  public getVisualTransform(): { pos: Vec3; quat: [number, number, number, number] } {
    const q = this.ballSphere.quaternion;
    return {
      pos: { x: this.mesh.position.x, y: this.mesh.position.y, z: this.mesh.position.z },
      quat: [q.x, q.y, q.z, q.w],
    };
  }

  public applyVisualTransform(pos: Vec3, quat: [number, number, number, number]): void {
    this.state.pos.x = pos.x;
    this.state.pos.y = pos.y;
    this.state.pos.z = pos.z;
    this.ballSphere.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    this.syncVisualMesh();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
