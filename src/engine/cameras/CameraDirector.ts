import * as THREE from 'three';
import type {
  CameraMode,
  MatchPhase,
  PlayerEntityState,
  TeamId,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export type GKDiveVisualState = 'none' | 'left' | 'right' | 'catch';

export interface CameraDirectorContext {
  phase: MatchPhase;
  cameraMode: CameraMode;
  config: StadiumConfig;
  ballPos: Vec3;
  ballVel: Vec3;
  controlledPlayer: PlayerEntityState | null;
  humanTeam: TeamId;
  mouseLook: { yaw: number; pitch: number };
  freeYaw: number;
  freePitch: number;
  isSprinting?: boolean;
  gkDiveState: GKDiveVisualState;
  benchSeatPos: Vec3;
  varFocusPos: Vec3;
}

export interface CameraDirectorOutput {
  gkDiveState: GKDiveVisualState;
  isFirstPersonGK: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dampFactor(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * Math.max(0.001, dt));
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Spring-damped multi-role camera director for ElMal3abLife.
 * Smoothly drives THREE.PerspectiveCamera across aerial menu orbit, PES broadcast,
 * third-person player/referee, first-person goalkeeper, touchline coach, dugout bench,
 * stands crowd view, and dramatic VAR slow-motion zoom.
 */
export class CameraDirector {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly currentPos = new THREE.Vector3(18, 14.5, 15);
  private readonly currentLook = new THREE.Vector3(0, 2.0, 0);
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndcVec = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly rayHit = new THREE.Vector3();

  private currentFov = 52;
  private desiredFov = 52;
  private gkRoll = 0;
  private initialized = false;
  private lastMode: CameraMode | 'menu_orbit' = 'menu_orbit';

  // Micro screen shake
  private shakeIntensity = 0;
  private shakeTimer = 0;
  private shakeDuration = 0.01;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.currentFov = camera.fov || 52;
    this.desiredFov = this.currentFov;
  }

  triggerShake(intensity: number, duration = 0.35): void {
    if (intensity >= this.shakeIntensity || this.shakeTimer <= 0) {
      this.shakeIntensity = intensity;
      this.shakeDuration = Math.max(0.05, duration);
      this.shakeTimer = this.shakeDuration;
    }
  }

  snapNextFrame(): void {
    this.initialized = false;
  }

  update(dt: number, elapsed: number, ctx: CameraDirectorContext): CameraDirectorOutput {
    const isMenuOrbit = ctx.phase === 'menu' || ctx.phase === 'lobby';
    const effectiveMode: CameraMode | 'menu_orbit' = isMenuOrbit
      ? 'menu_orbit'
      : ctx.phase === 'var_review'
        ? 'var_replay_cam'
        : ctx.cameraMode;

    const isFP = effectiveMode === 'gk_first_person';
    let posLambda = 6.5;
    let lookLambda = 8.5;
    let targetRoll = 0;

    switch (effectiveMode) {
      case 'menu_orbit': {
        // Elliptical orbit strictly inside the open stadium bowl (±25.8 X / ±35.8 Z, roof Y = 18.2)
        // showcasing the glowing night turf, sponsor boards, crowd stands, and floodlight cones!
        const angle = 0.55 + elapsed * 0.14;
        const height = 14.5 + Math.sin(elapsed * 0.35) * 1.4;
        this.desiredPos.set(
          Math.cos(angle) * 21.0,
          height,
          Math.sin(angle) * 28.0
        );
        this.desiredLook.set(0, 2.0, 0);
        this.desiredFov = 54;
        posLambda = 3.5;
        lookLambda = 4.5;
        break;
      }

      case 'broadcast_top': {
        // PES-style elevated sideline view from -X looking across pitch toward +X benches.
        // Kept strictly inward of the West stand roof overhang (x ≈ -25.8, y = 18.2) for an unobstructed pitch view.
        // From -X looking +X: +Z (Red attacks) is screen-right, -Z (Blue attacks) is screen-left.
        const focusX = ctx.ballPos.x * 0.35;
        const focusZ = clamp(ctx.ballPos.z * 0.82, -ctx.config.halfLength * 0.78, ctx.config.halfLength * 0.78);
        const goalBoost = ctx.phase === 'goal_celebration' ? 4.2 : 0;
        const camX = clamp(-24.0 + focusX * 0.28 + goalBoost * 0.55, -24.4, -16.5);
        this.desiredPos.set(
          camX,
          21.6 - goalBoost * 0.45,
          focusZ * 0.72
        );
        this.desiredLook.set(
          focusX * 0.5 - 1.5,
          0.85,
          focusZ
        );
        this.desiredFov = ctx.phase === 'goal_celebration' ? 45 : 55;
        posLambda = 5.2;
        lookLambda = 7.0;
        break;
      }

      case 'player_third': {
        const player = ctx.controlledPlayer;
        if (player) {
          // Rematch-style fast free-mouse 360 camera driven directly by freeYaw & freePitch
          const aimYaw = ctx.freeYaw;
          const aimPitch = clamp(ctx.freePitch, -0.22, 0.52);

          const dist = 9.0;
          const height = 4.95 + aimPitch * 3.8;
          // Over-the-shoulder offset reveals the player's feet, ball, and 3D aiming arrow cleanly
          const shoulderRightX = Math.cos(aimYaw);
          const shoulderRightZ = -Math.sin(aimYaw);
          const shoulderOffset = 1.25;

          const rawCamX = player.pos.x - Math.sin(aimYaw) * dist + shoulderRightX * shoulderOffset;
          const rawCamY = Math.max(1.8, player.pos.y + height);
          const rawCamZ = player.pos.z - Math.cos(aimYaw) * dist + shoulderRightZ * shoulderOffset;

          // Keep camera strictly inside open stadium bowl so it never clips stands/roof
          this.desiredPos.set(
            clamp(rawCamX, -24.6, 24.6),
            rawCamY,
            clamp(rawCamZ, -34.6, 34.6)
          );

          const lookAhead = 14.0;
          const lookY = clamp(player.pos.y + 1.15 - aimPitch * 3.4, 0.25, 5.2);
          this.desiredLook.set(
            player.pos.x + Math.sin(aimYaw) * lookAhead + shoulderRightX * 0.45,
            lookY,
            player.pos.z + Math.cos(aimYaw) * lookAhead + shoulderRightZ * 0.45
          );
        } else {
          this.desiredPos.set(ctx.ballPos.x, 12, ctx.ballPos.z - 16);
          this.desiredLook.set(ctx.ballPos.x, 1, ctx.ballPos.z);
        }
        this.desiredFov = ctx.isSprinting ? 64 : 60;
        posLambda = 18.0;
        lookLambda = 24.0;
        break;
      }

      case 'gk_first_person': {
        const gk = ctx.controlledPlayer;
        const gkTeam: TeamId =
          gk && (gk.team === 'red' || gk.team === 'blue') ? gk.team : ctx.humanTeam;
        // Red GK defends Z = -34 facing +Z (yaw 0); Blue GK defends Z = +34 facing -Z (yaw PI)
        const baseYaw = gkTeam === 'red' ? 0 : Math.PI;
        const forwardZ = gkTeam === 'red' ? 1 : -1;

        const baseX = gk ? gk.pos.x : 0;
        const baseY = gk ? gk.pos.y : 0;
        const baseZ = gk ? gk.pos.z : gkTeam === 'red' ? -ctx.config.halfLength + 1.0 : ctx.config.halfLength - 1.0;

        // Subtle ball tracking assist blended with clamped mouse look
        const toBallX = ctx.ballPos.x - baseX;
        const toBallZ = ctx.ballPos.z - baseZ;
        const ballAngle = Math.atan2(toBallX, toBallZ);
        let relBallYaw = ((ballAngle - baseYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (relBallYaw < -Math.PI) relBallYaw += Math.PI * 2;
        const assistYaw = clamp(relBallYaw * 0.32, -0.42, 0.42);

        const mouseYaw = clamp(ctx.mouseLook.yaw, -0.78, 0.78);
        const totalYaw = baseYaw + clamp(mouseYaw * 0.85 + assistYaw * 0.55, -0.95, 0.95);
        const totalPitch = clamp(ctx.mouseLook.pitch * 0.55 - 0.04, -0.34, 0.42);

        const diveDrop = ctx.gkDiveState === 'left' || ctx.gkDiveState === 'right' ? 0.38 : 0;
        if (ctx.gkDiveState === 'left') targetRoll = 0.24;
        else if (ctx.gkDiveState === 'right') targetRoll = -0.24;

        this.desiredPos.set(
          baseX,
          baseY + 1.62 - diveDrop,
          baseZ + forwardZ * 0.16
        );

        const lookDist = 14;
        const cosPitch = Math.cos(totalPitch);
        this.desiredLook.set(
          this.desiredPos.x + Math.sin(totalYaw) * cosPitch * lookDist,
          this.desiredPos.y + Math.sin(totalPitch) * lookDist,
          this.desiredPos.z + Math.cos(totalYaw) * cosPitch * lookDist
        );

        this.desiredFov = 68;
        posLambda = 22.0;
        lookLambda = 20.0;
        break;
      }

      case 'referee_cam': {
        const ref = ctx.controlledPlayer;
        if (ref) {
          const camYaw = ctx.freeYaw;
          const aimPitch = clamp(ctx.freePitch, -0.2, 0.48);
          this.desiredPos.set(
            clamp(ref.pos.x - Math.sin(camYaw) * 7.8, -24.6, 24.6),
            Math.max(1.8, ref.pos.y + 3.8 + aimPitch * 3.6),
            clamp(ref.pos.z - Math.cos(camYaw) * 7.8, -34.6, 34.6)
          );
          this.desiredLook.set(
            ref.pos.x + Math.sin(camYaw) * 12.0,
            clamp(ref.pos.y + 1.5 - aimPitch * 3.0, 0.4, 5.0),
            ref.pos.z + Math.cos(camYaw) * 12.0
          );
        } else {
          this.desiredPos.set(ctx.ballPos.x - 10, 6, ctx.ballPos.z - 8);
          this.desiredLook.set(ctx.ballPos.x, 1.2, ctx.ballPos.z);
        }
        this.desiredFov = 58;
        posLambda = 15.0;
        lookLambda = 20.0;
        break;
      }

      case 'coach_touchline': {
        // Positioned in front of the dugout overhang and coach sprite along the touchline for a clean pitch sightline
        const zone = ctx.config.coachZones[ctx.humanTeam];
        const swayZ = Math.sin(elapsed * 0.7) * 0.25;
        const zOffset = ctx.humanTeam === 'red' ? -1.4 : 1.4;
        this.desiredPos.set(zone.x - 1.4, 3.7, zone.z + zOffset + swayZ);
        this.desiredLook.set(
          clamp(ctx.ballPos.x * 0.55, -18, 12),
          1.1,
          clamp(ctx.ballPos.z * 0.78, -28, 28)
        );
        this.desiredFov = 54;
        posLambda = 5.5;
        lookLambda = 7.5;
        break;
      }

      case 'bench_cam': {
        // Seated eye-level inside the 3D dugout bench looking out (-X) onto the pitch!
        const seat = ctx.benchSeatPos;
        const lookYawOffset = clamp(ctx.mouseLook.yaw, -0.55, 0.55);
        const lookPitchOffset = clamp(ctx.mouseLook.pitch, -0.25, 0.25);

        this.desiredPos.set(seat.x - 0.18, seat.y + 1.48, seat.z);

        const targetX = clamp(ctx.ballPos.x * 0.55, -18, 12);
        const targetZ = clamp(ctx.ballPos.z * 0.7 + lookYawOffset * 14, -30, 30);
        const targetY = clamp(1.35 + lookPitchOffset * 4, 0.5, 4.5);

        this.desiredLook.set(targetX, targetY, targetZ);
        this.desiredFov = 58;
        posLambda = 8.0;
        lookLambda = 9.0;
        break;
      }

      case 'stands_cam': {
        const sPos = ctx.config.standsCameraPos;
        const gentleBob = Math.sin(elapsed * 1.4) * 0.14;
        this.desiredPos.set(sPos.x, sPos.y + gentleBob, sPos.z);
        this.desiredLook.set(
          ctx.ballPos.x * 0.52,
          1.0,
          ctx.ballPos.z * 0.72
        );
        this.desiredFov = 46;
        posLambda = 5.0;
        lookLambda = 6.5;
        break;
      }

      case 'var_replay_cam': {
        // Tight dramatic broadcast zoom orbiting the incident / ball
        const orbit = elapsed * 0.42;
        const focus = ctx.varFocusPos;
        const zoomRadius = 11.2;
        this.desiredPos.set(
          focus.x - Math.cos(orbit) * zoomRadius,
          5.6 + Math.sin(elapsed * 0.8) * 0.5,
          focus.z + Math.sin(orbit) * zoomRadius
        );
        this.desiredLook.set(focus.x, Math.max(0.9, focus.y + 0.4), focus.z);
        this.desiredFov = 38;
        posLambda = 6.0;
        lookLambda = 10.0;
        break;
      }
    }

    // Immediate snap when entering GK FP or first frame to prevent dizzying transitions
    const shouldSnap =
      !this.initialized ||
      (isFP && this.lastMode !== 'gk_first_person') ||
      (effectiveMode === 'bench_cam' && this.lastMode !== 'bench_cam');

    if (shouldSnap) {
      this.currentPos.copy(this.desiredPos);
      this.currentLook.copy(this.desiredLook);
      this.currentFov = this.desiredFov;
      this.initialized = true;
    } else {
      const pAlpha = dampFactor(posLambda, dt);
      const lAlpha = dampFactor(lookLambda, dt);
      this.currentPos.lerp(this.desiredPos, pAlpha);
      this.currentLook.lerp(this.desiredLook, lAlpha);
      this.currentFov += (this.desiredFov - this.currentFov) * dampFactor(6, dt);
    }

    this.lastMode = effectiveMode;

    // Apply micro camera shake
    let shakeX = 0;
    let shakeY = 0;
    let shakeZ = 0;
    if (this.shakeTimer > 0) {
      this.shakeTimer = Math.max(0, this.shakeTimer - dt);
      const falloff = this.shakeTimer / this.shakeDuration;
      const mag = this.shakeIntensity * falloff;
      shakeX = (Math.random() - 0.5) * 2 * mag;
      shakeY = (Math.random() - 0.5) * 2 * mag;
      shakeZ = (Math.random() - 0.5) * 2 * mag;
    }

    this.camera.position.set(
      this.currentPos.x + shakeX,
      this.currentPos.y + shakeY,
      this.currentPos.z + shakeZ
    );

    // Smoothly tilt up vector for visceral FP GK dives
    this.gkRoll += (targetRoll - this.gkRoll) * dampFactor(12, dt);
    if (Math.abs(this.gkRoll) > 0.001) {
      this.camera.up.set(Math.sin(this.gkRoll), Math.cos(this.gkRoll), 0).normalize();
    } else {
      this.camera.up.set(0, 1, 0);
    }

    this.camera.lookAt(this.currentLook);

    if (Math.abs(this.camera.fov - this.currentFov) > 0.05) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    return {
      gkDiveState: isFP ? ctx.gkDiveState : 'none',
      isFirstPersonGK: isFP,
    };
  }

  /**
   * Returns camera-relative horizontal basis vectors on the XZ plane
   * so WASD movement always feels natural in every camera angle.
   */
  getHorizontalAxes(): { forward: Vec3; right: Vec3 } {
    this.camera.getWorldDirection(this.tmpForward);
    this.tmpForward.y = 0;
    if (this.tmpForward.lengthSq() < 0.0001) {
      this.tmpForward.set(1, 0, 0);
    } else {
      this.tmpForward.normalize();
    }

    // right = forward x worldUp
    this.tmpRight.set(-this.tmpForward.z, 0, this.tmpForward.x).normalize();

    return {
      forward: { x: this.tmpForward.x, y: 0, z: this.tmpForward.z },
      right: { x: this.tmpRight.x, y: 0, z: this.tmpRight.z },
    };
  }

  /**
   * Raycasts screen NDC coordinates onto the pitch surface (Y = 0)
   * so broadcast_top aiming follows the player's mouse cursor smoothly.
   */
  raycastGround(ndcX: number, ndcY: number): Vec3 | null {
    this.ndcVec.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndcVec, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.rayHit);
    if (!hit) return null;
    return { x: hit.x, y: 0, z: hit.z };
  }
}
