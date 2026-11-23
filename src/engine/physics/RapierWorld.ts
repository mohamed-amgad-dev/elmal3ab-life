import RAPIER from '@dimforge/rapier3d-compat';
import type { StadiumConfig } from '../../types/stadium';
import type { Vec3 } from '../../types/game';

export const RAPIER_BALL_RADIUS = 0.42;

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 4;
const BALL_MASS = 0.45;
const POST_RADIUS = 0.15;
const MAGNUS_COEFF = 0.044;
const GRASS_ROLL_DRAG = 1.35;

// Interaction group bitmasks: (membership << 16) | filter
const GROUP_WORLD = (0x0001 << 16) | 0xffff;
const GROUP_BALL = (0x0002 << 16) | (0x0001 | 0x0004);
const GROUP_PLAYER_ACTIVE = (0x0004 << 16) | 0x0002;
const GROUP_PLAYER_IGNORE_BALL = (0x0008 << 16) | 0x0000;

let rapierInitPromise: Promise<typeof RAPIER> | null = null;

/**
 * Initializes the Rapier3D WASM module once (cached across StrictMode remounts).
 */
export function initRapier(): Promise<typeof RAPIER> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init().then(() => RAPIER);
  }
  return rapierInitPromise;
}

export interface RapierStepEvents {
  hitPost: boolean;
  bounced: boolean;
  deflectedByPlayerId: string | null;
}

export interface PlayerColliderInput {
  id: string;
  pos: Vec3;
  vx: number;
  vz: number;
  active: boolean;
  isKickerCooldown: boolean;
}

/**
 * Full 3D rigid-body physics world powered by @dimforge/rapier3d-compat (WASM).
 * Simulates CCD football movement, Magnus curve forces from 3D angular spin,
 * static pitch boundaries, goalposts/crossbars, soft goal nets, and
 * kinematic player capsule colliders for authentic ricochets.
 */
export class RapierPhysicsWorld {
  public readonly world: RAPIER.World;
  public readonly ballBody: RAPIER.RigidBody;
  public readonly ballCollider: RAPIER.Collider;

  private readonly eventQueue: RAPIER.EventQueue;
  private readonly postHandles = new Set<number>();
  private readonly wallHandles = new Set<number>();
  private readonly netHandles = new Set<number>();
  private readonly groundHandle: number;

  private readonly playerColliders = new Map<
    string,
    { body: RAPIER.RigidBody; collider: RAPIER.Collider }
  >();
  private readonly colliderToPlayerId = new Map<number, string>();

  private accumulator = 0;
  private disposed = false;

  constructor(config: StadiumConfig) {
    this.world = new RAPIER.World({ x: 0, y: -26.0, z: 0 });
    this.world.timestep = FIXED_DT;
    this.eventQueue = new RAPIER.EventQueue(true);

    // 1. Ground plane
    const groundBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
    );
    const groundCol = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(64, 0.5, 64)
        .setRestitution(0.62)
        .setFriction(0.72)
        .setCollisionGroups(GROUP_WORLD)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      groundBody
    );
    this.groundHandle = groundCol.handle;

    // 2. Sideline cushion walls
    const hw = config.halfWidth;
    const hl = config.halfLength;
    const ghW = config.goalWidth * 0.5;
    const gH = config.goalHeight;
    const gD = config.goalDepth;

    this.addWallBox(hw + 0.5, 6, 0, 0.5, 6, hl + 4, 0.72);
    this.addWallBox(-(hw + 0.5), 6, 0, 0.5, 6, hl + 4, 0.72);

    // 3. Endline cushion walls around BOTH open goal mouths
    const wingSpan = hw + 1.0 - ghW;
    const wingHx = wingSpan * 0.5;
    const wingCenterX = ghW + wingHx;
    const lintelBottom = gH + POST_RADIUS;
    const lintelTop = 12.0;
    const lintelHy = (lintelTop - lintelBottom) * 0.5;
    const lintelCenterY = lintelBottom + lintelHy;

    for (const sign of [-1, 1] as const) {
      const endZ = sign * (hl + 0.5);
      // Left & right endline wings
      this.addWallBox(-wingCenterX, 6, endZ, wingHx, 6, 0.5, 0.72);
      this.addWallBox(wingCenterX, 6, endZ, wingHx, 6, 0.5, 0.72);
      // Wall above crossbar
      this.addWallBox(0, lintelCenterY, endZ, ghW + 0.25, lintelHy, 0.5, 0.72);

      // 4. Physical Goalposts & Crossbar at exact goal line
      const goalZ = sign * hl;
      this.addPostCapsule(-ghW, gH * 0.5, goalZ, gH * 0.5, POST_RADIUS, false);
      this.addPostCapsule(ghW, gH * 0.5, goalZ, gH * 0.5, POST_RADIUS, false);
      this.addPostCapsule(0, gH, goalZ, ghW, POST_RADIUS, true);

      // 5. Soft Goal Nets (back, left side, right side, top roof)
      const backZ = sign * (hl + gD + 0.18);
      const midNetZ = sign * (hl + gD * 0.5);
      this.addNetBox(0, gH * 0.5, backZ, ghW + 0.2, gH * 0.5 + 0.2, 0.18);
      this.addNetBox(-(ghW + 0.18), gH * 0.5, midNetZ, 0.18, gH * 0.5 + 0.2, gD * 0.5 + 0.2);
      this.addNetBox(ghW + 0.18, gH * 0.5, midNetZ, 0.18, gH * 0.5 + 0.2, gD * 0.5 + 0.2);
      this.addNetBox(0, gH + 0.18, midNetZ, ghW + 0.2, 0.18, gD * 0.5 + 0.2);
    }

    // 6. Dynamic Football RigidBody with Continuous Collision Detection (CCD)
    this.ballBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, RAPIER_BALL_RADIUS, 0)
        .setCcdEnabled(true)
        .setLinearDamping(0.24)
        .setAngularDamping(0.42)
        .setCanSleep(false)
    );
    this.ballCollider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(RAPIER_BALL_RADIUS)
        .setMass(BALL_MASS)
        .setRestitution(0.66)
        .setFriction(0.62)
        .setCollisionGroups(GROUP_BALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.ballBody
    );
  }

  private addWallBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    restitution: number
  ): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setRestitution(restitution)
        .setFriction(0.25)
        .setCollisionGroups(GROUP_WORLD)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body
    );
    this.wallHandles.add(col.handle);
  }

  private addNetBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number
  ): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setRestitution(0.16)
        .setFriction(0.92)
        .setCollisionGroups(GROUP_WORLD),
      body
    );
    this.netHandles.add(col.handle);
  }

  private addPostCapsule(
    x: number,
    y: number,
    z: number,
    halfHeight: number,
    radius: number,
    horizontalZRot: boolean
  ): void {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    if (horizontalZRot) {
      desc.setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
    }
    const body = this.world.createRigidBody(desc);
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius)
        .setRestitution(0.86)
        .setFriction(0.2)
        .setCollisionGroups(GROUP_WORLD)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body
    );
    this.postHandles.add(col.handle);
  }

  syncPlayerColliders(players: PlayerColliderInput[]): void {
    if (this.disposed) return;

    for (const p of players) {
      let entry = this.playerColliders.get(p.id);
      if (!entry) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.pos.x, 0.9, p.pos.z)
        );
        const collider = this.world.createCollider(
          RAPIER.ColliderDesc.capsule(0.45, 0.44)
            .setRestitution(0.55)
            .setFriction(0.28)
            .setCollisionGroups(GROUP_PLAYER_ACTIVE)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          body
        );
        entry = { body, collider };
        this.playerColliders.set(p.id, entry);
        this.colliderToPlayerId.set(collider.handle, p.id);
      }

      if (!p.active) {
        entry.collider.setEnabled(false);
        continue;
      }

      entry.collider.setEnabled(true);
      entry.collider.setCollisionGroups(
        p.isKickerCooldown ? GROUP_PLAYER_IGNORE_BALL : GROUP_PLAYER_ACTIVE
      );
      entry.body.setNextKinematicTranslation({
        x: p.pos.x,
        y: 0.9,
        z: p.pos.z,
      });
    }
  }

  step(dt: number): RapierStepEvents {
    const out: RapierStepEvents = {
      hitPost: false,
      bounced: false,
      deflectedByPlayerId: null,
    };
    if (this.disposed) return out;

    const clampedDt = Math.min(Math.max(dt, 0), 0.06);
    this.accumulator += clampedDt;
    let substeps = 0;

    while (this.accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      this.accumulator -= FIXED_DT;
      substeps += 1;

      const pos = this.ballBody.translation();
      const vel = this.ballBody.linvel();
      const ang = this.ballBody.angvel();

      // Apply real 3D Magnus aerodynamic force: F = mass * MAGNUS_COEFF * (ang x vel)
      this.ballBody.resetForces(false);
      const mx = (ang.y * vel.z - ang.z * vel.y) * MAGNUS_COEFF * BALL_MASS;
      const my = (ang.z * vel.x - ang.x * vel.z) * MAGNUS_COEFF * 0.4 * BALL_MASS;
      const mz = (ang.x * vel.y - ang.y * vel.x) * MAGNUS_COEFF * BALL_MASS;
      if (Math.abs(mx) + Math.abs(my) + Math.abs(mz) > 1e-4) {
        this.ballBody.addForce({ x: mx, y: my, z: mz }, false);
      }

      // Grass rolling resistance when ball is on turf
      if (pos.y <= RAPIER_BALL_RADIUS + 0.05 && Math.abs(vel.y) < 1.35) {
        const drag = Math.exp(-GRASS_ROLL_DRAG * FIXED_DT);
        const nvx = vel.x * drag;
        const nvz = vel.z * drag;
        if (Math.hypot(nvx, nvz) < 0.06 && Math.hypot(vel.x, vel.z) > 0) {
          this.ballBody.setLinvel({ x: 0, y: vel.y, z: 0 }, false);
        } else {
          this.ballBody.setLinvel({ x: nvx, y: vel.y, z: nvz }, false);
        }
      }

      this.world.step(this.eventQueue);

      const ballHandle = this.ballCollider.handle;
      this.eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        const other = h1 === ballHandle ? h2 : h2 === ballHandle ? h1 : -1;
        if (other < 0) return;

        if (this.postHandles.has(other)) {
          out.hitPost = true;
        } else if (this.wallHandles.has(other)) {
          out.bounced = true;
        } else if (other === this.groundHandle) {
          const curVel = this.ballBody.linvel();
          if (Math.abs(curVel.y) > 2.2) {
            out.bounced = true;
          }
        } else {
          const pid = this.colliderToPlayerId.get(other);
          if (pid) {
            out.deflectedByPlayerId = pid;
            out.bounced = true;
          }
        }
      });
    }

    // Clamp accumulator if frame stalled
    if (this.accumulator > FIXED_DT * 2) {
      this.accumulator = 0;
    }

    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playerColliders.clear();
    this.colliderToPlayerId.clear();
    this.postHandles.clear();
    this.wallHandles.clear();
    this.netHandles.clear();
    this.eventQueue.free();
    this.world.free();
  }
}
