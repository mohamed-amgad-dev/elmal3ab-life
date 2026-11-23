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
  private readonly currentPos = new THREE.Vector3(-42, 26, -24);
  private readonly currentLook = new THREE.Vector3(0, 1, 0);
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();

  private currentFov = 52;
  private desiredFov = 52;
  private thirdPersonYaw = 0;
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
        const angle = elapsed * 0.14;
        const radius = 54;
        const height = 23 + Math.sin(elapsed * 0.35) * 2.5;
        this.desiredPos.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
        this.desiredLook.set(0, 1.8, 0);
        this.desiredFov = 50;
        posLambda = 3.5;
        lookLambda = 4.5;
        break;
      }

      case 'broadcast_top': {
        // PES-style elevated sideline view from -X looking across pitch toward +X benches
        // From -X looking +X: +Z (Red attacks) is screen-right, -Z (Blue attacks) is screen-left!
        const focusX = ctx.ballPos.x * 0.42;
        const focusZ = clamp(ctx.ballPos.z * 0.82, -ctx.config.halfLength * 0.78, ctx.config.halfLength * 0.78);
        const goalBoost = ctx.phase === 'goal_celebration' ? 5.5 : 0;
        this.desiredPos.set(
          -34 + focusX * 0.35 + goalBoost * 0.65,
          26 - goalBoost * 0.5,
          focusZ * 0.74
        );
        this.desiredLook.set(
          focusX * 0.55,
          0.9,
          focusZ
        );
        this.desiredFov = ctx.phase === 'goal_celebration' ? 42 : 48;
        posLambda = 5.2;
        lookLambda = 7.0;
        break;
      }

      case 'player_third': {
        const player = ctx.controlledPlayer;
        if (player) {
          const attackYaw = player.team === 'red' ? 0 : Math.PI;
          const dxBall = ctx.ballPos.x - player.pos.x;
          const dzBall = ctx.ballPos.z - player.pos.z;
          const distBall = Math.hypot(dxBall, dzBall);
          const ballYaw = distBall > 1.2 ? Math.atan2(dxBall, dzBall) : player.rotY;

          // Blend player facing with ball/goal direction so spin moves don't whip the camera
          const targetYaw =
            player.animState === 'skill_spin' || player.animState === 'dive_flop'
              ? attackYaw
              : lerpAngle(player.rotY, distBall < 14 ? ballYaw : attackYaw, 0.38);

          if (!this.initialized || this.lastMode !== 'player_third') {
            this.thirdPersonYaw = targetYaw;
          } else {
            this.thirdPersonYaw = lerpAngle(this.thirdPersonYaw, targetYaw, dampFactor(4.5, dt));
          }

          const dist = 10.2;
          const height = 5.1;
          this.desiredPos.set(
            player.pos.x - Math.sin(this.thirdPersonYaw) * dist,
            player.pos.y + height,
            player.pos.z - Math.cos(this.thirdPersonYaw) * dist
          );
          this.desiredLook.set(
            player.pos.x + Math.sin(this.thirdPersonYaw) * 5.2 + (ctx.ballPos.x - player.pos.x) * 0.22,
            player.pos.y + 1.45,
            player.pos.z + Math.cos(this.thirdPersonYaw) * 5.2 + (ctx.ballPos.z - player.pos.z) * 0.22
          );
        } else {
          this.desiredPos.set(ctx.ballPos.x, 12, ctx.ballPos.z - 16);
          this.desiredLook.set(ctx.ballPos.x, 1, ctx.ballPos.z);
        }
        this.desiredFov = 58;
        posLambda = 7.5;
        lookLambda = 9.5;
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
          const dx = ctx.ballPos.x - ref.pos.x;
          const dz = ctx.ballPos.z - ref.pos.z;
          const toBallYaw = Math.hypot(dx, dz) > 0.8 ? Math.atan2(dx, dz) : ref.rotY;
          const camYaw = lerpAngle(ref.rotY, toBallYaw, 0.55);
          this.desiredPos.set(
            ref.pos.x - Math.sin(camYaw) * 8.4,
            ref.pos.y + 4.3,
            ref.pos.z - Math.cos(camYaw) * 8.4
          );
          this.desiredLook.set(
            ref.pos.x + (ctx.ballPos.x - ref.pos.x) * 0.48,
            1.35,
            ref.pos.z + (ctx.ballPos.z - ref.pos.z) * 0.48
          );
        } else {
          this.desiredPos.set(ctx.ballPos.x - 10, 6, ctx.ballPos.z - 8);
          this.desiredLook.set(ctx.ballPos.x, 1.2, ctx.ballPos.z);
        }
        this.desiredFov = 56;
        posLambda = 7.0;
        lookLambda = 9.0;
        break;
      }

      case 'coach_touchline': {
        const zone = ctx.config.coachZones[ctx.humanTeam];
        const swayX = Math.sin(elapsed * 0.7) * 0.18;
        this.desiredPos.set(zone.x + 2.8 + swayX, 3.1, zone.z);
        this.desiredLook.set(
          clamp(ctx.ballPos.x * 0.55, -16, 12),
          1.15,
          clamp(ctx.ballPos.z * 0.78, -28, 28)
        );
        this.desiredFov = 52;
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
}
