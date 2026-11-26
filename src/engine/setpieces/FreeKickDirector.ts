import {
  createInitialFreeKickState,
  type ComedyEventTone,
  type FreeKickState,
  type MatchPhase,
  type PlayerEntityState,
  type TeamId,
  type Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export const FREE_KICK_LEGAL_RETREAT_M = 6.8;
export const FREE_KICK_DIRECT_SHOT_RANGE_M = 22.0;
export const FREE_KICK_AI_DIRECT_RANGE_M = 19.0;
export const FREE_KICK_HUMAN_TIMEOUT_SEC = 7.5;
export const FREE_KICK_RELEASE_DURATION_SEC = 0.25;

export interface FreeKickPlayerProxy {
  id: string;
  name: string;
  team: TeamId | 'ref' | 'neutral';
  role: PlayerEntityState['role'];
  positionRole?: PlayerEntityState['positionRole'];
  isHumanControlled: boolean;
  isRemoteHuman?: boolean;
  isBenched: boolean;
  isSentOff: boolean;
  pos: Vec3;
  rotY: number;
  animState: PlayerEntityState['animState'];
}

export interface FreeKickStartOptions {
  awardedTeam: TeamId;
  spot: Vec3;
  reason?: string;
  cardShown?: 'none' | 'yellow' | 'red';
  preferredTakerId?: string | null;
}

export interface FreeKickEngineAdapter {
  getConfig(): StadiumConfig;
  getPlayers(): FreeKickPlayerProxy[];
  setPhase(phase: MatchPhase): void;
  placeDeadBall(pos: Vec3): void;
  clearPossession(): void;
  kickBall(
    takerId: string,
    dir: Vec3,
    power: number,
    lift: number,
    curlSpinY: number,
    isSuperShot: boolean
  ): void;
  playWhistle(type: 'short' | 'long' | 'double'): void;
  playWallSpray?(): void;
  setSpeech(playerId: string, text: string, durationSec?: number): void;
  pushEvent(text: string, icon: string, tone: ComedyEventTone): void;
  setJumbotronHeadline?(text: string, durationSec?: number): void;
  setPlayerVelocityZero?(playerId: string): void;
  getCallForPassTargetId?(team: TeamId): string | null;
  onSyncStore?(): void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 1e-5) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: 0, z: z / len };
}

/**
 * Clamp a free-kick spot safely inside pitch bounds and outside both penalty boxes.
 * If the foul occurred on the edge of / inside a penalty box, pushes it cleanly outside.
 */
export function clampFreeKickSpot(rawSpot: Vec3, config: StadiumConfig): Vec3 {
  let x = clamp(rawSpot.x, -config.halfWidth + 2.2, config.halfWidth - 2.2);
  let z = clamp(rawSpot.z, -config.halfLength + 3.0, config.halfLength - 3.0);

  const boxHalfW = config.penaltyBoxWidth * 0.5 + 0.55;
  const boxEdgeZ = config.halfLength - config.penaltyBoxDepth - 0.75;

  if (Math.abs(x) <= boxHalfW && Math.abs(z) > boxEdgeZ) {
    // Push cleanly outside the nearest penalty box line (front arc or side)
    const signZ = z >= 0 ? 1 : -1;
    const distToFront = Math.abs(Math.abs(z) - boxEdgeZ);
    const distToSide = Math.abs(boxHalfW - Math.abs(x));
    if (distToFront <= distToSide + 1.5) {
      z = signZ * boxEdgeZ;
    } else {
      const signX = x >= 0 ? 1 : -1;
      x = clamp(signX * (boxHalfW + 0.4), -config.halfWidth + 2.2, config.halfWidth - 2.2);
    }
  }

  return { x, y: 0.24, z };
}

/**
 * Standalone Free Kick Director state machine:
 * 1. Whistle freeze + dead ball clamped safely outside penalty boxes
 * 2. Legal opponent retreat (>= 6.8m) + 1–2 player defensive wall when within 22m
 * 3. Human or smart AI execution (direct curved shot vs crisp pass) + 0.25s release -> 'playing'
 */
export class FreeKickDirector {
  private readonly adapter: FreeKickEngineAdapter;
  private state: FreeKickState = createInitialFreeKickState();
  private wallTargets = new Map<string, { pos: Vec3; rotY: number }>();
  private releaseTimer = 0;
  private aiDecisionDelay = 1.8;

  constructor(adapter: FreeKickEngineAdapter) {
    this.adapter = adapter;
  }

  reset(): void {
    this.state = createInitialFreeKickState();
    this.wallTargets.clear();
    this.releaseTimer = 0;
    this.aiDecisionDelay = 1.8;
  }

  isActive(): boolean {
    return this.state.active;
  }

  isReleasing(): boolean {
    return this.state.active && this.releaseTimer > 0;
  }

  isTaker(playerId: string): boolean {
    return this.state.active && this.releaseTimer <= 0 && this.state.takerId === playerId;
  }

  getState(): FreeKickState {
    return {
      ...this.state,
      spot: { ...this.state.spot },
      wallPlayerIds: [...this.state.wallPlayerIds],
    };
  }

  start(opts: FreeKickStartOptions): FreeKickState {
    const config = this.adapter.getConfig();
    const players = this.adapter.getPlayers();
    const awardedTeam = opts.awardedTeam;
    const defendingTeam: TeamId = awardedTeam === 'red' ? 'blue' : 'red';
    const attackDir = awardedTeam === 'red' ? 1 : -1;
    const oppGoalZ = attackDir * config.halfLength;

    const spot = clampFreeKickSpot(opts.spot, config);
    const toGoal = normalizeXZ(0 - spot.x, oppGoalZ - spot.z);
    const rightVec = { x: -toGoal.z, y: 0, z: toGoal.x };
    const distanceToGoalM = Math.hypot(0 - spot.x, oppGoalZ - spot.z);
    const isDirectRange = distanceToGoalM <= FREE_KICK_DIRECT_SHOT_RANGE_M;

    const taker = this.pickTaker(players, awardedTeam, spot, opts.preferredTakerId);
    const isHumanTaker = Boolean(taker && (taker.isHumanControlled || taker.isRemoteHuman));

    this.wallTargets.clear();
    this.releaseTimer = 0;
    this.aiDecisionDelay = 1.6 + Math.random() * 0.5;

    // 1. Immediately freeze play & place dead ball
    this.adapter.clearPossession();
    this.adapter.placeDeadBall(spot);
    this.adapter.setPhase('free_kick_setup');
    this.adapter.playWhistle('long');

    // 2. Position taker 1.15m behind the ball facing goal
    if (taker) {
      taker.pos.x = clamp(spot.x - toGoal.x * 1.15, -config.halfWidth + 1.0, config.halfWidth - 1.0);
      taker.pos.y = 0;
      taker.pos.z = clamp(spot.z - toGoal.z * 1.15, -config.halfLength + 1.0, config.halfLength - 1.0);
      taker.rotY = Math.atan2(toGoal.x, toGoal.z);
      taker.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(taker.id);
    }

    // 3. Build 1–2 player defensive wall along ball-to-goal line at 6.8m if in direct range
    const wallPlayerIds: string[] = [];
    const activeDefenders = players.filter(
      (p) =>
        p.team === defendingTeam &&
        p.role === 'outfield' &&
        !p.isBenched &&
        !p.isSentOff
    );

    if (isDirectRange && activeDefenders.length > 0) {
      const wallCenter: Vec3 = {
        x: clamp(spot.x + toGoal.x * FREE_KICK_LEGAL_RETREAT_M, -config.halfWidth + 2.0, config.halfWidth - 2.0),
        y: 0,
        z: clamp(
          spot.z + toGoal.z * FREE_KICK_LEGAL_RETREAT_M,
          -config.halfLength + 2.4,
          config.halfLength - 2.4
        ),
      };

      const sortedDef = [...activeDefenders].sort(
        (a, b) => distXZ(a.pos, wallCenter) - distXZ(b.pos, wallCenter)
      );
      const wallCount = Math.min(2, sortedDef.length);
      const wallSpacing = 0.54;

      for (let i = 0; i < wallCount; i += 1) {
        const dp = sortedDef[i];
        const lateralOffset = wallCount === 1 ? 0 : (i === 0 ? -wallSpacing : wallSpacing);
        const wx = clamp(
          wallCenter.x + rightVec.x * lateralOffset,
          -config.halfWidth + 1.4,
          config.halfWidth - 1.4
        );
        const wz = clamp(
          wallCenter.z + rightVec.z * lateralOffset,
          -config.halfLength + 2.0,
          config.halfLength - 2.0
        );
        const facingBall = Math.atan2(spot.x - wx, spot.z - wz);
        dp.pos.x = wx;
        dp.pos.y = 0;
        dp.pos.z = wz;
        dp.rotY = facingBall;
        dp.animState = 'idle';
        this.adapter.setPlayerVelocityZero?.(dp.id);
        wallPlayerIds.push(dp.id);
        this.wallTargets.set(dp.id, { pos: { x: wx, y: 0, z: wz }, rotY: facingBall });
      }

      if (wallPlayerIds.length > 0) {
        this.adapter.playWallSpray?.();
      }
    }

    // 4. Push all remaining opponents outside the legal 6.8m retreat radius
    for (const dp of activeDefenders) {
      if (wallPlayerIds.includes(dp.id)) continue;
      this.enforceOpponentRetreat(dp, spot, config, FREE_KICK_LEGAL_RETREAT_M + 0.6);
      dp.rotY = Math.atan2(spot.x - dp.pos.x, spot.z - dp.pos.z);
      dp.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(dp.id);
    }

    // 5. Position defending goalkeeper smartly opposite the wall side
    const defGk = players.find(
      (p) => p.team === defendingTeam && p.role === 'goalkeeper' && !p.isBenched && !p.isSentOff
    );
    if (defGk) {
      const sideBias = spot.x >= 0 ? -1 : 1;
      defGk.pos.x = clamp(sideBias * 1.15, -config.goalWidth * 0.28, config.goalWidth * 0.28);
      defGk.pos.y = 0;
      defGk.pos.z = attackDir * (config.halfLength - 1.1);
      defGk.rotY = Math.atan2(spot.x - defGk.pos.x, spot.z - defGk.pos.z);
      defGk.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(defGk.id);
    }

    // 6. Position attacking teammates in realistic open passing/run lanes
    const attackingTeammates = players.filter(
      (p) =>
        p.team === awardedTeam &&
        p.role === 'outfield' &&
        p.id !== taker?.id &&
        !p.isBenched &&
        !p.isSentOff
    );
    attackingTeammates.forEach((mate, idx) => {
      const openWingSign = idx % 2 === 0 ? (spot.x >= 0 ? -1 : 1) : (spot.x >= 0 ? 1 : -1);
      const forwardOffset = idx === 0 ? 7.5 : 2.2;
      const lateralOffset = idx === 0 ? openWingSign * 6.8 : openWingSign * 6.0;
      mate.pos.x = clamp(
        spot.x + toGoal.x * forwardOffset + rightVec.x * lateralOffset,
        -config.halfWidth + 2.4,
        config.halfWidth - 2.4
      );
      mate.pos.y = 0;
      mate.pos.z = clamp(
        spot.z + toGoal.z * forwardOffset + rightVec.z * lateralOffset,
        -config.halfLength + 4.5,
        config.halfLength - 4.5
      );
      mate.rotY = Math.atan2(spot.x - mate.pos.x, spot.z - mate.pos.z);
      mate.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(mate.id);
    });

    // 7. Position referee off to the side observing the wall
    const ref = players.find((p) => p.role === 'referee');
    if (ref) {
      const refSide = spot.x > 0 ? -1 : 1;
      ref.pos.x = clamp(spot.x + refSide * 7.2, -config.halfWidth + 2.0, config.halfWidth - 2.0);
      ref.pos.y = 0;
      ref.pos.z = clamp(spot.z - toGoal.z * 2.5, -config.halfLength + 4.0, config.halfLength - 4.0);
      ref.rotY = Math.atan2(spot.x - ref.pos.x, spot.z - ref.pos.z);
      ref.animState = 'ref_whistle';
      this.adapter.setPlayerVelocityZero?.(ref.id);
    }

    const reasonText =
      opts.reason ??
      (isDirectRange ? 'ضربة حرة مباشرة خطيرة! 📣🔥' : 'ضربة حرة — الكرة ثابتة 📣⚽');

    this.state = {
      active: true,
      stage: 'whistle_freeze',
      awardedTeam,
      spot: { ...spot },
      takerId: taker?.id ?? null,
      takerName: taker?.name ?? '',
      isHumanTaker,
      isDirectRange,
      wallSize: wallPlayerIds.length,
      wallPlayerIds,
      retreatRadiusM: FREE_KICK_LEGAL_RETREAT_M,
      distanceToGoalM: Math.round(distanceToGoalM * 10) / 10,
      reason: reasonText,
      cardShown: opts.cardShown ?? 'none',
      countdownSec: isHumanTaker ? FREE_KICK_HUMAN_TIMEOUT_SEC : this.aiDecisionDelay,
      elapsedSec: 0,
    };

    if (taker) {
      this.adapter.setSpeech(
        taker.id,
        isDirectRange ? 'ركّز.. هحطها في المقص! 🎯' : 'افتحولي زاوية باص! 📣',
        2.0
      );
    }
    this.adapter.setJumbotronHeadline?.(
      isDirectRange ? 'ضربة حرة مباشرة! 🎯' : 'ضربة حرة 📣',
      2.4
    );
    this.adapter.pushEvent(reasonText, '📣', 'foul');
    this.adapter.onSyncStore?.();

    return this.getState();
  }

  update(dt: number): void {
    if (!this.state.active) return;

    // Post-kick release phase: ball is live, brief 0.25s transition back to 'playing'
    if (this.releaseTimer > 0) {
      this.releaseTimer -= dt;
      if (this.releaseTimer <= 0) {
        this.finishToPlaying();
      }
      return;
    }

    const config = this.adapter.getConfig();
    const players = this.adapter.getPlayers();
    const defendingTeam: TeamId = this.state.awardedTeam === 'red' ? 'blue' : 'red';

    // Keep ball strictly dead at the free-kick spot
    this.adapter.placeDeadBall(this.state.spot);

    // Keep wall players aligned and all other opponents outside legal retreat radius
    for (const p of players) {
      if (p.isBenched || p.isSentOff || p.team !== defendingTeam || p.role !== 'outfield') {
        continue;
      }
      const wallSlot = this.wallTargets.get(p.id);
      if (wallSlot) {
        p.pos.x = wallSlot.pos.x;
        p.pos.z = wallSlot.pos.z;
        p.rotY = wallSlot.rotY;
        p.animState = 'idle';
        this.adapter.setPlayerVelocityZero?.(p.id);
      } else {
        this.enforceOpponentRetreat(p, this.state.spot, config, FREE_KICK_LEGAL_RETREAT_M);
      }
    }

    this.state.elapsedSec += dt;
    if (this.state.elapsedSec < 0.35) {
      this.state.stage = 'whistle_freeze';
    } else if (this.state.elapsedSec < 0.85) {
      this.state.stage = 'wall_setup';
    } else {
      this.state.stage = 'ready_to_kick';
    }

    this.state.countdownSec = Math.max(0, this.state.countdownSec - dt);

    if (this.state.stage === 'ready_to_kick' && this.state.countdownSec <= 0) {
      if (this.state.isHumanTaker) {
        this.executeAutoSafetyKick();
      } else {
        this.executeAITakerKick();
      }
    }
  }

  executePass(takerId: string, aimDir?: Vec3): boolean {
    if (!this.state.active || this.releaseTimer > 0) return false;
    if (this.state.takerId !== takerId) return false;
    if (this.state.elapsedSec < 0.35) return false;

    const players = this.adapter.getPlayers();
    const teammates = players.filter(
      (p) =>
        p.team === this.state.awardedTeam &&
        p.role === 'outfield' &&
        p.id !== takerId &&
        !p.isBenched &&
        !p.isSentOff
    );

    let targetDir: Vec3;
    let power = 17.5;

    if (teammates.length > 0) {
      const normAim = aimDir ? normalizeXZ(aimDir.x, aimDir.z) : null;
      let best = teammates[0];
      let bestScore = -Infinity;

      for (const mate of teammates) {
        const toMate = normalizeXZ(mate.pos.x - this.state.spot.x, mate.pos.z - this.state.spot.z);
        const dist = distXZ(mate.pos, this.state.spot);
        const align = normAim ? toMate.x * normAim.x + toMate.z * normAim.z : 0.5;
        const score = align * 3.0 - Math.abs(dist - 10) * 0.08;
        if (score > bestScore) {
          bestScore = score;
          best = mate;
        }
      }

      const dist = distXZ(best.pos, this.state.spot);
      targetDir = normalizeXZ(best.pos.x - this.state.spot.x, best.pos.z - this.state.spot.z);
      power = clamp(12.5 + dist * 0.65, 14, 22);
    } else if (aimDir && Math.hypot(aimDir.x, aimDir.z) > 0.1) {
      targetDir = normalizeXZ(aimDir.x, aimDir.z);
    } else {
      const config = this.adapter.getConfig();
      const oppGoalZ = (this.state.awardedTeam === 'red' ? 1 : -1) * config.halfLength;
      targetDir = normalizeXZ(0 - this.state.spot.x, oppGoalZ - this.state.spot.z);
    }

    this.fireKickAndRelease(takerId, targetDir, power, 0.75, 0, false);
    return true;
  }

  executeShot(takerId: string, aimDir: Vec3, charge: number, curl = 0): boolean {
    if (!this.state.active || this.releaseTimer > 0) return false;
    if (this.state.takerId !== takerId) return false;
    if (this.state.elapsedSec < 0.35) return false;

    const config = this.adapter.getConfig();
    const oppGoalZ = (this.state.awardedTeam === 'red' ? 1 : -1) * config.halfLength;
    const dir =
      Math.hypot(aimDir.x, aimDir.z) > 0.08
        ? normalizeXZ(aimDir.x, aimDir.z)
        : normalizeXZ(0 - this.state.spot.x, oppGoalZ - this.state.spot.z);

    const clampedCharge = clamp(charge, 0.15, 1.0);
    const clampedCurl = clamp(curl, -1, 1);
    const power = 19.5 + clampedCharge * 15.5;
    const lift = 3.2 + clampedCharge * 4.4;
    const curlSpinY = clampedCurl * 18;
    const isSuperShot = clampedCharge >= 0.72;

    this.fireKickAndRelease(takerId, dir, power, lift, curlSpinY, isSuperShot);
    return true;
  }

  cancel(): void {
    if (!this.state.active) return;
    this.reset();
    this.adapter.onSyncStore?.();
  }

  private executeAITakerKick(): void {
    const takerId = this.state.takerId;
    if (!takerId) {
      this.finishToPlaying();
      return;
    }

    const players = this.adapter.getPlayers();
    const config = this.adapter.getConfig();
    const attackDir = this.state.awardedTeam === 'red' ? 1 : -1;
    const oppGoalZ = attackDir * config.halfLength;

    // 1. Respect human teammate calling for pass!
    const callerId = this.adapter.getCallForPassTargetId?.(this.state.awardedTeam) ?? null;
    if (callerId && callerId !== takerId) {
      const caller = players.find((p) => p.id === callerId && !p.isBenched && !p.isSentOff);
      if (caller) {
        const dir = normalizeXZ(caller.pos.x - this.state.spot.x, caller.pos.z - this.state.spot.z);
        const dist = distXZ(caller.pos, this.state.spot);
        this.fireKickAndRelease(takerId, dir, clamp(13 + dist * 0.65, 14.5, 22), 0.7, 0, false);
        return;
      }
    }

    // 2. Direct curved shot if within 19m of opponent goal
    if (this.state.distanceToGoalM <= FREE_KICK_AI_DIRECT_RANGE_M) {
      const cornerSign = this.state.spot.x >= 0 ? -1 : 1;
      const aimX = cornerSign * config.goalWidth * (0.3 + Math.random() * 0.1);
      const dir = normalizeXZ(aimX - this.state.spot.x, oppGoalZ - this.state.spot.z);
      const power = 25 + Math.random() * 4.5;
      const lift = 4.8 + Math.random() * 1.4;
      const curlSpinY = -cornerSign * (14 + Math.random() * 6);
      this.fireKickAndRelease(takerId, dir, power, lift, curlSpinY, true);
      return;
    }

    // 3. Otherwise crisp pass to best open teammate
    const teammates = players.filter(
      (p) =>
        p.team === this.state.awardedTeam &&
        p.role === 'outfield' &&
        p.id !== takerId &&
        !p.isBenched &&
        !p.isSentOff
    );
    if (teammates.length > 0) {
      const best = [...teammates].sort((a, b) => {
        const aHuman = a.isHumanControlled || a.isRemoteHuman ? 4 : 0;
        const bHuman = b.isHumanControlled || b.isRemoteHuman ? 4 : 0;
        const aAdv = (a.pos.z - this.state.spot.z) * attackDir;
        const bAdv = (b.pos.z - this.state.spot.z) * attackDir;
        return bHuman + bAdv - (aHuman + aAdv);
      })[0];
      const dir = normalizeXZ(best.pos.x - this.state.spot.x, best.pos.z - this.state.spot.z);
      const dist = distXZ(best.pos, this.state.spot);
      this.fireKickAndRelease(takerId, dir, clamp(13.5 + dist * 0.62, 15, 22), 0.75, 0, false);
      return;
    }

    // Fallback: drive toward goal
    const dir = normalizeXZ(0 - this.state.spot.x, oppGoalZ - this.state.spot.z);
    this.fireKickAndRelease(takerId, dir, 24, 3.8, 0, false);
  }

  private executeAutoSafetyKick(): void {
    const takerId = this.state.takerId;
    if (!takerId) {
      this.finishToPlaying();
      return;
    }

    if (this.state.isDirectRange) {
      const config = this.adapter.getConfig();
      const oppGoalZ = (this.state.awardedTeam === 'red' ? 1 : -1) * config.halfLength;
      const dir = normalizeXZ(0 - this.state.spot.x, oppGoalZ - this.state.spot.z);
      this.fireKickAndRelease(takerId, dir, 25, 4.6, 10, false);
    } else {
      this.executePass(takerId);
    }
  }

  private fireKickAndRelease(
    takerId: string,
    dir: Vec3,
    power: number,
    lift: number,
    curlSpinY: number,
    isSuperShot: boolean
  ): void {
    this.adapter.kickBall(takerId, dir, power, lift, curlSpinY, isSuperShot);
    this.releaseTimer = FREE_KICK_RELEASE_DURATION_SEC;
    this.state.countdownSec = 0;
    this.adapter.onSyncStore?.();
  }

  private finishToPlaying(): void {
    this.state = createInitialFreeKickState();
    this.wallTargets.clear();
    this.releaseTimer = 0;
    this.adapter.setPhase('playing');
    this.adapter.onSyncStore?.();
  }

  private pickTaker(
    players: FreeKickPlayerProxy[],
    awardedTeam: TeamId,
    spot: Vec3,
    preferredTakerId?: string | null
  ): FreeKickPlayerProxy | null {
    const activeOutfield = players.filter(
      (p) => p.team === awardedTeam && p.role === 'outfield' && !p.isBenched && !p.isSentOff
    );
    if (preferredTakerId) {
      const pref = activeOutfield.find((p) => p.id === preferredTakerId);
      if (pref) return pref;
    }
    const human = activeOutfield.find((p) => p.isHumanControlled || p.isRemoteHuman);
    if (human) return human;
    if (activeOutfield.length > 0) {
      return [...activeOutfield].sort((a, b) => distXZ(a.pos, spot) - distXZ(b.pos, spot))[0];
    }
    return (
      players.find(
        (p) => p.team === awardedTeam && p.role === 'goalkeeper' && !p.isBenched && !p.isSentOff
      ) ?? null
    );
  }

  private enforceOpponentRetreat(
    player: FreeKickPlayerProxy,
    spot: Vec3,
    config: StadiumConfig,
    minRadius: number
  ): void {
    const dx = player.pos.x - spot.x;
    const dz = player.pos.z - spot.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= minRadius) return;

    const away =
      dist > 0.05
        ? { x: dx / dist, z: dz / dist }
        : { x: player.pos.x >= 0 ? 1 : -1, z: 0 };

    player.pos.x = clamp(spot.x + away.x * minRadius, -config.halfWidth + 1.2, config.halfWidth - 1.2);
    player.pos.z = clamp(spot.z + away.z * minRadius, -config.halfLength + 1.5, config.halfLength - 1.5);
    this.adapter.setPlayerVelocityZero?.(player.id);
  }
}
