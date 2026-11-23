import * as THREE from 'three';
import type { CharacterAnimState, PlayerEntityState, Vec3 } from '../../types/game';

export interface ReplayPlayerFrame {
  id: string;
  pos: Vec3;
  rotY: number;
  animState: CharacterAnimState;
}

export interface ReplayBallFrame {
  pos: Vec3;
  quat: [number, number, number, number];
  isSuperShot: boolean;
}

export interface ReplayFrame {
  time: number;
  ball: ReplayBallFrame;
  players: ReplayPlayerFrame[];
}

const SAMPLE_HZ = 30;
const SAMPLE_INTERVAL = 1 / SAMPLE_HZ;
const BUFFER_DURATION_SEC = 4;
const MAX_FRAMES = SAMPLE_HZ * BUFFER_DURATION_SEC; // 120 frames

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * 4-second 30Hz ring-buffer recorder for VAR slow-motion playback.
 * Supports freezing capture during `var_review` and smoothly interpolating
 * ball position/rotation + player transforms at arbitrary slow-motion speeds.
 */
export class ReplayRecorder {
  private readonly buffer: Array<ReplayFrame | undefined> = new Array(MAX_FRAMES);
  private writeIndex = 0;
  private count = 0;
  private sampleAccum = 0;
  private recordedTime = 0;
  private frozen = false;

  private readonly tmpQ0 = new THREE.Quaternion();
  private readonly tmpQ1 = new THREE.Quaternion();
  private readonly tmpQOut = new THREE.Quaternion();

  record(
    dt: number,
    ball: ReplayBallFrame,
    players: ReadonlyArray<PlayerEntityState>
  ): void {
    if (this.frozen) return;

    this.recordedTime += dt;
    this.sampleAccum += dt;

    if (this.count > 0 && this.sampleAccum < SAMPLE_INTERVAL) {
      return;
    }

    while (this.sampleAccum >= SAMPLE_INTERVAL) {
      this.sampleAccum -= SAMPLE_INTERVAL;
    }

    const frame: ReplayFrame = {
      time: this.recordedTime,
      ball: {
        pos: { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z },
        quat: [ball.quat[0], ball.quat[1], ball.quat[2], ball.quat[3]],
        isSuperShot: ball.isSuperShot,
      },
      players: players.map((p) => ({
        id: p.id,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        rotY: p.rotY,
        animState: p.animState,
      })),
    };

    this.buffer[this.writeIndex] = frame;
    this.writeIndex = (this.writeIndex + 1) % MAX_FRAMES;
    if (this.count < MAX_FRAMES) {
      this.count += 1;
    }
  }

  freeze(): void {
    this.frozen = true;
  }

  unfreeze(): void {
    this.frozen = false;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.writeIndex = 0;
    this.count = 0;
    this.sampleAccum = 0;
    this.recordedTime = 0;
    this.frozen = false;
  }

  getFrameCount(): number {
    return this.count;
  }

  getDuration(): number {
    if (this.count <= 1) return 0;
    const oldest = this.getFrameAtOrderedIndex(0);
    const newest = this.getFrameAtOrderedIndex(this.count - 1);
    if (!oldest || !newest) return 0;
    return Math.max(0.05, Math.min(BUFFER_DURATION_SEC, newest.time - oldest.time));
  }

  /**
   * Returns normalized [0..1] progress through the slow-motion replay loop.
   */
  getLoopProgress(elapsedPlaybackSec: number, playbackSpeed = 0.35): number {
    const duration = this.getDuration();
    if (duration <= 0) return 0;
    const replayTime = (elapsedPlaybackSec * playbackSpeed) % duration;
    return Math.max(0, Math.min(1, replayTime / duration));
  }

  /**
   * Samples an interpolated frame looping over the captured buffer at `playbackSpeed` (default 0.35x).
   */
  sampleAt(elapsedPlaybackSec: number, playbackSpeed = 0.35): ReplayFrame | null {
    if (this.count === 0) return null;
    if (this.count === 1) {
      return this.getFrameAtOrderedIndex(0) ?? null;
    }

    const duration = this.getDuration();
    const loopTime = duration > 0 ? (elapsedPlaybackSec * playbackSpeed) % duration : 0;
    const normalized = duration > 0 ? loopTime / duration : 0;
    const exactIndex = normalized * (this.count - 1);
    const idx0 = Math.min(this.count - 1, Math.floor(exactIndex));
    const idx1 = Math.min(this.count - 1, idx0 + 1);
    const alpha = exactIndex - idx0;

    const f0 = this.getFrameAtOrderedIndex(idx0);
    const f1 = this.getFrameAtOrderedIndex(idx1);
    if (!f0) return null;
    if (!f1 || idx0 === idx1) return f0;

    // Interpolate ball position + slerp quaternion
    this.tmpQ0.set(f0.ball.quat[0], f0.ball.quat[1], f0.ball.quat[2], f0.ball.quat[3]);
    this.tmpQ1.set(f1.ball.quat[0], f1.ball.quat[1], f1.ball.quat[2], f1.ball.quat[3]);
    this.tmpQOut.slerpQuaternions(this.tmpQ0, this.tmpQ1, alpha);

    // Map f1 players by id for clean interpolation even if roster changed
    const nextById = new Map<string, ReplayPlayerFrame>();
    for (const p of f1.players) {
      nextById.set(p.id, p);
    }

    const players: ReplayPlayerFrame[] = f0.players.map((p0) => {
      const p1 = nextById.get(p0.id);
      if (!p1) {
        return {
          id: p0.id,
          pos: { ...p0.pos },
          rotY: p0.rotY,
          animState: p0.animState,
        };
      }
      return {
        id: p0.id,
        pos: {
          x: lerp(p0.pos.x, p1.pos.x, alpha),
          y: lerp(p0.pos.y, p1.pos.y, alpha),
          z: lerp(p0.pos.z, p1.pos.z, alpha),
        },
        rotY: lerpAngle(p0.rotY, p1.rotY, alpha),
        animState: alpha < 0.5 ? p0.animState : p1.animState,
      };
    });

    return {
      time: lerp(f0.time, f1.time, alpha),
      ball: {
        pos: {
          x: lerp(f0.ball.pos.x, f1.ball.pos.x, alpha),
          y: lerp(f0.ball.pos.y, f1.ball.pos.y, alpha),
          z: lerp(f0.ball.pos.z, f1.ball.pos.z, alpha),
        },
        quat: [this.tmpQOut.x, this.tmpQOut.y, this.tmpQOut.z, this.tmpQOut.w],
        isSuperShot: alpha < 0.5 ? f0.ball.isSuperShot : f1.ball.isSuperShot,
      },
      players,
    };
  }

  private getFrameAtOrderedIndex(orderedIndex: number): ReplayFrame | undefined {
    if (orderedIndex < 0 || orderedIndex >= this.count) return undefined;
    const oldestIndex = this.count < MAX_FRAMES ? 0 : this.writeIndex;
    const physicalIndex = (oldestIndex + orderedIndex) % MAX_FRAMES;
    return this.buffer[physicalIndex];
  }
}
