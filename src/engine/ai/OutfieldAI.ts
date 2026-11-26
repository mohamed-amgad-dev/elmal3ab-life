import type {
  AIDifficulty,
  AdminRules,
  CallForPassState,
  PlayerEntityState,
  RoleType,
  TacticalStance,
  TeamId,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';
import {
  PASS_BEFORE_SHOOT_DIST_M,
  PassHysteresisTracker,
  TAP_IN_DISTANCE_M,
  computePassTrajectory,
  evaluateCallForPassTarget,
  evaluateTeamPass,
  type PassDecision,
} from './TeamPassingLogic';

export interface OutfieldSpeedProfile {
  walk: number;
  sprint: number;
  staminaDrain: number;
  staminaRegen: number;
}

const OUTFIELD_SPEED_PROFILES: Record<AIDifficulty, OutfieldSpeedProfile> = {
  easy: { walk: 6.2, sprint: 8.6, staminaDrain: 17, staminaRegen: 9 },
  medium: { walk: 7.4, sprint: 10.2, staminaDrain: 14, staminaRegen: 11 },
  hard: { walk: 8.1, sprint: 11.4, staminaDrain: 12, staminaRegen: 13 },
};

export function getOutfieldSpeedProfile(difficulty: AIDifficulty): OutfieldSpeedProfile {
  return { ...OUTFIELD_SPEED_PROFILES[difficulty] };
}

interface OutfieldDifficultyTuning {
  decisionCadence: number;
  shotAimJitter: number;
  passAimJitter: number;
  tackleAggressionMult: number;
  pressStandOff: number;
  ballAnticipationSec: number;
  curlChance: number;
  curlMax: number;
  proactivePassChance: number;
  skillMoveChance: number;
  gkReadWeight: number;
}

const DIFFICULTY_TUNING: Record<AIDifficulty, OutfieldDifficultyTuning> = {
  easy: {
    decisionCadence: 0.55,
    shotAimJitter: 0.30,
    passAimJitter: 0.14,
    tackleAggressionMult: 0.52,
    pressStandOff: 2.2,
    ballAnticipationSec: 0.06,
    curlChance: 0.08,
    curlMax: 1.8,
    proactivePassChance: 0.32,
    skillMoveChance: 0.16,
    gkReadWeight: 0.15,
  },
  medium: {
    decisionCadence: 0.28,
    shotAimJitter: 0.13,
    passAimJitter: 0.05,
    tackleAggressionMult: 1.0,
    pressStandOff: 0.65,
    ballAnticipationSec: 0.18,
    curlChance: 0.36,
    curlMax: 3.8,
    proactivePassChance: 0.52,
    skillMoveChance: 0.30,
    gkReadWeight: 0.62,
  },
  hard: {
    decisionCadence: 0.12,
    shotAimJitter: 0.045,
    passAimJitter: 0.018,
    tackleAggressionMult: 1.35,
    pressStandOff: 0.0,
    ballAnticipationSec: 0.30,
    curlChance: 0.68,
    curlMax: 5.4,
    proactivePassChance: 0.72,
    skillMoveChance: 0.42,
    gkReadWeight: 0.92,
  },
};

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
  difficulty?: AIDifficulty;
  callForPass?: CallForPassState | null;
  lastPasserId?: string | null;
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
      curlSpinY?: number;
      passTargetId?: string;
      isLobPass?: boolean;
      fulfilledCallForPass?: boolean;
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

interface TeamPressState {
  activePresserId: string | null;
  presserHoldTimer: number;
  lastTickElapsed: number;
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
 * Perpendicular distance from point P to segment AB in XZ plane,
 * plus normalized projection parameter t in [0, 1].
 */
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

function rotateXZ(dir: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return normalizeXZ(dir.x * c - dir.z * s, dir.x * s + dir.z * c);
}

/**
 * Human-Plausible Outfield Football AI:
 * - Strict per-team single-presser assignment with 0.9s hysteresis (zero clumping or ping-pong).
 * - Respects human teammate pressing space (< 5.5m from ball) by dropping into smart cover.
 * - Distinct Defender (cover shadow, goal-side marking, recycling outlet) and
 *   Striker (diagonal wide/back-post runs, >= 7m separation from carrier) intelligence.
 * - Evaluates shooting cones for blockers (cuts laterally or lays off instead of shooting into shins),
 *   reads GK position for open corners with curlSpinY, and proactively feeds open teammates.
 * - Scales cleanly across easy / medium / hard difficulty curves.
 */
export class OutfieldAI {
  private readonly decisionCooldowns = new Map<string, number>();
  private readonly beatTimers = new Map<string, number>();
  private readonly passHysteresis = new PassHysteresisTracker();
  private readonly lastTeamPossessor: Record<TeamId, string | null> = {
    red: null,
    blue: null,
  };
  private readonly teamPressStates: Record<TeamId, TeamPressState> = {
    red: { activePresserId: null, presserHoldTimer: 0, lastTickElapsed: -1 },
    blue: { activePresserId: null, presserHoldTimer: 0, lastTickElapsed: -1 },
  };

  reset(): void {
    this.decisionCooldowns.clear();
    this.beatTimers.clear();
    this.passHysteresis.reset();
    this.lastTeamPossessor.red = null;
    this.lastTeamPossessor.blue = null;
    this.teamPressStates.red = { activePresserId: null, presserHoldTimer: 0, lastTickElapsed: -1 };
    this.teamPressStates.blue = { activePresserId: null, presserHoldTimer: 0, lastTickElapsed: -1 };
  }

  /** Optional hook for engine wiring to record human-to-AI or AI-to-AI pass receipts. */
  recordPassReceived(receiverId: string, passerId: string, elapsed: number): void {
    this.passHysteresis.recordReceipt(receiverId, passerId, elapsed);
  }

  evaluate(ctx: OutfieldAIContext): OutfieldAIDecision {
    const { player, allPlayers, ballPos, ballVel, possessorId, stance, config, rules, dt, elapsed } =
      ctx;
    if (player.team !== 'red' && player.team !== 'blue') {
      return { moveDir: { x: 0, y: 0, z: 0 }, sprint: false, action: { kind: 'none' } };
    }

    const difficulty: AIDifficulty = ctx.difficulty ?? rules.aiDifficulty ?? 'medium';
    const tuning = DIFFICULTY_TUNING[difficulty];
    const team: TeamId = player.team;
    const opposingTeam: TeamId = team === 'red' ? 'blue' : 'red';
    const attackDir = team === 'red' ? 1 : -1; // Red attacks +Z, Blue attacks -Z
    const targetGoalZ = attackDir * config.halfLength;
    const ownGoalZ = -attackDir * config.halfLength;

    // Update per-player action cooldown & tactical decision cadence beat
    const actionCd = Math.max(0, (this.decisionCooldowns.get(player.id) ?? 0) - dt);
    this.decisionCooldowns.set(player.id, actionCd);

    const prevBeat = (this.beatTimers.get(player.id) ?? 0) - dt;
    const beatReady = prevBeat <= 0;
    if (beatReady) {
      this.beatTimers.set(player.id, tuning.decisionCadence * (0.85 + Math.random() * 0.3));
    } else {
      this.beatTimers.set(player.id, prevBeat);
    }

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
        p.team === opposingTeam &&
        p.role === 'outfield' &&
        !p.isBenched &&
        !p.isSentOff
    );

    const opposingGK = allPlayers.find(
      (p) => p.team === opposingTeam && p.role === 'goalkeeper' && !p.isBenched && !p.isSentOff
    );

    const distToBall = distXZ(player.pos, ballPos);
    const hasBall =
      possessorId === player.id ||
      (possessorId === null && distToBall < 1.3 && ballPos.y < 1.3);

    const possessor = possessorId ? allPlayers.find((p) => p.id === possessorId) ?? null : null;
    const isTeamInPossession = possessor !== null && possessor.team === team;
    const opposingGKIsHuman = ctx.humanRole === 'goalkeeper' && ctx.humanTeam === opposingTeam;

    // Automatically track same-team pass receipts for anti-ping-pong hysteresis
    if (isTeamInPossession && possessor) {
      const prevTeamPossessor = this.lastTeamPossessor[team];
      if (prevTeamPossessor && prevTeamPossessor !== possessor.id) {
        this.passHysteresis.recordReceipt(possessor.id, prevTeamPossessor, elapsed);
      }
      this.lastTeamPossessor[team] = possessor.id;
    } else if (possessor !== null && possessor.team !== team) {
      this.lastTeamPossessor[team] = null;
    }

    // Update strict per-team single-presser assignment with 0.9s hysteresis
    const activePresserId = this.resolveTeamPresser(
      team,
      player,
      activeTeammates,
      ballPos,
      ballVel,
      isTeamInPossession,
      tuning.ballAnticipationSec,
      dt,
      elapsed
    );
    const isDesignatedPresser = !isTeamInPossession && activePresserId === player.id;

    // 1. BALL CARRIER LOGIC
    if (hasBall) {
      return this.evaluateCarrier(
        player,
        activeTeammates,
        activeOpponents,
        opposingGK,
        attackDir,
        targetGoalZ,
        stance,
        config,
        rules,
        difficulty,
        opposingGKIsHuman,
        tuning,
        actionCd,
        beatReady,
        elapsed,
        ctx.callForPass ?? null,
        ctx.lastPasserId ?? null
      );
    }

    // 2. DESIGNATED PRESSER LOGIC (strictly at most 1 AI per team)
    if (isDesignatedPresser) {
      const anticipatedBall: Vec3 = {
        x: ballPos.x + ballVel.x * tuning.ballAnticipationSec,
        y: 0,
        z: ballPos.z + ballVel.z * tuning.ballAnticipationSec,
      };

      const oppCarrier = activeOpponents.find((o) => o.id === possessorId) ?? null;

      // Easy mode soft press: leave comfortable space for human dribbles when close
      if (oppCarrier && tuning.pressStandOff > 0 && distToBall < tuning.pressStandOff + 1.2) {
        const goalSideZ = oppCarrier.pos.z - attackDir * (tuning.pressStandOff * 0.85);
        const jockeyX = clamp(
          oppCarrier.pos.x * 0.92,
          -config.halfWidth + 2.0,
          config.halfWidth - 2.0
        );
        const jockeyDir = normalizeXZ(jockeyX - player.pos.x, goalSideZ - player.pos.z);
        return {
          moveDir: jockeyDir,
          sprint: false,
          action: { kind: 'none' },
        };
      }

      const interceptDir = normalizeXZ(
        anticipatedBall.x - player.pos.x,
        anticipatedBall.z - player.pos.z
      );

      // Slide tackle attempt against opponent carrier (gated by decision beat & difficulty)
      if (actionCd <= 0 && beatReady && oppCarrier) {
        const dCarrier = distXZ(player.pos, oppCarrier.pos);
        const baseAggression =
          stance === 'high_press' ? 0.22 : stance === 'park_the_bus' ? 0.08 : 0.14;
        const tackleChance = baseAggression * tuning.tackleAggressionMult;
        if (dCarrier > 1.7 && dCarrier < 3.8 && Math.random() < tackleChance) {
          this.decisionCooldowns.set(player.id, difficulty === 'easy' ? 3.2 : 2.3);
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

      const shouldSprint =
        (distToBall > 3.2 && player.stamina > 22) ||
        (distToBall > 1.8 && Math.abs(ballPos.z - ownGoalZ) < 16 && player.stamina > 12);

      return {
        moveDir: interceptDir,
        sprint: shouldSprint,
        action: { kind: 'none' },
      };
    }

    // 3. OFF-BALL POSITIONING (Role-driven football shape + anti-clumping separation)
    const targetPos = this.computeSupportTarget(
      player,
      ballPos,
      possessor,
      activeOpponents,
      stance,
      isTeamInPossession,
      attackDir,
      ownGoalZ,
      targetGoalZ,
      config,
      elapsed
    );

    // Apply strong anti-clumping separation from teammates (and >= 7m from ball carrier for strikers)
    let sepX = 0;
    let sepZ = 0;
    for (const tm of activeTeammates) {
      const dx = player.pos.x - tm.pos.x;
      const dz = player.pos.z - tm.pos.z;
      const d = Math.hypot(dx, dz);
      const isCarrier = possessorId === tm.id;
      const minSep = isCarrier && player.positionRole !== 'defender' ? 7.2 : 6.0;
      if (d > 0.01 && d < minSep) {
        const push = ((minSep - d) / minSep) * (isCarrier ? 7.5 : 5.5);
        sepX += (dx / d) * push;
        sepZ += (dz / d) * push;
      }
    }

    const goalX = clamp(targetPos.x + sepX, -config.halfWidth + 2.5, config.halfWidth - 2.5);
    const goalZ = clamp(targetPos.z + sepZ, -config.halfLength + 3.5, config.halfLength - 3.5);
    const toTargetDist = Math.hypot(goalX - player.pos.x, goalZ - player.pos.z);

    if (toTargetDist < 1.15) {
      if (actionCd <= 0 && beatReady && rules.enableDivingAndProtests && Math.random() < 0.012) {
        this.decisionCooldowns.set(player.id, 7.5);
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
      sprint: toTargetDist > 9.5 && player.stamina > 35,
      action: { kind: 'none' },
    };
  }

  /**
   * Maintains per-team strict single-presser with ~0.9s hysteresis.
   * Yields pressing duty immediately if a human teammate is already pressing within 5.5m.
   */
  private resolveTeamPresser(
    team: TeamId,
    self: PlayerEntityState,
    otherTeammates: PlayerEntityState[],
    ballPos: Vec3,
    ballVel: Vec3,
    isTeamInPossession: boolean,
    anticipationSec: number,
    dt: number,
    elapsed: number
  ): string | null {
    const state = this.teamPressStates[team];

    // Decrement hysteresis timer once per simulation frame per team
    if (state.lastTickElapsed !== elapsed) {
      state.lastTickElapsed = elapsed;
      state.presserHoldTimer = Math.max(0, state.presserHoldTimer - dt);
    }

    if (isTeamInPossession) {
      state.activePresserId = null;
      state.presserHoldTimer = 0;
      return null;
    }

    const teamOutfielders = [self, ...otherTeammates];

    // If a human teammate is already pressing close to the ball (< 5.5m), AI drops into cover!
    const humanPressingClose = teamOutfielders.some(
      (p) => p.isHumanControlled && distXZ(p.pos, ballPos) < 5.5
    );
    if (humanPressingClose) {
      state.activePresserId = null;
      state.presserHoldTimer = 0;
      return null;
    }

    const aiCandidates = teamOutfielders.filter((p) => !p.isHumanControlled);
    if (aiCandidates.length === 0) {
      state.activePresserId = null;
      return null;
    }

    const predBall: Vec3 = {
      x: ballPos.x + ballVel.x * anticipationSec,
      y: 0,
      z: ballPos.z + ballVel.z * anticipationSec,
    };

    let closestAI = aiCandidates[0];
    let closestDist = distXZ(closestAI.pos, predBall);
    for (let i = 1; i < aiCandidates.length; i++) {
      const d = distXZ(aiCandidates[i].pos, predBall);
      if (d < closestDist) {
        closestDist = d;
        closestAI = aiCandidates[i];
      }
    }

    const currentPresser = state.activePresserId
      ? aiCandidates.find((p) => p.id === state.activePresserId) ?? null
      : null;

    if (currentPresser) {
      const currentDist = distXZ(currentPresser.pos, predBall);
      // Keep current presser during 0.9s hysteresis unless another AI is dramatically closer (> 4.0m)
      if (state.presserHoldTimer > 0 && currentDist <= closestDist + 4.0) {
        return currentPresser.id;
      }
      // Small switch margin even after timer expires to prevent jitter at equal distance
      if (currentDist <= closestDist + 0.85) {
        return currentPresser.id;
      }
    }

    state.activePresserId = closestAI.id;
    state.presserHoldTimer = 0.9;
    return closestAI.id;
  }

  private evaluateCarrier(
    player: PlayerEntityState,
    activeTeammates: PlayerEntityState[],
    activeOpponents: PlayerEntityState[],
    opposingGK: PlayerEntityState | undefined,
    attackDir: number,
    targetGoalZ: number,
    stance: TacticalStance,
    config: StadiumConfig,
    rules: AdminRules,
    difficulty: AIDifficulty,
    opposingGKIsHuman: boolean,
    tuning: OutfieldDifficultyTuning,
    actionCd: number,
    beatReady: boolean,
    elapsed: number,
    callForPass: CallForPassState | null,
    explicitLastPasserId: string | null
  ): OutfieldAIDecision {
    const toGoalX = 0 - player.pos.x;
    const toGoalZ = targetGoalZ - player.pos.z;
    const distToGoal = Math.hypot(toGoalX, toGoalZ);

    let nearestOpp: PlayerEntityState | null = null;
    let nearestOppDist = Infinity;
    for (const opp of activeOpponents) {
      const d = distXZ(player.pos, opp.pos);
      if (d < nearestOppDist) {
        nearestOppDist = d;
        nearestOpp = opp;
      }
    }

    const shootRange = opposingGKIsHuman
      ? 24.0
      : stance === 'all_out_attack'
        ? 22.5
        : 19.5;
    const inOpponentHalf = player.pos.z * attackDir > 3.5;

    // Precompute shot line & blocker if within shooting range
    const canConsiderShot = distToGoal < shootRange && inOpponentHalf;
    const openCornerSign = canConsiderShot
      ? this.chooseShotCorner(opposingGK, player, config, tuning, elapsed)
      : 1;
    const aimX = openCornerSign * (config.goalWidth * (0.26 + Math.random() * 0.16));
    const shotBlocker = canConsiderShot
      ? this.findShotBlocker(player.pos, aimX, targetGoalZ, activeOpponents)
      : null;

    // Resolve anti-ping-pong hysteresis record
    const recentPass = this.passHysteresis.getRecentPasser(player.id, elapsed);
    const lastPasserId = recentPass?.passerId ?? explicitLastPasserId;
    const timeSinceReceivedSec = recentPass?.ageSec;

    // 1. POINT-BLANK OPEN TAP-IN (< 7.5m & unblocked) — take the sure goal!
    if (actionCd <= 0 && beatReady && canConsiderShot && distToGoal < TAP_IN_DISTANCE_M && !shotBlocker) {
      return this.createShotDecision(
        player,
        aimX,
        targetGoalZ,
        openCornerSign,
        attackDir,
        opposingGKIsHuman,
        tuning
      );
    }

    // 2. ACTIVE CALL-FOR-PASS PRIORITY (bypasses random cadence beat for snappy response!)
    if (actionCd <= 0 && callForPass?.active) {
      const callDecision = evaluateCallForPassTarget({
        carrier: player,
        teammates: activeTeammates,
        opponents: activeOpponents,
        attackDir,
        targetGoalZ,
        difficulty,
        elapsed,
        callForPass,
        carrierNearestOppDist: nearestOppDist,
        requireCleanLane: false,
        lastPasserId,
        timeSinceReceivedSec,
      });
      if (callDecision) {
        return this.createPassDecision(player, callDecision, attackDir, tuning, elapsed);
      }
    }

    // 3. ORGANIC TEAM PLAY & HUMAN-OPEN PRIORITY (evaluated BEFORE shooting when > 11.5m or shot contested)
    const evaluatePassBeforeShot =
      distToGoal > PASS_BEFORE_SHOOT_DIST_M ||
      Boolean(shotBlocker) ||
      nearestOppDist < 4.5;

    if (actionCd <= 0 && beatReady && evaluatePassBeforeShot) {
      const teamPass = evaluateTeamPass({
        carrier: player,
        teammates: activeTeammates,
        opponents: activeOpponents,
        attackDir,
        targetGoalZ,
        difficulty,
        elapsed,
        callForPass,
        carrierNearestOppDist: nearestOppDist,
        requireCleanLane: nearestOppDist >= 4.5,
        isLayoff: Boolean(shotBlocker),
        lastPasserId,
        timeSinceReceivedSec,
      });

      if (teamPass) {
        const highPriorityPass =
          teamPass.reason === 'human_open' ||
          teamPass.reason === 'pressure_release' ||
          teamPass.reason === 'layoff';
        const strongOrganicThreshold =
          difficulty === 'easy' ? 11.2 : difficulty === 'medium' ? 8.8 : 7.4;

        if (
          highPriorityPass ||
          teamPass.score >= strongOrganicThreshold ||
          Math.random() < tuning.proactivePassChance
        ) {
          return this.createPassDecision(player, teamPass, attackDir, tuning, elapsed);
        }
      }
    }

    // 4. SHOOTING EVALUATION (checks shooting cone for blockers & GK position!)
    if (actionCd <= 0 && beatReady && canConsiderShot) {
      if (!shotBlocker || distToGoal < TAP_IN_DISTANCE_M) {
        return this.createShotDecision(
          player,
          aimX,
          targetGoalZ,
          openCornerSign,
          attackDir,
          opposingGKIsHuman,
          tuning
        );
      }

      // Shot lane is blocked and no layoff target was open — cut laterally around blocker
      const cutSign = player.pos.x >= shotBlocker.pos.x ? 1 : -1;
      const cutDir = normalizeXZ(cutSign * 5.2 - player.pos.x * 0.1, attackDir * 3.0);
      return {
        moveDir: cutDir,
        sprint: player.stamina > 25,
        action: { kind: 'none' },
      };
    }

    // 5. CHAOS DIVE INSIDE OPPONENT BOX
    const inOppBox =
      Math.abs(player.pos.x) < config.penaltyBoxWidth * 0.48 &&
      Math.abs(targetGoalZ - player.pos.z) < config.penaltyBoxDepth;

    if (
      actionCd <= 0 &&
      beatReady &&
      rules.enableDivingAndProtests &&
      inOppBox &&
      nearestOppDist < 2.6 &&
      Math.random() < 0.08
    ) {
      this.decisionCooldowns.set(player.id, 3.6);
      return {
        moveDir: { x: 0, y: 0, z: attackDir },
        sprint: false,
        action: { kind: 'dive' },
      };
    }

    // 6. UNDER TIGHT PRESSURE -> SKILL MOVE ESCAPE (when no pass outlet was open)
    if (
      actionCd <= 0 &&
      beatReady &&
      nearestOpp &&
      nearestOppDist < 3.0 &&
      Math.random() < tuning.skillMoveChance
    ) {
      this.decisionCooldowns.set(player.id, 2.3);
      return {
        moveDir: normalizeXZ(
          player.pos.x - nearestOpp.pos.x + Math.sin(elapsed * 2) * 3,
          attackDir * 4
        ),
        sprint: true,
        action: { kind: 'skillMove' },
      };
    }

    // 7. INTELLIGENT DRIBBLE DOWNFIELD (weave around nearest defender toward open channel)
    let steerX = -player.pos.x * 0.16 + Math.sin(elapsed * 1.25 + player.number) * 1.8;
    if (nearestOpp && nearestOppDist < 6.5) {
      const awaySign = player.pos.x >= nearestOpp.pos.x ? 1 : -1;
      steerX += awaySign * 4.8;
    }
    const dribbleDir = normalizeXZ(steerX, targetGoalZ - player.pos.z);
    return {
      moveDir: dribbleDir,
      sprint: distToGoal > 11 && player.stamina > 28,
      action: { kind: 'none' },
    };
  }

  private createShotDecision(
    player: PlayerEntityState,
    aimX: number,
    targetGoalZ: number,
    openCornerSign: number,
    attackDir: number,
    opposingGKIsHuman: boolean,
    tuning: OutfieldDifficultyTuning
  ): OutfieldAIDecision {
    let shotDir = normalizeXZ(aimX - player.pos.x, targetGoalZ - player.pos.z);
    const jitterRad = (Math.random() - 0.5) * 2 * tuning.shotAimJitter;
    shotDir = rotateXZ(shotDir, jitterRad);

    const isSuperShot = Math.random() < (opposingGKIsHuman ? 0.26 : 0.15);
    const power = isSuperShot ? 30 + Math.random() * 4 : 21.5 + Math.random() * 6.5;
    const lift = isSuperShot ? 0.26 + Math.random() * 0.14 : 0.12 + Math.random() * 0.2;

    let curlSpinY: number | undefined;
    if (Math.random() < tuning.curlChance) {
      const curlMag = tuning.curlMax * (0.45 + Math.random() * 0.55);
      curlSpinY = openCornerSign * attackDir * curlMag;
    }

    this.decisionCooldowns.set(player.id, 0.78);
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
        curlSpinY,
      },
    };
  }

  private chooseShotCorner(
    opposingGK: PlayerEntityState | undefined,
    shooter: PlayerEntityState,
    config: StadiumConfig,
    tuning: OutfieldDifficultyTuning,
    elapsed: number
  ): number {
    if (opposingGK && Math.random() < tuning.gkReadWeight) {
      // Aim for the side of the goal further from the goalkeeper
      if (Math.abs(opposingGK.pos.x) > 0.35) {
        return opposingGK.pos.x > 0 ? -1 : 1;
      }
      // If GK is centered, aim for the far post relative to shooter's angle
      if (Math.abs(shooter.pos.x) > 1.5) {
        return shooter.pos.x > 0 ? -1 : 1;
      }
    }
    const baseSign = Math.sin(elapsed * 3.1 + shooter.number * 1.9) >= 0 ? 1 : -1;
    return Math.abs(shooter.pos.x) > config.goalWidth * 0.5 ? -Math.sign(shooter.pos.x) : baseSign;
  }

  private findShotBlocker(
    shooterPos: Vec3,
    aimX: number,
    targetGoalZ: number,
    opponents: PlayerEntityState[]
  ): PlayerEntityState | null {
    let closestBlocker: PlayerEntityState | null = null;
    let closestT = Infinity;

    for (const opp of opponents) {
      const seg = pointToSegmentXZ(
        opp.pos.x,
        opp.pos.z,
        shooterPos.x,
        shooterPos.z,
        aimX,
        targetGoalZ
      );
      if (seg.t > 0.06 && seg.t < 0.85 && seg.dist < 1.55) {
        if (seg.t < closestT) {
          closestT = seg.t;
          closestBlocker = opp;
        }
      }
    }
    return closestBlocker;
  }

  private createPassDecision(
    carrier: PlayerEntityState,
    pass: PassDecision,
    attackDir: number,
    tuning: OutfieldDifficultyTuning,
    elapsed: number
  ): OutfieldAIDecision {
    const jitter = pass.reason === 'call_for_pass' ? tuning.passAimJitter * 0.5 : tuning.passAimJitter;
    const traj = computePassTrajectory(
      carrier.pos,
      pass.target.pos,
      attackDir,
      pass.loft,
      jitter
    );

    this.decisionCooldowns.set(carrier.id, 0.72);
    this.passHysteresis.recordReceipt(pass.target.id, carrier.id, elapsed);

    return {
      moveDir: traj.dir,
      sprint: false,
      action: {
        kind: 'kick',
        dir: traj.dir,
        power: traj.power,
        lift: traj.lift,
        isSuperShot: false,
        isPass: true,
        passTargetId: pass.target.id,
        isLobPass: pass.loft,
        fulfilledCallForPass: pass.reason === 'call_for_pass',
      },
    };
  }

  private computeSupportTarget(
    player: PlayerEntityState,
    ballPos: Vec3,
    possessor: PlayerEntityState | null,
    opponents: PlayerEntityState[],
    stance: TacticalStance,
    teamHasBall: boolean,
    attackDir: number,
    ownGoalZ: number,
    targetGoalZ: number,
    config: StadiumConfig,
    elapsed: number
  ): Vec3 {
    const isDefender = player.positionRole === 'defender';
    const carrierPos = possessor ? possessor.pos : ballPos;

    let stanceShift = 0;
    if (stance === 'all_out_attack') stanceShift = 9.5 * attackDir;
    else if (stance === 'park_the_bus') stanceShift = -9.5 * attackDir;
    else if (stance === 'high_press') stanceShift = 6.0 * attackDir;

    if (teamHasBall) {
      if (isDefender) {
        // Defender offers a smart recycling outlet behind the ball on the opposite side
        const supportSign = carrierPos.x >= 0 ? -1 : 1;
        const targetX = clamp(carrierPos.x * 0.35 + supportSign * 5.5, -13, 13);
        const baseZ = carrierPos.z - attackDir * 8.5 + stanceShift * 0.65;
        const targetZ = clamp(
          baseZ,
          Math.min(ownGoalZ, targetGoalZ) + 7,
          Math.max(ownGoalZ, targetGoalZ) - 9
        );
        return { x: targetX, y: 0, z: targetZ };
      }

      // Striker makes diagonal runs into open wide channels or back-post space (>= 7m from carrier)
      const oppositeSide = carrierPos.x >= 0 ? -1 : 1;
      const nearBox = Math.abs(targetGoalZ - carrierPos.z) < 18;
      const channelX = nearBox
        ? oppositeSide * (config.goalWidth * 0.68)
        : oppositeSide * (10.5 + Math.sin(elapsed * 0.75 + player.number) * 2.5);
      const targetX = clamp(channelX, -config.halfWidth + 3.5, config.halfWidth - 3.5);
      const leadDepth = nearBox ? 6.5 : 10.5;
      const baseZ = carrierPos.z + attackDir * leadDepth + stanceShift * 0.7;
      const targetZ = clamp(
        baseZ,
        Math.min(ownGoalZ, targetGoalZ) + 8,
        Math.max(ownGoalZ, targetGoalZ) - 4.8
      );
      return { x: targetX, y: 0, z: targetZ };
    }

    // DEFENDING OFF-BALL SHAPE
    if (isDefender) {
      // Hold cover shadow between ball and own goal; mark free opposing striker if dangerous!
      const dangerousStriker = opponents.find(
        (opp) =>
          opp.id !== possessor?.id &&
          (opp.pos.z - ownGoalZ) * attackDir < 24 &&
          distXZ(opp.pos, ballPos) > 4.0
      );

      // Cover shadow point along the ball -> ownGoal line
      const coverRatio =
        stance === 'park_the_bus' ? 0.28 : stance === 'high_press' ? 0.56 : 0.42;
      let coverX = ballPos.x * 0.58;
      let coverZ = ownGoalZ + (ballPos.z - ownGoalZ) * coverRatio + stanceShift * 0.55;

      if (dangerousStriker) {
        // Blend goal-side marking of the free opposing striker with central cover
        const markX = dangerousStriker.pos.x * 0.85;
        const markZ = dangerousStriker.pos.z - attackDir * 2.4;
        coverX = coverX * 0.4 + markX * 0.6;
        coverZ = coverZ * 0.4 + markZ * 0.6;
      }

      return {
        x: clamp(coverX, -config.halfWidth + 3.5, config.halfWidth - 3.5),
        y: 0,
        z: clamp(coverZ, -config.halfLength + 5.5, config.halfLength - 5.5),
      };
    }

    // Off-ball Striker defending: hold midfield passing-lane screen / counter-attack outlet
    const laneSign = ballPos.x >= 0 ? -1 : 1;
    const screenX = clamp(
      ballPos.x * 0.45 + laneSign * 6.5,
      -config.halfWidth + 3.5,
      config.halfWidth - 3.5
    );
    const screenZ = clamp(
      ballPos.z - attackDir * 4.5 + stanceShift * 0.6,
      -config.halfLength + 7,
      config.halfLength - 7
    );
    return { x: screenX, y: 0, z: screenZ };
  }
}
