import type {
  AIDifficulty,
  CallForPassState,
  PlayerEntityState,
  Vec3,
} from '../../types/game';

export const CALL_FOR_PASS_MAX_RANGE_M = 28.0;
export const PASS_MIN_RANGE_M = 2.6;
export const PASS_MAX_RANGE_M = 28.0;
export const RECEIVE_PASS_COOLDOWN_SEC = 0.85;
export const TIGHT_PRESS_OVERRIDE_DIST_M = 2.8;
export const TAP_IN_DISTANCE_M = 7.5;
export const PASS_BEFORE_SHOOT_DIST_M = 11.5;

export type TeamPassReason =
  | 'call_for_pass'
  | 'human_open'
  | 'pressure_release'
  | 'attacking_pass'
  | 'layoff'
  | 'recycle';

export interface PassDecision {
  target: PlayerEntityState;
  score: number;
  loft: boolean;
  reason: TeamPassReason;
  nearestOppToReceiver: number;
  laneBlocked: boolean;
}

export interface PassEvaluationInput {
  carrier: PlayerEntityState;
  teammates: ReadonlyArray<PlayerEntityState>;
  opponents: ReadonlyArray<PlayerEntityState>;
  attackDir: number;
  targetGoalZ: number;
  difficulty: AIDifficulty;
  elapsed: number;
  callForPass?: CallForPassState | null;
  carrierNearestOppDist: number;
  requireCleanLane: boolean;
  isLayoff?: boolean;
  lastPasserId?: string | null;
  timeSinceReceivedSec?: number;
}

export interface PassTrajectory {
  dir: Vec3;
  power: number;
  lift: number;
}

interface ReceiveRecord {
  passerId: string;
  receivedAtElapsed: number;
}

interface PassDifficultyProfile {
  organicThreshold: number;
  pressureThreshold: number;
  layoffThreshold: number;
  lobPenalty: number;
  humanUnmarkedBonus: number;
  allowOrganicLob: boolean;
}

const PASS_DIFFICULTY_PROFILES: Record<AIDifficulty, PassDifficultyProfile> = {
  easy: {
    organicThreshold: 9.2,
    pressureThreshold: 4.0,
    layoffThreshold: 5.5,
    lobPenalty: -4.2,
    humanUnmarkedBonus: 11.5,
    allowOrganicLob: false,
  },
  medium: {
    organicThreshold: 7.4,
    pressureThreshold: 2.8,
    layoffThreshold: 4.2,
    lobPenalty: -2.4,
    humanUnmarkedBonus: 13.0,
    allowOrganicLob: true,
  },
  hard: {
    organicThreshold: 6.2,
    pressureThreshold: 2.0,
    layoffThreshold: 3.4,
    lobPenalty: -1.6,
    humanUnmarkedBonus: 13.5,
    allowOrganicLob: true,
  },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: x / len, y: 0, z: z / len };
}

function rotateXZ(dir: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return normalizeXZ(dir.x * c - dir.z * s, dir.x * s + dir.z * c);
}

function pointToSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): { dist: number; t: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  if (abLenSq < 1e-6) {
    return { dist: Math.hypot(px - ax, pz - az), t: 0 };
  }
  const t = clamp(((px - ax) * abx + (pz - az) * abz) / abLenSq, 0, 1);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return { dist: Math.hypot(px - cx, pz - cz), t };
}

/**
 * Tracks recent pass receipts per carrier to prevent robotic 1-2 ping-pong loops
 * immediately after receiving the ball (~0.85s cooldown unless tightly pressed or
 * human actively calls for pass).
 */
export class PassHysteresisTracker {
  private readonly records = new Map<string, ReceiveRecord>();

  reset(): void {
    this.records.clear();
  }

  recordReceipt(receiverId: string, passerId: string, elapsed: number): void {
    if (!receiverId || !passerId || receiverId === passerId) return;
    this.records.set(receiverId, { passerId, receivedAtElapsed: elapsed });
  }

  getRecentPasser(
    carrierId: string,
    elapsed: number
  ): { passerId: string; ageSec: number } | null {
    const rec = this.records.get(carrierId);
    if (!rec) return null;
    const ageSec = elapsed - rec.receivedAtElapsed;
    if (ageSec < 0 || ageSec > RECEIVE_PASS_COOLDOWN_SEC * 2.5) {
      this.records.delete(carrierId);
      return null;
    }
    return { passerId: rec.passerId, ageSec };
  }
}

/**
 * Checks whether any opposing player stands inside the ground passing corridor
 * between `from` and `to`.
 */
export function isGroundLaneBlocked(
  from: Vec3,
  to: Vec3,
  opponents: ReadonlyArray<PlayerEntityState>,
  corridorWidth = 1.85
): boolean {
  for (const opp of opponents) {
    const seg = pointToSegmentXZ(opp.pos.x, opp.pos.z, from.x, from.z, to.x, to.z);
    if (seg.t > 0.08 && seg.t < 0.92 && seg.dist < corridorWidth) {
      return true;
    }
  }
  return false;
}

function getNearestOpponentDist(
  pos: Vec3,
  opponents: ReadonlyArray<PlayerEntityState>
): number {
  let nearest = Infinity;
  for (const opp of opponents) {
    const d = distXZ(pos, opp.pos);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * Resolves an active Call-for-Pass target if valid for the carrier's team
 * and within pass range (<= 28m). Allows forward, lateral, diagonal, or safe
 * back-passes, and recommends `loft: true` if the ground lane is obstructed.
 */
export function evaluateCallForPassTarget(
  input: PassEvaluationInput
): PassDecision | null {
  const { carrier, teammates, opponents, callForPass } = input;
  if (
    !callForPass ||
    !callForPass.active ||
    !callForPass.callerId ||
    callForPass.callerTeam !== carrier.team ||
    callForPass.callerId === carrier.id
  ) {
    return null;
  }

  const caller = teammates.find(
    (tm) =>
      tm.id === callForPass.callerId &&
      tm.role === 'outfield' &&
      !tm.isBenched &&
      !tm.isSentOff
  );
  if (!caller) return null;

  const dist = distXZ(carrier.pos, caller.pos);
  if (dist < 1.8 || dist > CALL_FOR_PASS_MAX_RANGE_M) {
    return null;
  }

  const laneBlocked = isGroundLaneBlocked(carrier.pos, caller.pos, opponents, 1.85);
  const nearestOppToReceiver = getNearestOpponentDist(caller.pos, opponents);

  return {
    target: caller,
    score: 100,
    loft: laneBlocked,
    reason: 'call_for_pass',
    nearestOppToReceiver,
    laneBlocked,
  };
}

/**
 * Evaluates realistic team-passing options for an AI ball carrier:
 * 1. Immediate priority for an active `callForPass` from a teammate (<= 28m).
 * 2. Organic scoring based on open space (`nearestOppDist`), attacking run angle,
 *    forward progression, lateral/recycling outlets, and a strong bonus for an
 *    unmarked human teammate (`nearestOppDist >= 3.0m`).
 * 3. Anti-ping-pong hysteresis: avoids passing straight back to the same passer
 *    within ~0.85s unless tightly pressed (< 2.8m) or human actively calls for pass.
 */
export function evaluateTeamPass(input: PassEvaluationInput): PassDecision | null {
  // 1. Active Call-for-Pass always wins (except point-blank tap-ins handled by OutfieldAI)
  const callDecision = evaluateCallForPassTarget(input);
  if (callDecision) return callDecision;

  const {
    carrier,
    teammates,
    opponents,
    attackDir,
    targetGoalZ,
    difficulty,
    carrierNearestOppDist,
    requireCleanLane,
    isLayoff,
    lastPasserId,
    timeSinceReceivedSec,
  } = input;

  const profile = PASS_DIFFICULTY_PROFILES[difficulty];
  const underTightPress = carrierNearestOppDist < TIGHT_PRESS_OVERRIDE_DIST_M;
  const underPressure = carrierNearestOppDist < 4.5;
  const inAntiPingPongWindow =
    Boolean(lastPasserId) &&
    timeSinceReceivedSec !== undefined &&
    timeSinceReceivedSec < RECEIVE_PASS_COOLDOWN_SEC;

  const carrierGoalDist = Math.hypot(0 - carrier.pos.x, targetGoalZ - carrier.pos.z);

  let best: PassDecision | null = null;

  for (const tm of teammates) {
    if (tm.role !== 'outfield' || tm.isBenched || tm.isSentOff) continue;

    const dist = distXZ(carrier.pos, tm.pos);
    if (dist < PASS_MIN_RANGE_M || dist > PASS_MAX_RANGE_M) continue;

    // Anti-ping-pong hysteresis: skip immediate return pass unless tightly pressed
    if (inAntiPingPongWindow && tm.id === lastPasserId && !underTightPress) {
      continue;
    }

    const nearestOppToReceiver = getNearestOpponentDist(tm.pos, opponents);
    const laneBlocked = isGroundLaneBlocked(carrier.pos, tm.pos, opponents, 1.85);

    // Determine if we can chip/lob over a blocked ground lane
    let useLoft = false;
    if (laneBlocked) {
      const canLobOver =
        (profile.allowOrganicLob || tm.isHumanControlled) &&
        dist >= 7.5 &&
        nearestOppToReceiver >= 2.6;
      if (canLobOver) {
        useLoft = true;
      } else if (requireCleanLane) {
        continue;
      }
    }

    const forwardGain = (tm.pos.z - carrier.pos.z) * attackDir;
    const tmGoalDist = Math.hypot(0 - tm.pos.x, targetGoalZ - tm.pos.z);
    const goalProgress = carrierGoalDist - tmGoalDist;

    // Open space around receiver (strongly rewards unmarked outlets)
    const spaceScore = Math.min(nearestOppToReceiver, 10) * 1.45;

    // Forward progression + realistic lateral/recycling allowance (no hard forwardGain > 4 block)
    let progressionScore: number;
    if (forwardGain >= 0) {
      progressionScore = Math.min(forwardGain, 16) * 0.72;
    } else if (forwardGain >= -6.5) {
      // Lateral or safe recycling outlet — small gentle cost, positive under pressure
      progressionScore = underPressure ? 1.4 : forwardGain * 0.28;
    } else {
      // Deep back-pass — only attractive when under pressure
      progressionScore = underPressure ? 0.5 : forwardGain * 0.55;
    }

    // Attacking run angle: reward teammates who improve shooting angle or stretch opposite flank
    const oppositeFlank =
      Math.abs(carrier.pos.x) > 2.5 &&
      Math.sign(carrier.pos.x) !== Math.sign(tm.pos.x) &&
      Math.abs(tm.pos.x) > 2.5;
    const centralGoalBonus =
      tmGoalDist < 18 && Math.abs(tm.pos.x) < 7.5 && nearestOppToReceiver >= 2.4 ? 3.2 : 0;
    const angleBonus =
      (goalProgress > 1.5 ? Math.min(goalProgress * 0.45, 4.5) : 0) +
      (oppositeFlank && forwardGain > -2.5 ? 2.4 : 0) +
      centralGoalBonus;

    // Clear priority bonus for an unmarked human teammate (nearestOppDist >= 3.0m)
    let humanBonus = 0;
    if (tm.isHumanControlled) {
      if (nearestOppToReceiver >= 3.0) {
        humanBonus = profile.humanUnmarkedBonus + (forwardGain > 0.5 ? 3.5 : 1.0);
      } else if (!laneBlocked && nearestOppToReceiver >= 1.8) {
        humanBonus = 4.2;
      }
    }

    // Lane penalty (small if cleanly loftable, heavier if forced ground through traffic)
    const lanePenalty = laneBlocked ? (useLoft ? profile.lobPenalty : -8.5) : 0;

    // Tightly marked receiver penalty
    const markedPenalty = nearestOppToReceiver < 1.9 ? -5.5 : 0;

    const score =
      spaceScore +
      progressionScore +
      angleBonus +
      humanBonus +
      lanePenalty +
      markedPenalty;

    const threshold = isLayoff
      ? profile.layoffThreshold
      : underPressure
        ? profile.pressureThreshold
        : profile.organicThreshold;

    if (score >= threshold && (!best || score > best.score)) {
      let reason: TeamPassReason = 'attacking_pass';
      if (isLayoff) {
        reason = 'layoff';
      } else if (tm.isHumanControlled && nearestOppToReceiver >= 3.0) {
        reason = 'human_open';
      } else if (underPressure) {
        reason = 'pressure_release';
      } else if (forwardGain < 0.5) {
        reason = 'recycle';
      }

      best = {
        target: tm,
        score,
        loft: useLoft,
        reason,
        nearestOppToReceiver,
        laneBlocked,
      };
    }
  }

  return best;
}

/**
 * Computes pass direction, speed, and vertical lift for ground or lofted passes.
 */
export function computePassTrajectory(
  carrierPos: Vec3,
  targetPos: Vec3,
  attackDir: number,
  loft: boolean,
  aimJitterRad = 0
): PassTrajectory {
  const dist = distXZ(carrierPos, targetPos);
  const forwardGain = (targetPos.z - carrierPos.z) * attackDir;

  // Lead forward runners gently; keep lateral/back-passes directly to feet
  const leadAmount = forwardGain > 1.0 ? clamp(dist * 0.16, 1.0, 3.4) : 0.35;
  const leadZ = targetPos.z + attackDir * leadAmount;

  let dir = normalizeXZ(targetPos.x - carrierPos.x, leadZ - carrierPos.z);
  if (aimJitterRad > 0) {
    dir = rotateXZ(dir, (Math.random() - 0.5) * 2 * aimJitterRad);
  }

  if (loft) {
    const power = clamp(13.8 + dist * 0.58, 15.5, 25.5);
    const lift = clamp(0.38 + dist * 0.008, 0.4, 0.56);
    return { dir, power, lift };
  }

  const power = clamp(12.2 + dist * 0.56, 14.0, 24.5);
  return { dir, power, lift: 0.06 };
}
