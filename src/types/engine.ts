import type * as THREE from 'three';
import type {
  BallStateSnapshot,
  GameCommand,
  PlayerEntityState,
  TeamId,
  Vec3,
} from './game';
import type { StadiumConfig } from './stadium';

export interface IStadiumScene {
  group: THREE.Group;
  config: StadiumConfig;
  update(dt: number, elapsed: number): void;
  triggerGoalNetRipple(side: TeamId, impactPos: Vec3): void;
  triggerGoalCelebration(scoringTeam: TeamId): void;
  triggerCrowdFireworks(): void;
  setCrowdExcitement(level: number): void;
  setVARActive(active: boolean): void;
  getBenchSeatPosition(team: TeamId, slotIndex: number): Vec3;
  dispose(): void;
}

export interface ICharacterSystem {
  group: THREE.Group;
  syncPlayers(players: PlayerEntityState[], dt: number, elapsed: number): void;
  updateFPGloves(
    camera: THREE.Camera,
    active: boolean,
    diveState: 'none' | 'left' | 'right' | 'catch',
    dt: number
  ): void;
  triggerSpeechBubble(playerId: string, text: string, duration?: number): void;
  dispose(): void;
}

export interface BallTickResult {
  goalScored: TeamId | null;
  hitPost: boolean;
  bounced: boolean;
  speed: number;
}

export interface IBallPhysics {
  mesh: THREE.Object3D;
  trajectoryLine: THREE.Object3D;
  state: BallStateSnapshot;
  reset(pos?: Vec3): void;
  kick(
    dir: Vec3,
    power: number,
    lift?: number,
    isSuperShot?: boolean,
    byPlayerId?: string,
    byTeam?: TeamId
  ): void;
  kickWithSpin?(
    dir: Vec3,
    power: number,
    lift: number,
    curlSpinY: number,
    isSuperShot: boolean,
    byPlayerId?: string,
    byTeam?: TeamId
  ): void;
  applyDribbleVelocity?(
    targetVel: Vec3,
    byPlayerId: string,
    byTeam: TeamId
  ): void;
  syncPlayerColliders?(
    players: Array<{
      id: string;
      pos: Vec3;
      vx: number;
      vz: number;
      active: boolean;
      isKickerCooldown: boolean;
    }>
  ): void;
  isRapierReady?(): boolean;
  setPositionAndStop(pos: Vec3): void;
  setFrozen(frozen: boolean): void;
  setTrajectoryVisible(visible: boolean, targetGoalZ?: number): void;
  update(dt: number, config: StadiumConfig): BallTickResult;
  getVisualTransform(): { pos: Vec3; quat: [number, number, number, number] };
  applyVisualTransform(pos: Vec3, quat: [number, number, number, number]): void;
  dispose(): void;
}

export interface AimingGuideParams {
  visible: boolean;
  playerPos: Vec3;
  aimDir: Vec3;
  charge: number;
  curl: number;
  isCharging: boolean;
  ballPos: Vec3;
  passTargetPos: Vec3 | null;
  teamColor: number;
  elapsed: number;
}

export interface IAimingGuide {
  group: THREE.Group;
  update(params: AimingGuideParams): void;
  dispose(): void;
}

export interface IEffectsManager {
  group: THREE.Group;
  spawnBurst(pos: Vec3, color: number, count?: number, spread?: number): void;
  spawnSlideDust(pos: Vec3): void;
  spawnDiveStars(pos: Vec3): void;
  spawnFireworks(pos: Vec3, color: number): void;
  update(dt: number, ballPos: Vec3, isSuperShot: boolean): void;
  dispose(): void;
}

export interface ISoundEngine {
  unlock(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  playWhistle(type: 'short' | 'long' | 'double'): void;
  playKick(power: number): void;
  playPostClang(): void;
  playGoalCelebration(): void;
  playCrowdReaction(type: 'cheer' | 'ooh' | 'boo'): void;
  playCard(color: 'yellow' | 'red'): void;
  playVARChime(): void;
  playBenchBuzzer(): void;
  playDiveWhoosh(): void;
  playFireworks(): void;
  dispose(): void;
}

export interface IMatchEngine {
  start(): void;
  stop(): void;
  setPaused(paused: boolean): void;
  dispatchCommand(cmd: GameCommand): void;
  dispose(): void;
}
