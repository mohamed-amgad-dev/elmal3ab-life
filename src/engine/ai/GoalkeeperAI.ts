import type { GKDiveHeight } from '../../types/engine';
import type { AIDifficulty, PlayerEntityState, TeamId, Vec3 } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export interface GoalkeeperProfile {
  moveSpeed: number;
  sprintSpeed: number;
  reactionDelaySec: number;
  diveReachXZ: number;
  diveReachY: number;
  standReachXZ: number;
  standReachY: number;
  parryPowerThreshold: number;
}

const GOALKEEPER_PROFILES: Record<AIDifficulty, GoalkeeperProfile> = {
  easy: {
    moveSpeed: 4.8,
    sprintSpeed: 6.8,
    reactionDelaySec: 0.22,
    diveReachXZ: 2.05,
    diveReachY: 2.35,
    standReachXZ: 1.45,
    standReachY: 2.15,
    parryPowerThreshold: 17,
  },
  medium: {
    moveSpeed: 6.0,
    sprintSpeed: 8.6,
    reactionDelaySec: 0.11,
    diveReachXZ: 2.55,
    diveReachY: 2.75,
    standReachXZ: 1.75,
    standReachY: 2.40,
    parryPowerThreshold: 19,
  },
  hard: {
    moveSpeed: 6.9,
    sprintSpeed: 9.8,
    reactionDelaySec: 0.05,
    diveReachXZ: 2.95,
    diveReachY: 3.05,
    standReachXZ: 1.95,
    standReachY: 2.55,
    parryPowerThreshold: 21,
  },
};

export function getGoalkeeperProfile(difficulty: AIDifficulty): GoalkeeperProfile {
  return { ...GOALKEEPER_PROFILES[difficulty] };
}

export interface GoalkeeperAIContext {
  gk: PlayerEntityState;
  ballPos: Vec3;
  ballVel: Vec3;
  ballSpin?: Vec3;
  config: StadiumConfig;
  hasCaughtBall: boolean;
  teammates: ReadonlyArray<PlayerEntityState>;
  diveCooldown: number;
  difficulty?: AIDifficulty;
  dt: number;
}

export interface GoalkeeperAIDecision {
  targetPos: Vec3;
  sprint: boolean;
  facingYaw: number;
  diveDir: 'none' | 'left' | 'right' | 'center';
  throwDir: Vec3 | null;
  diveTargetX?: number;
  diveHeight?: GKDiveHeight;
  diveSpeed?: number;
  preferParry?: boolean;
}

const GRAVITY = 26.0;
const MAGNUS_STRENGTH = 0.042;
const BALL_RADIUS = 0.42;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: 0, z: z / len };
}

/**
 * Human-Plausible Goalkeeper AI:
 * - True angle-bisector positioning between ball and goal mouth center (steps out up to 3.8m in 1v1s,
 *   drops to 1.1m on distant/lob threats).
 * - Ballistic 3D shot prediction (gravity + Magnus spin drift) gated by difficulty reactionDelaySec.
 * - Calibrated diveTargetX, diveHeight ('low' | 'mid' | 'high'), diveSpeed, and preferParry so
 *   the keeper dives cleanly to the ball's path without overshooting or teleporting.
 * - Sweeper-keeper clearance on slow loose box balls and smart human-favoring distribution.
 */
export class GoalkeeperAI {
  private readonly holdTimers = new Map<string, number>();
  private readonly shotReactionTimers = new Map<string, number>();

  reset(): void {
    this.holdTimers.clear();
    this.shotReactionTimers.clear();
  }

  evaluate(ctx: GoalkeeperAIContext): GoalkeeperAIDecision {
    const { gk, ballPos, ballVel, ballSpin, config, hasCaughtBall, teammates, diveCooldown, dt } =
      ctx;
    const difficulty: AIDifficulty = ctx.difficulty ?? 'medium';
    const profile = GOALKEEPER_PROFILES[difficulty];

    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    // Red GK defends Z = -halfLength facing +Z (yaw 0); Blue GK defends Z = +halfLength facing -Z (yaw PI)
    const forwardZ = team === 'red' ? 1 : -1;
    const goalLineZ = team === 'red' ? -config.halfLength + 1.0 : config.halfLength - 1.0;
    const baseYaw = team === 'red' ? 0 : Math.PI;

    // 1. CAUGHT BALL DISTRIBUTION (~0.65s hold then clean throw to open teammate, favoring human!)
    if (hasCaughtBall) {
      this.shotReactionTimers.set(gk.id, 0);
      const held = (this.holdTimers.get(gk.id) ?? 0) + dt;
      this.holdTimers.set(gk.id, held);

      if (held >= 0.65) {
        this.holdTimers.set(gk.id, 0);
        const target = this.pickDistributionTarget(gk, teammates, forwardZ);
        const throwDir = target
          ? normalizeXZ(target.pos.x - gk.pos.x, target.pos.z + forwardZ * 3.2 - gk.pos.z)
          : { x: (Math.random() - 0.5) * 0.35, y: 0, z: forwardZ };

        return {
          targetPos: { x: gk.pos.x, y: 0, z: goalLineZ + forwardZ * 1.2 },
          sprint: false,
          facingYaw: Math.atan2(throwDir.x, throwDir.z),
          diveDir: 'none',
          throwDir,
        };
      }

      return {
        targetPos: { x: gk.pos.x, y: 0, z: goalLineZ + forwardZ * 1.2 },
        sprint: false,
        facingYaw: baseYaw,
        diveDir: 'none',
        throwDir: null,
      };
    }

    this.holdTimers.set(gk.id, 0);

    const ballSpeedXZ = Math.hypot(ballVel.x, ballVel.z);
    const ballSpeed3D = Math.hypot(ballVel.x, ballVel.y, ballVel.z);
    const distFromGoalLine = (ballPos.z - goalLineZ) * forwardZ;
    const distToGKPlane = (ballPos.z - gk.pos.z) * forwardZ;
    const movingTowardGoal = ballVel.z * forwardZ < -4.2;

    // 2. BALLISTIC 3D SHOT PREDICTION + REACTION DELAY + CALIBRATED DIVE
    const isDangerousIncoming =
      movingTowardGoal && distToGKPlane > 0.25 && distFromGoalLine > 0.3 && distFromGoalLine < 32;

    if (isDangerousIncoming) {
      const closingSpeed = Math.abs(ballVel.z);
      const timeToGK = distToGKPlane / Math.max(closingSpeed, 0.1);

      if (timeToGK > 0.02 && timeToGK < 0.85) {
        // Account for subtle Magnus curve drift from spin.y and mild air drag
        const spinY = ballSpin?.y ?? 0;
        const magnusAx = spinY * ballVel.z * MAGNUS_STRENGTH;
        const magnusDriftX = 0.42 * magnusAx * timeToGK * timeToGK;
        const dragFactor = Math.exp(-0.17 * timeToGK);
        const predictedX = ballPos.x + ballVel.x * timeToGK * dragFactor + magnusDriftX;

        // Account for gravity (26 m/s²) at the GK's Z plane
        const rawPredictedY =
          ballPos.y + ballVel.y * timeToGK - 0.5 * GRAVITY * timeToGK * timeToGK;
        const predictedY = Math.max(BALL_RADIUS, rawPredictedY);

        const maxMouthThreatX = config.goalWidth * 0.58;
        const isOnTargetThreat =
          Math.abs(predictedX) <= maxMouthThreatX && predictedY <= config.goalHeight + 0.7;

        if (isOnTargetThreat) {
          const reactedTime = (this.shotReactionTimers.get(gk.id) ?? 0) + dt;
          this.shotReactionTimers.set(gk.id, reactedTime);

          if (reactedTime >= profile.reactionDelaySec && diveCooldown <= 0) {
            const deltaX = predictedX - gk.pos.x;
            // Red GK (+Z): local right is -X; Blue GK (-Z): local right is +X
            const localRightDelta = deltaX * -forwardZ;

            let diveDir: 'left' | 'right' | 'center' = 'center';
            if (Math.abs(localRightDelta) > 0.65) {
              diveDir = localRightDelta > 0 ? 'right' : 'left';
            }

            const diveTargetX = clamp(
              predictedX,
              -config.goalWidth * 0.49,
              config.goalWidth * 0.49
            );
            const diveSpeed = clamp(
              Math.abs(deltaX) / Math.max(0.24, Math.min(timeToGK, 0.48)),
              5.8,
              12.6
            );
            const diveHeight: GKDiveHeight =
              predictedY < 0.75 ? 'low' : predictedY > 1.65 ? 'high' : 'mid';
            const preferParry =
              ballSpeed3D > profile.parryPowerThreshold ||
              Math.abs(localRightDelta) > 1.55 ||
              diveHeight === 'high';

            return {
              targetPos: {
                x: diveTargetX,
                y: 0,
                z: gk.pos.z,
              },
              sprint: true,
              facingYaw: Math.atan2(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z),
              diveDir,
              throwDir: null,
              diveTargetX,
              diveHeight,
              diveSpeed,
              preferParry,
            };
          }
        } else {
          this.shotReactionTimers.set(gk.id, 0);
        }
      } else {
        this.shotReactionTimers.set(gk.id, 0);
      }
    } else {
      this.shotReactionTimers.set(gk.id, 0);
    }

    // 3. SWEEPER-KEEPER: decisively claim slow loose balls inside the penalty box
    const inPenaltyBox =
      Math.abs(ballPos.x) < config.penaltyBoxWidth * 0.44 &&
      distFromGoalLine > 0.4 &&
      distFromGoalLine < config.penaltyBoxDepth * 0.8;

    const distGKToBall = Math.hypot(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z);
    if (inPenaltyBox && ballSpeedXZ < 7.2 && ballPos.y < 1.9 && distGKToBall < 11.0) {
      return {
        targetPos: { x: ballPos.x, y: 0, z: ballPos.z },
        sprint: true,
        facingYaw: Math.atan2(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z),
        diveDir: 'none',
        throwDir: null,
      };
    }

    // 4. TRUE ANGLE-BISECTOR POSITIONING
    // Line from goal mouth center (0, goalLineZ) to ball (ballPos.x, ballPos.z)
    const clampedBallDepth = Math.max(0.5, distFromGoalLine);
    const baseDepth = clamp(3.8 - (clampedBallDepth - 5.5) * 0.145, 1.1, 3.8);
    // Pull back slightly on high lobs so keeper doesn't get chipped easily
    const lobPullback = ballPos.y > 2.6 ? clamp((ballPos.y - 2.6) * 0.45, 0, 1.4) : 0;
    const depth = clamp(baseDepth - lobPullback, 1.0, Math.min(3.8, Math.max(1.0, clampedBallDepth - 1.3)));

    const maxLateral = config.goalWidth * 0.44;
    const bisectorRatio = depth / clampedBallDepth;
    const trackX = clamp(ballPos.x * bisectorRatio, -maxLateral, maxLateral);
    const trackZ = goalLineZ + forwardZ * depth;

    return {
      targetPos: { x: trackX, y: 0, z: trackZ },
      sprint: Math.hypot(trackX - gk.pos.x, trackZ - gk.pos.z) > 1.7,
      facingYaw: Math.atan2(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z),
      diveDir: 'none',
      throwDir: null,
    };
  }

  private pickDistributionTarget(
    gk: PlayerEntityState,
    teammates: ReadonlyArray<PlayerEntityState>,
    forwardZ: number
  ): PlayerEntityState | null {
    let best: PlayerEntityState | null = null;
    let bestScore = -Infinity;

    for (const tm of teammates) {
      if (tm.id === gk.id || tm.isBenched || tm.isSentOff || tm.role !== 'outfield') {
        continue;
      }
      const advance = (tm.pos.z - gk.pos.z) * forwardZ;
      const widthBonus = Math.min(Math.abs(tm.pos.x) * 0.25, 3.0);
      const humanBonus = tm.isHumanControlled ? 13.0 : 0;
      const score = advance + widthBonus + humanBonus;
      if (score > bestScore) {
        bestScore = score;
        best = tm;
      }
    }
    return best;
  }
}
