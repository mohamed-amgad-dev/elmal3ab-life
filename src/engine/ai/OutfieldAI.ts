import type {
  AdminRules,
  PlayerEntityState,
  RoleType,
  TacticalStance,
  TeamId,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export interface OutfieldAIContext {
  player: PlayerEntityState;
  allPlayers: ReadonlyArray<PlayerEntityState>;
  ballPos: Vec3;
  ballVel: Vec3;
  possessorId: string | null;
  stance: TacticalStance;
  config: StadiumConfig;
  rules: AdminRules;
  humanRole: RoleType;
  humanTeam: TeamId;
  dt: number;
  elapsed: number;
}

export type OutfieldAIAction =
  | { kind: 'none' }
  | {
      kind: 'kick';
      dir: Vec3;
      power: number;
      lift: number;
      isSuperShot: boolean;
      isPass: boolean;
    }
  | { kind: 'slideTackle'; dir: Vec3 }
  | { kind: 'skillMove' }
  | { kind: 'dive' }
  | { kind: 'protest' };

export interface OutfieldAIDecision {
  moveDir: Vec3;
  sprint: boolean;
  action: OutfieldAIAction;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: x / len, y: 0, z: z / len };
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Arcade Outfield AI:
 * - Reacts dynamically to TacticalStance (balanced, all_out_attack, park_the_bus, high_press).
 * - Separates teammates cleanly so they never clump on the ball.
 * - Dribbles downfield, passes to open teammates (preferring human teammate!),
 *   takes exciting shots on goal (especially feeding fun saves to a human FP GK!),
 *   and performs slide tackles, skill spins, and comedy dives/protests in Chaos mode.
 */
export class OutfieldAI {
  private readonly decisionCooldowns = new Map<string, number>();

  reset(): void {
    this.decisionCooldowns.clear();
  }

  evaluate(ctx: OutfieldAIContext): OutfieldAIDecision {
    const { player, allPlayers, ballPos, possessorId, stance, config, rules, dt, elapsed } = ctx;
    if (player.team !== 'red' && player.team !== 'blue') {
      return { moveDir: { x: 0, y: 0, z: 0 }, sprint: false, action: { kind: 'none' } };
    }

    const team: TeamId = player.team;
    const attackDir = team === 'red' ? 1 : -1; // Red attacks +Z, Blue attacks -Z
    const targetGoalZ = attackDir * config.halfLength;
    const ownGoalZ = -attackDir * config.halfLength;

    const prevCd = this.decisionCooldowns.get(player.id) ?? 0;
    const actionCd = Math.max(0, prevCd - dt);
    this.decisionCooldowns.set(player.id, actionCd);

    const activeTeammates = allPlayers.filter(
      (p) =>
        p.id !== player.id &&
        p.team === team &&
        p.role === 'outfield' &&
        !p.isBenched &&
        !p.isSentOff
    );

    const activeOpponents = allPlayers.filter(
      (p) =>
        p.team !== team &&
        (p.team === 'red' || p.team === 'blue') &&
        p.role === 'outfield' &&
        !p.isBenched &&
        !p.isSentOff
    );

    const distToBall = distXZ(player.pos, ballPos);
    const hasBall = possessorId === player.id || (possessorId === null && distToBall < 1.3 && ballPos.y < 1.3);

    // Determine if this AI is the designated chaser for their team
    const isTeamInPossession =
      possessorId !== null &&
      allPlayers.some((p) => p.id === possessorId && p.team === team);

    const isClosestTeammateToBall = activeTeammates.every(
      (tm) => distXZ(player.pos, ballPos) <= distXZ(tm.pos, ballPos) + 0.35
    );

    // Check if opposing GK is human FP -> make shots slightly more frequent and varied!
    const opposingTeam: TeamId = team === 'red' ? 'blue' : 'red';
    const opposingGKIsHuman = ctx.humanRole === 'goalkeeper' && ctx.humanTeam === opposingTeam;

    // 1. BALL CARRIER LOGIC
    if (hasBall) {
      const toGoalX = 0 - player.pos.x;
      const toGoalZ = targetGoalZ - player.pos.z;
      const distToGoal = Math.hypot(toGoalX, toGoalZ);

      // Find nearest pressing opponent
      let nearestOpp: PlayerEntityState | null = null;
      let nearestOppDist = Infinity;
      for (const opp of activeOpponents) {
        const d = distXZ(player.pos, opp.pos);
        if (d < nearestOppDist) {
          nearestOppDist = d;
          nearestOpp = opp;
        }
      }

      // Shooting range!
      const shootRange = opposingGKIsHuman
        ? 24.5
        : stance === 'all_out_attack'
          ? 23.0
          : 19.5;

      const inOpponentHalf = player.pos.z * attackDir > 4;

      if (actionCd <= 0 && distToGoal < shootRange && inOpponentHalf) {
        // Shoot toward an exciting corner of the goal!
        const cornerSign =
          Math.sin(elapsed * 3.7 + player.number * 1.9) >= 0 ? 1 : -1;
        const aimX = cornerSign * (config.goalWidth * (0.22 + Math.random() * 0.2));
        const shotDir = normalizeXZ(aimX - player.pos.x, targetGoalZ - player.pos.z);
        const isSuperShot = Math.random() < (opposingGKIsHuman ? 0.28 : 0.16);
        const power = isSuperShot ? 31 + Math.random() * 4 : 22 + Math.random() * 7;
        const lift = isSuperShot ? 0.28 + Math.random() * 0.14 : 0.14 + Math.random() * 0.2;

        this.decisionCooldowns.set(player.id, 0.75);
        return {
          moveDir: shotDir,
          sprint: true,
          action: {
            kind: 'kick',
            dir: shotDir,
            power,
            lift,
            isSuperShot,
            isPass: false,
          },
        };
      }

      // Under pressure inside opponent box -> comedic dive chance in Chaos mode!
      const inOppBox =
        Math.abs(player.pos.x) < config.penaltyBoxWidth * 0.48 &&
        Math.abs(targetGoalZ - player.pos.z) < config.penaltyBoxDepth;

      if (
        actionCd <= 0 &&
        rules.enableDivingAndProtests &&
        inOppBox &&
        nearestOppDist < 2.6 &&
        Math.random() < 0.08
      ) {
        this.decisionCooldowns.set(player.id, 3.5);
        return {
          moveDir: { x: 0, y: 0, z: attackDir },
          sprint: false,
          action: { kind: 'dive' },
        };
      }

      // Under pressure -> pass to open teammate (strongly preferring human teammate!) or skill spin
      if (actionCd <= 0 && nearestOpp && nearestOppDist < 4.4) {
        const bestPassTarget = this.findBestPassTarget(
          player,
          activeTeammates,
          activeOpponents,
          attackDir
        );

        if (bestPassTarget) {
          const leadZ = bestPassTarget.pos.z + attackDir * 2.2;
          const passDir = normalizeXZ(
            bestPassTarget.pos.x - player.pos.x,
            leadZ - player.pos.z
          );
          const dist = distXZ(player.pos, bestPassTarget.pos);
          const power = clamp(12 + dist * 0.55, 14, 24);

          this.decisionCooldowns.set(player.id, 0.65);
          return {
            moveDir: passDir,
            sprint: false,
            action: {
              kind: 'kick',
              dir: passDir,
              power,
              lift: 0.06,
              isSuperShot: false,
              isPass: true,
            },
          };
        }

        // No clean pass -> juke spin!
        if (nearestOppDist < 2.9 && Math.random() < 0.35) {
          this.decisionCooldowns.set(player.id, 2.2);
          return {
            moveDir: normalizeXZ(
              player.pos.x - nearestOpp.pos.x + Math.sin(elapsed * 2) * 3,
              attackDir * 4
            ),
            sprint: true,
            action: { kind: 'skillMove' },
          };
        }
      }

      // Dribble smoothly downfield with light weave around defender
      let steerX = -player.pos.x * 0.14 + Math.sin(elapsed * 1.4 + player.number) * 2.5;
      if (nearestOpp && nearestOppDist < 6.0) {
        const awaySign = player.pos.x >= nearestOpp.pos.x ? 1 : -1;
        steerX += awaySign * 4.5;
      }
      const dribbleDir = normalizeXZ(steerX, targetGoalZ - player.pos.z);
      return {
        moveDir: dribbleDir,
        sprint: distToGoal > 12 && player.stamina > 30,
        action: { kind: 'none' },
      };
    }

    // 2. DEFENDING / CHASING BALL
    if (!isTeamInPossession && isClosestTeammateToBall) {
      const interceptDir = normalizeXZ(
        ballPos.x + ctx.ballVel.x * 0.18 - player.pos.x,
        ballPos.z + ctx.ballVel.z * 0.18 - player.pos.z
      );

      // Slide tackle attempt against opponent carrier
      const oppCarrier = activeOpponents.find((o) => o.id === possessorId);
      if (actionCd <= 0 && oppCarrier) {
        const dCarrier = distXZ(player.pos, oppCarrier.pos);
        const tackleAggression =
          stance === 'high_press' ? 0.045 : stance === 'park_the_bus' ? 0.015 : 0.025;
        if (dCarrier > 1.8 && dCarrier < 3.9 && Math.random() < tackleAggression) {
          this.decisionCooldowns.set(player.id, 2.4);
          return {
            moveDir: interceptDir,
            sprint: true,
            action: {
              kind: 'slideTackle',
              dir: normalizeXZ(oppCarrier.pos.x - player.pos.x, oppCarrier.pos.z - player.pos.z),
            },
          };
        }
      }

      return {
        moveDir: interceptDir,
        sprint: distToBall > 3.5 && player.stamina > 20,
        action: { kind: 'none' },
      };
    }

    // 3. OFF-BALL POSITIONING + ANTI-CLUMPING SEPARATION
    const targetPos = this.computeSupportTarget(
      player,
      ballPos,
      stance,
      isTeamInPossession,
      attackDir,
      ownGoalZ,
      targetGoalZ,
      config,
      elapsed
    );

    // Apply soft repulsion from nearby teammates so AI never clumps!
    let sepX = 0;
    let sepZ = 0;
    for (const tm of activeTeammates) {
      const dx = player.pos.x - tm.pos.x;
      const dz = player.pos.z - tm.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.01 && d < 6.0) {
        const push = ((6.0 - d) / 6.0) * 5.5;
        sepX += (dx / d) * push;
        sepZ += (dz / d) * push;
      }
    }

    const goalX = clamp(targetPos.x + sepX, -config.halfWidth + 2.5, config.halfWidth - 2.5);
    const goalZ = clamp(targetPos.z + sepZ, -config.halfLength + 3.5, config.halfLength - 3.5);
    const toTargetDist = Math.hypot(goalX - player.pos.x, goalZ - player.pos.z);

    if (toTargetDist < 1.1) {
      // Occasional idle comedy protest when far from ball in chaos mode
      if (
        actionCd <= 0 &&
        rules.enableDivingAndProtests &&
        Math.random() < 0.0025
      ) {
        this.decisionCooldowns.set(player.id, 7.0);
        return {
          moveDir: { x: 0, y: 0, z: 0 },
          sprint: false,
          action: { kind: 'protest' },
        };
      }
      return {
        moveDir: { x: 0, y: 0, z: 0 },
        sprint: false,
        action: { kind: 'none' },
      };
    }

    return {
      moveDir: normalizeXZ(goalX - player.pos.x, goalZ - player.pos.z),
      sprint: toTargetDist > 10 && player.stamina > 35,
      action: { kind: 'none' },
    };
  }

  private findBestPassTarget(
    carrier: PlayerEntityState,
    teammates: PlayerEntityState[],
    opponents: PlayerEntityState[],
    attackDir: number
  ): PlayerEntityState | null {
    let best: PlayerEntityState | null = null;
    let bestScore = -Infinity;

    for (const tm of teammates) {
      const dist = distXZ(carrier.pos, tm.pos);
      if (dist < 4.5 || dist > 28) continue;

      const forwardGain = (tm.pos.z - carrier.pos.z) * attackDir;
      let minOppDist = Infinity;
      for (const opp of opponents) {
        const d = distXZ(tm.pos, opp.pos);
        if (d < minOppDist) minOppDist = d;
      }

      // Strongly favor open human teammate so playing with AI feels fun!
      const humanBonus = tm.isHumanControlled ? 9.5 : 0;
      const score = forwardGain * 0.7 + Math.min(minOppDist, 10) * 1.1 + humanBonus;

      if (score > bestScore && score > 3.5) {
        bestScore = score;
        best = tm;
      }
    }

    return best;
  }

  private computeSupportTarget(
    player: PlayerEntityState,
    ballPos: Vec3,
    stance: TacticalStance,
    teamHasBall: boolean,
    attackDir: number,
    ownGoalZ: number,
    targetGoalZ: number,
    config: StadiumConfig,
    elapsed: number
  ): Vec3 {
    const isDefender = player.positionRole === 'defender';
    const laneSign = player.number % 2 === 0 ? -1 : 1;

    let stanceShift = 0;
    if (stance === 'all_out_attack') stanceShift = 10.5 * attackDir;
    else if (stance === 'park_the_bus') stanceShift = -10.5 * attackDir;
    else if (stance === 'high_press') stanceShift = 6.5 * attackDir;

    if (teamHasBall) {
      // Make smart attacking runs into wide channels
      const targetX = isDefender
        ? clamp(ballPos.x * 0.4, -9, 9)
        : clamp(laneSign * 11.5 + Math.sin(elapsed * 0.8 + player.number) * 2.5, -17, 17);
      const baseZ = isDefender
        ? ballPos.z - attackDir * 9
        : ballPos.z + attackDir * 11;
      const targetZ = clamp(
        baseZ + stanceShift,
        Math.min(ownGoalZ, targetGoalZ) + 7,
        Math.max(ownGoalZ, targetGoalZ) - 6
      );
      return { x: targetX, y: 0, z: targetZ };
    }

    // Defending shape: hold defensive line between ball and own goal
    const anchorZ = isDefender
      ? ownGoalZ + attackDir * 12 + (ballPos.z - ownGoalZ) * 0.35
      : ballPos.z - attackDir * 5;
    const targetX = clamp(
      ballPos.x * 0.55 + laneSign * (isDefender ? 4.5 : 8.5),
      -config.halfWidth + 3.5,
      config.halfWidth - 3.5
    );
    const targetZ = clamp(
      anchorZ + stanceShift,
      -config.halfLength + 6,
      config.halfLength - 6
    );
    return { x: targetX, y: 0, z: targetZ };
  }
}
