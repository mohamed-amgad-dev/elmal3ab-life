import type { PlayerEntityState, TeamId, Vec3 } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export interface GoalkeeperAIContext {
  gk: PlayerEntityState;
  ballPos: Vec3;
  ballVel: Vec3;
  config: StadiumConfig;
  hasCaughtBall: boolean;
  teammates: ReadonlyArray<PlayerEntityState>;
  diveCooldown: number;
  dt: number;
}

export interface GoalkeeperAIDecision {
  targetPos: Vec3;
  sprint: boolean;
  facingYaw: number;
  diveDir: 'none' | 'left' | 'right' | 'center';
  throwDir: Vec3 | null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: 0, z: z / len };
}

/**
 * Arcade Goalkeeper AI:
 * - Tracks shots smoothly across the goal mouth and narrows shooting angles.
 * - Sweeps loose slow balls inside the penalty box.
 * - Predicts fast incoming shots and executes dramatic lateral saves.
 * - Distributes cleanly to open teammates (favoring human teammates!) after catching.
 */
export class GoalkeeperAI {
  private readonly holdTimers = new Map<string, number>();

  reset(): void {
    this.holdTimers.clear();
  }

  evaluate(ctx: GoalkeeperAIContext): GoalkeeperAIDecision {
    const { gk, ballPos, ballVel, config, hasCaughtBall, teammates, diveCooldown, dt } = ctx;
    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    // Red GK defends Z = -34 facing +Z (yaw 0); Blue GK defends Z = +34 facing -Z (yaw PI)
    const forwardZ = team === 'red' ? 1 : -1;
    const goalLineZ = team === 'red' ? -config.halfLength + 1.0 : config.halfLength - 1.0;
    const baseYaw = team === 'red' ? 0 : Math.PI;

    // 1. If holding the caught ball, pause briefly then distribute cleanly upfield!
    if (hasCaughtBall) {
      const held = (this.holdTimers.get(gk.id) ?? 0) + dt;
      this.holdTimers.set(gk.id, held);

      if (held >= 0.7) {
        this.holdTimers.set(gk.id, 0);
        const target = this.pickDistributionTarget(gk, teammates, forwardZ);
        const throwDir = target
          ? normalizeXZ(target.pos.x - gk.pos.x, target.pos.z + forwardZ * 3 - gk.pos.z)
          : { x: (Math.random() - 0.5) * 0.4, y: 0, z: forwardZ };

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

    const ballSpeed = Math.hypot(ballVel.x, ballVel.z);
    const distFromGoalLine = (ballPos.z - goalLineZ) * forwardZ;
    const movingTowardGoal = ballVel.z * forwardZ < -4.5;

    // 2. Shot prediction & dramatic diving save!
    if (movingTowardGoal && diveCooldown <= 0 && distFromGoalLine > 0.5 && distFromGoalLine < 24) {
      const closingSpeed = Math.abs(ballVel.z);
      const timeToGoal = distFromGoalLine / Math.max(closingSpeed, 0.1);

      if (timeToGoal < 0.72) {
        const predictedX = ballPos.x + ballVel.x * timeToGoal;
        const maxReach = config.goalWidth * 0.55;
        if (Math.abs(predictedX) <= maxReach) {
          const deltaX = predictedX - gk.pos.x;
          // Convert world X offset into GK's local left/right!
          // Red GK faces +Z -> right is -X, left is +X (wait: forward=(0,0,1), up=(0,1,0) => right = forward x up = (-1,0,0)!)
          // Let's check: forward=(0,0,1), up=(0,1,0), cross(forward, up) = (0*0 - 1*1, 0, 0*0 - 0*0) = (-1, 0, 0)!
          // So for Red GK (+Z), GK's local RIGHT is -X and local LEFT is +X!
          // For Blue GK (-Z), GK's local RIGHT is +X and local LEFT is -X!
          const localRightDelta = deltaX * -forwardZ;
          let diveDir: 'left' | 'right' | 'center' = 'center';
          if (Math.abs(localRightDelta) > 0.85) {
            diveDir = localRightDelta > 0 ? 'right' : 'left';
          }

          return {
            targetPos: {
              x: clamp(predictedX, -config.goalWidth * 0.46, config.goalWidth * 0.46),
              y: 0,
              z: goalLineZ + forwardZ * 0.6,
            },
            sprint: true,
            facingYaw: Math.atan2(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z),
            diveDir,
            throwDir: null,
          };
        }
      }
    }

    // 3. Sweeper-keeper: intercept slow loose ball inside penalty box
    const inPenaltyBox =
      Math.abs(ballPos.x) < config.penaltyBoxWidth * 0.42 &&
      distFromGoalLine > 0.4 &&
      distFromGoalLine < config.penaltyBoxDepth * 0.75;

    if (inPenaltyBox && ballSpeed < 7.5) {
      return {
        targetPos: { x: ballPos.x, y: 0, z: ballPos.z },
        sprint: true,
        facingYaw: Math.atan2(ballPos.x - gk.pos.x, ballPos.z - gk.pos.z),
        diveDir: 'none',
        throwDir: null,
      };
    }

    // 4. Standard lateral tracking + angle narrowing
    const maxLateral = config.goalWidth * 0.42;
    const trackX = clamp(ballPos.x * 0.42, -maxLateral, maxLateral);
    const stepOut = clamp((24 - distFromGoalLine) * 0.14, 0.3, 3.2);
    const trackZ = goalLineZ + forwardZ * stepOut;

    return {
      targetPos: { x: trackX, y: 0, z: trackZ },
      sprint: Math.abs(trackX - gk.pos.x) > 1.8,
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
      const humanBonus = tm.isHumanControlled ? 12 : 0;
      const score = advance + humanBonus;
      if (score > bestScore) {
        bestScore = score;
        best = tm;
      }
    }
    return best;
  }
}
