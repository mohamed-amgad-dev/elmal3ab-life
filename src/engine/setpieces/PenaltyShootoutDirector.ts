import {
  PENALTY_SHOOTOUT_INITIAL_ROUNDS,
  createInitialPenaltyShootoutState,
  type ComedyEventTone,
  type MatchPhase,
  type PenaltyKickOutcome,
  type PenaltyShootoutState,
  type PenaltyShootoutTurnRole,
  type PlayerEntityState,
  type TeamId,
  type Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export const SHOOTOUT_HUMAN_KICK_TIMEOUT_SEC = 7.5;
export const SHOOTOUT_AI_BUILDUP_SEC = 1.4;
export const SHOOTOUT_AI_TELEGRAPH_WINDOW_SEC = 0.55;
export const SHOOTOUT_FLIGHT_MAX_SEC = 2.2;
export const SHOOTOUT_RESULT_DURATION_SEC = 1.6;
export const SHOOTOUT_INTRO_DURATION_SEC = 1.1;
export const SHOOTOUT_TURN_SETUP_DURATION_SEC = 0.65;
export const SHOOTOUT_SUDDEN_DEATH_BANNER_SEC = 1.6;

export type ShootoutDiveDir = 'left' | 'center' | 'right';

export interface ShootoutPlayerProxy {
  id: string;
  name: string;
  team: TeamId | 'ref' | 'neutral';
  role: PlayerEntityState['role'];
  isHumanControlled: boolean;
  isRemoteHuman?: boolean;
  isBenched: boolean;
  isSentOff: boolean;
  pos: Vec3;
  rotY: number;
  animState: PlayerEntityState['animState'];
}

export interface PenaltyShootoutStartOptions {
  humanTeam: TeamId;
  isSpectator?: boolean;
  fromDraw?: boolean;
}

export interface PenaltyShootoutAdapter {
  getConfig(): StadiumConfig;
  getPlayers(): ShootoutPlayerProxy[];
  getBallPos(): Vec3;
  getBallVel(): Vec3;
  setPhase(phase: MatchPhase): void;
  placeDeadBall(pos: Vec3): void;
  clearPossession(): void;
  kickBall(
    shooterId: string,
    dir: Vec3,
    power: number,
    lift: number,
    curlSpinY: number,
    isSuperShot: boolean
  ): void;
  triggerGKDive(gkId: string, dir: ShootoutDiveDir, diveTargetX: number): void;
  deflectBall?(dir: Vec3, power: number, lift: number, gkId: string, team: TeamId): void;
  triggerGoalNetRipple?(side: TeamId, impactPos: Vec3): void;
  triggerGoalCelebration?(scoringTeam: TeamId): void;
  triggerFireworks?(): void;
  playWhistle(type: 'short' | 'long' | 'double'): void;
  playGoalCelebration(): void;
  playCrowdReaction(type: 'cheer' | 'ooh' | 'boo'): void;
  playShootoutTension?(): void;
  setSpeech(playerId: string, text: string, durationSec?: number): void;
  pushEvent(text: string, icon: string, tone: ComedyEventTone): void;
  setJumbotronHeadline?(text: string, durationSec?: number): void;
  setPlayerVelocityZero?(playerId: string): void;
  setShootoutControl?(role: PenaltyShootoutTurnRole, playerId: string | null): void;
  onShootoutFinished?(winner: TeamId, shootoutScore: Record<TeamId, number>): void;
  onSyncStore?(): void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 1e-5) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: 0, z: z / len };
}

/**
 * Pure mathematical clinch evaluator for 5-round + sudden-death penalty shootouts.
 * Returns the winning team immediately if the trailing team can no longer catch up,
 * or null if the shootout must continue.
 */
export function evaluateShootoutWinner(
  rounds: Record<TeamId, PenaltyKickOutcome[]>,
  score: Record<TeamId, number>
): TeamId | null {
  const redTaken = rounds.red.filter((o) => o !== 'pending').length;
  const blueTaken = rounds.blue.filter((o) => o !== 'pending').length;

  // Regulation (first 5 kicks each): early clinch check after every kick
  if (redTaken <= PENALTY_SHOOTOUT_INITIAL_ROUNDS && blueTaken <= PENALTY_SHOOTOUT_INITIAL_ROUNDS) {
    const redRemaining = PENALTY_SHOOTOUT_INITIAL_ROUNDS - redTaken;
    const blueRemaining = PENALTY_SHOOTOUT_INITIAL_ROUNDS - blueTaken;

    if (score.red > score.blue + blueRemaining) return 'red';
    if (score.blue > score.red + redRemaining) return 'blue';
    return null;
  }

  // Sudden death: only resolve after both teams have taken the same number of kicks
  if (redTaken === blueTaken && redTaken > PENALTY_SHOOTOUT_INITIAL_ROUNDS) {
    if (score.red > score.blue) return 'red';
    if (score.blue > score.red) return 'blue';
  }

  return null;
}

/**
 * Standalone Dramatic Penalty Shootout Director:
 * - 5 regulation rounds + automatic sudden death + mathematical early clinch
 * - Human plays BOTH kicker (when humanTeam kicks) AND goalkeeper (when opponent kicks)
 * - Real 3D ball physics flight, AI subtle body-lean telegraph, GK dive/save/goal/miss resolution
 */
export class PenaltyShootoutDirector {
  private readonly adapter: PenaltyShootoutAdapter;
  private state: PenaltyShootoutState = createInitialPenaltyShootoutState();

  private humanTeam: TeamId = 'red';
  private isSpectator = false;
  private stageTimer = 0;

  // Per-turn tactical state
  private aiPlannedDirX: -1 | 0 | 1 = 0;
  private aiPlannedPower = 0.78;
  private humanQueuedGKDive: ShootoutDiveDir | null = null;
  private gkDiveTriggered = false;
  private activeGKDiveDir: ShootoutDiveDir | null = null;
  private shotTargetX = 0;
  private gkTouchedBall = false;
  private kickerRotationIndex: Record<TeamId, number> = { red: 0, blue: 0 };

  constructor(adapter: PenaltyShootoutAdapter) {
    this.adapter = adapter;
  }

  reset(): void {
    this.state = createInitialPenaltyShootoutState();
    this.stageTimer = 0;
    this.humanQueuedGKDive = null;
    this.gkDiveTriggered = false;
    this.activeGKDiveDir = null;
    this.gkTouchedBall = false;
    this.kickerRotationIndex = { red: 0, blue: 0 };
  }

  isActive(): boolean {
    return this.state.active;
  }

  getState(): PenaltyShootoutState {
    return {
      ...this.state,
      rounds: {
        red: [...this.state.rounds.red],
        blue: [...this.state.rounds.blue],
      },
      shootoutScore: { ...this.state.shootoutScore },
    };
  }

  start(opts: PenaltyShootoutStartOptions): PenaltyShootoutState {
    this.reset();
    this.humanTeam = opts.humanTeam;
    this.isSpectator = Boolean(opts.isSpectator);

    this.state = {
      ...createInitialPenaltyShootoutState(),
      active: true,
      stage: 'intro',
      round: 1,
      isSuddenDeath: false,
      turnIndex: 0,
      kickingTeam: 'red',
      defendingTeam: 'blue',
      humanTurnRole: this.computeHumanRole('red', 'blue'),
      headline: opts.fromDraw
        ? 'تعادل! ركلات الترجيح تحسم البطل! 🎯🔥'
        : 'ضربات الترجيح! 5 ركلات للحسم 🎯🔥',
      fromDraw: Boolean(opts.fromDraw),
      shotTimerSec: 0,
    };

    this.stageTimer = SHOOTOUT_INTRO_DURATION_SEC;

    this.adapter.clearPossession();
    this.adapter.setPhase('penalty_shootout');
    this.positionAllForCurrentTurn();
    this.adapter.playWhistle('long');
    this.adapter.playShootoutTension?.();
    this.adapter.setJumbotronHeadline?.('ركلات الترجيح! 🎯🔥', 2.8);
    this.adapter.pushEvent(this.state.headline, '🎯', 'shootout');
    this.adapter.onSyncStore?.();

    return this.getState();
  }

  update(dt: number): void {
    if (!this.state.active) return;

    switch (this.state.stage) {
      case 'intro':
        this.keepDeadBallAtSpot();
        this.stageTimer -= dt;
        if (this.stageTimer <= 0) {
          this.enterTurnSetup();
        }
        break;

      case 'sudden_death_banner':
        this.keepDeadBallAtSpot();
        this.stageTimer -= dt;
        if (this.stageTimer <= 0) {
          this.enterTurnSetup();
        }
        break;

      case 'turn_setup':
        this.keepDeadBallAtSpot();
        this.stageTimer -= dt;
        if (this.stageTimer <= 0) {
          this.enterAwaitingKick();
        }
        break;

      case 'awaiting_kick':
        this.stepAwaitingKick(dt);
        break;

      case 'ball_in_flight':
        this.stepBallInFlight(dt);
        break;

      case 'turn_result':
        this.stageTimer -= dt;
        if (this.stageTimer <= 0) {
          this.advanceAfterTurnResult();
        }
        break;

      case 'finished':
        break;
    }
  }

  /**
   * Human kicker executes a shootout kick via `shootoutKick` command (`dirX: -1 | 0 | 1`).
   */
  executeHumanKick(dirX: -1 | 0 | 1, power = 0.8): boolean {
    if (!this.state.active || this.state.stage !== 'awaiting_kick') return false;
    if (this.state.humanTurnRole !== 'kicker') return false;

    this.fireKick(dirX, clamp(power, 0.35, 1.0));
    return true;
  }

  /**
   * Human kicker executes a shootout kick via normal shoot release (aim vector + charge).
   */
  executeHumanAimKick(aimDir: Vec3, charge: number): boolean {
    if (!this.state.active || this.state.stage !== 'awaiting_kick') return false;
    if (this.state.humanTurnRole !== 'kicker') return false;

    const dirX = clamp(aimDir.x * 1.45, -1, 1);
    const power = clamp(0.42 + charge * 0.58, 0.35, 1.0);
    this.fireKick(dirX, power);
    return true;
  }

  /**
   * Human goalkeeper dives (`left` = -X, `center` = 0, `right` = +X).
   * Accepted right before kick (queued) or during live ball flight.
   */
  executeHumanGKDive(dir: ShootoutDiveDir): boolean {
    if (!this.state.active || this.state.humanTurnRole !== 'goalkeeper') return false;

    if (this.state.stage === 'awaiting_kick') {
      this.humanQueuedGKDive = dir;
      return true;
    }

    if (this.state.stage === 'ball_in_flight' && !this.gkDiveTriggered && this.state.gkId) {
      this.triggerGKDiveInternal(this.state.gkId, dir);
      return true;
    }

    return false;
  }

  /**
   * Optional hook for MatchEngine to notify an immediate physics goal detection during flight.
   */
  notifyGoalScored(): void {
    if (!this.state.active || this.state.stage !== 'ball_in_flight') return;
    this.resolveTurnOutcome('scored');
  }

  /**
   * Optional hook for MatchEngine to notify an immediate GK save/catch during flight.
   */
  notifyBallSaved(): void {
    if (!this.state.active || this.state.stage !== 'ball_in_flight') return;
    this.gkTouchedBall = true;
    this.resolveTurnOutcome('saved');
  }

  cancel(): void {
    if (!this.state.active) return;
    this.reset();
    this.adapter.onSyncStore?.();
  }

  /* ─────────────────────────── Internal State Steps ─────────────────────────── */

  private enterTurnSetup(): void {
    this.state.stage = 'turn_setup';
    this.stageTimer = SHOOTOUT_TURN_SETUP_DURATION_SEC;
    this.humanQueuedGKDive = null;
    this.gkDiveTriggered = false;
    this.activeGKDiveDir = null;
    this.gkTouchedBall = false;

    this.positionAllForCurrentTurn();

    const teamLabel = this.state.kickingTeam === 'red' ? 'الأحمر' : 'الأزرق';
    const roleHint =
      this.state.humanTurnRole === 'kicker'
        ? 'دورك تشوط! اختار الزاوية 🎯'
        : this.state.humanTurnRole === 'goalkeeper'
          ? 'دورك حارس! جهّز نفسك للارتماء 🧤'
          : `ركلة فريق ${teamLabel} (الجولة ${this.state.round})`;

    this.state.headline = roleHint;
    this.adapter.playWhistle('short');
    this.adapter.onSyncStore?.();
  }

  private enterAwaitingKick(): void {
    this.state.stage = 'awaiting_kick';

    if (this.state.humanTurnRole === 'kicker') {
      this.state.shotTimerSec = SHOOTOUT_HUMAN_KICK_TIMEOUT_SEC;
      this.state.headline = 'شوط الآن! (يمين / وسط / شمال) 🎯';
    } else {
      // AI kicker plans corner + power and prepares dramatic 1.4s buildup
      const corners: Array<-1 | 0 | 1> = [-1, 0, 1];
      this.aiPlannedDirX = corners[Math.floor(Math.random() * corners.length)];
      this.aiPlannedPower = 0.65 + Math.random() * 0.3;
      this.state.shotTimerSec = SHOOTOUT_AI_BUILDUP_SEC;
      this.state.headline =
        this.state.humanTurnRole === 'goalkeeper'
          ? 'ركّز في حركة اللاعب واترِمي! 🧤⚡'
          : `${this.state.shooterName} يستعد للتسديد...`;
    }

    this.adapter.playShootoutTension?.();
    this.adapter.onSyncStore?.();
  }

  private stepAwaitingKick(dt: number): void {
    this.keepDeadBallAtSpot();
    this.state.shotTimerSec = Math.max(0, this.state.shotTimerSec - dt);

    // Subtle body-lean telegraph by AI kicker during final 0.55s before striking
    if (
      this.state.humanTurnRole !== 'kicker' &&
      this.state.shotTimerSec <= SHOOTOUT_AI_TELEGRAPH_WINDOW_SEC &&
      this.state.shooterId
    ) {
      const shooter = this.adapter.getPlayers().find((p) => p.id === this.state.shooterId);
      if (shooter) {
        const progress = 1 - this.state.shotTimerSec / SHOOTOUT_AI_TELEGRAPH_WINDOW_SEC;
        // Facing +Z (rotY = 0); subtle lean toward planned corner (+X or -X)
        shooter.rotY = this.aiPlannedDirX * 0.14 * clamp(progress, 0, 1);
      }
    }

    if (this.state.shotTimerSec <= 0) {
      if (this.state.humanTurnRole === 'kicker') {
        // 7.5s safety auto-kick so shootout never stalls
        const randomCorner = ([-1, 0, 1] as const)[Math.floor(Math.random() * 3)];
        this.fireKick(randomCorner, 0.72);
      } else {
        this.fireKick(this.aiPlannedDirX, this.aiPlannedPower);
      }
    }
  }

  private fireKick(dirXRaw: number, powerNorm: number): void {
    const config = this.adapter.getConfig();
    const shooterId = this.state.shooterId;
    const gkId = this.state.gkId;
    if (!shooterId) {
      this.resolveTurnOutcome('missed');
      return;
    }

    const spot = this.getSpotPos(config);
    const goalZ = config.halfLength;
    const clampedDirX = clamp(dirXRaw, -1, 1);

    // Slight natural miss risk only if wildly overcharged (>0.96)
    const isOvercooked = powerNorm > 0.96 && Math.random() < 0.28;
    const spreadFactor = isOvercooked ? 0.56 : 0.37;
    const jitter = (Math.random() - 0.5) * 0.35;
    this.shotTargetX = clampedDirX * (config.goalWidth * spreadFactor) + jitter;

    const dir = normalizeXZ(this.shotTargetX - spot.x, goalZ - spot.z);
    const power = 24.5 + clamp(powerNorm, 0.3, 1.0) * 8.5;
    const lift = isOvercooked ? 6.2 : 1.7 + clamp(powerNorm, 0.3, 1.0) * 2.5;
    const curlSpinY = -clampedDirX * 9.5;
    const isSuperShot = powerNorm >= 0.78;

    this.adapter.kickBall(shooterId, dir, power, lift, curlSpinY, isSuperShot);

    this.state.stage = 'ball_in_flight';
    this.state.shotTimerSec = 0;
    this.stageTimer = 0;

    // Trigger GK dive: human queued dive if GK is human, else AI GK reads/guesses
    if (gkId) {
      if (this.state.humanTurnRole === 'goalkeeper') {
        if (this.humanQueuedGKDive) {
          this.triggerGKDiveInternal(gkId, this.humanQueuedGKDive);
        }
      } else {
        const aiDive = this.pickAIGKDive(clampedDirX);
        this.triggerGKDiveInternal(gkId, aiDive);
      }
    }

    this.adapter.onSyncStore?.();
  }

  private stepBallInFlight(dt: number): void {
    this.stageTimer += dt;
    const config = this.adapter.getConfig();
    const ballPos = this.adapter.getBallPos();
    const ballVel = this.adapter.getBallVel();
    const goalZ = config.halfLength;
    const halfGoalW = config.goalWidth * 0.49;

    // 1. Check GK save interception near the goal line
    const gk = this.adapter.getPlayers().find((p) => p.id === this.state.gkId);
    if (gk && !this.gkTouchedBall && ballPos.z >= goalZ - 3.0 && ballPos.z <= goalZ + 0.25) {
      const dx = ballPos.x - gk.pos.x;
      const dz = ballPos.z - gk.pos.z;
      const planarDist = Math.hypot(dx, dz);
      const reachRadius = this.gkDiveTriggered ? 1.55 : 1.05;

      // Also check matching dive zone if GK committed early to the right corner
      const zoneMatch =
        this.activeGKDiveDir !== null &&
        Math.abs(ballPos.x - this.getDiveTargetX(this.activeGKDiveDir, config)) < 1.35 &&
        Math.abs(ballPos.z - gk.pos.z) < 1.2;

      if ((planarDist <= reachRadius || zoneMatch) && ballPos.y <= config.goalHeight * 0.92) {
        this.gkTouchedBall = true;
        const deflectDir = normalizeXZ(
          (ballPos.x >= 0 ? 1 : -1) * 0.75,
          -1
        );
        this.adapter.deflectBall?.(deflectDir, 11.5, 3.2, gk.id, this.state.defendingTeam);
        this.resolveTurnOutcome('saved');
        return;
      }
    }

    // 2. Check goal scored (ball crossed goal line inside mouth & under crossbar)
    if (
      ballPos.z >= goalZ - 0.12 &&
      Math.abs(ballPos.x) <= halfGoalW &&
      ballPos.y <= config.goalHeight + 0.15
    ) {
      this.adapter.triggerGoalNetRipple?.(this.state.defendingTeam, ballPos);
      this.resolveTurnOutcome('scored');
      return;
    }

    // 3. Check miss (wide of posts, over crossbar, stopped short, or flight timeout)
    const speed = Math.hypot(ballVel.x, ballVel.y, ballVel.z);
    if (
      ballPos.z >= goalZ + 0.45 ||
      Math.abs(ballPos.x) > config.halfWidth - 0.4 ||
      this.stageTimer >= SHOOTOUT_FLIGHT_MAX_SEC ||
      (this.stageTimer > 0.65 && speed < 1.1)
    ) {
      this.resolveTurnOutcome(this.gkTouchedBall ? 'saved' : 'missed');
    }
  }

  private resolveTurnOutcome(outcome: Exclude<PenaltyKickOutcome, 'pending'>): void {
    if (this.state.stage === 'turn_result' || this.state.stage === 'finished') return;

    const team = this.state.kickingTeam;
    const defTeam = this.state.defendingTeam;
    const slotIdx = this.state.rounds[team].indexOf('pending');
    if (slotIdx >= 0) {
      this.state.rounds[team][slotIdx] = outcome;
    } else {
      this.state.rounds[team].push(outcome);
    }

    if (outcome === 'scored') {
      this.state.shootoutScore[team] += 1;
    }

    this.state.lastOutcome = outcome;
    this.state.stage = 'turn_result';
    this.stageTimer = SHOOTOUT_RESULT_DURATION_SEC;

    const shooter = this.adapter.getPlayers().find((p) => p.id === this.state.shooterId);
    const gk = this.adapter.getPlayers().find((p) => p.id === this.state.gkId);

    if (outcome === 'scored') {
      this.state.headline = `جوووول! ${this.state.shooterName} يسجل ببراعة! ⚽🔥`;
      if (shooter) {
        shooter.animState = 'celebrate';
        this.adapter.setSpeech(shooter.id, 'في الشبكة يا معلم! 🔥⚽', 1.8);
      }
      if (gk) {
        gk.animState = 'dive_flop';
      }
      this.adapter.playGoalCelebration();
      this.adapter.triggerGoalCelebration?.(team);
      this.adapter.setJumbotronHeadline?.('جوووول ترجيح! ⚽🔥', 1.8);
      this.adapter.pushEvent(this.state.headline, '⚽', 'goal');
    } else if (outcome === 'saved') {
      this.state.headline = `تصدي أسطوري من ${this.state.gkName}!! 🧤🔥`;
      if (gk) {
        gk.animState = 'celebrate';
        this.adapter.setSpeech(gk.id, 'أنا الأخطبوط! 🧤🐙', 1.8);
      }
      if (shooter) {
        shooter.animState = 'protest';
        this.adapter.setSpeech(shooter.id, 'إزاي جابها دي?! 😱', 1.8);
      }
      this.adapter.playCrowdReaction('ooh');
      this.adapter.setJumbotronHeadline?.('تصدي عالمي!! 🧤🔥', 1.8);
      this.adapter.pushEvent(this.state.headline, '🧤', 'shootout');
    } else {
      this.state.headline = `ضاعت!! ${this.state.shooterName} شاطها برّه! 😱`;
      if (shooter) {
        shooter.animState = 'protest';
        this.adapter.setSpeech(shooter.id, 'يا نهار أبيض! 😭', 1.8);
      }
      if (gk) {
        gk.animState = 'celebrate';
      }
      this.adapter.playCrowdReaction('boo');
      this.adapter.setJumbotronHeadline?.('ضاعت الركلة! 😱', 1.8);
      this.adapter.pushEvent(this.state.headline, '😱', 'shootout');
    }

    // Silence unused var warning for defTeam (used for clarity if needed later)
    void defTeam;
    this.adapter.onSyncStore?.();
  }

  private advanceAfterTurnResult(): void {
    // 1. Check mathematical early clinch or sudden-death winner
    const winner = evaluateShootoutWinner(this.state.rounds, this.state.shootoutScore);
    if (winner) {
      this.finishShootout(winner);
      return;
    }

    const redTaken = this.state.rounds.red.filter((o) => o !== 'pending').length;
    const blueTaken = this.state.rounds.blue.filter((o) => o !== 'pending').length;

    // 2. Check if entering sudden death (tied after 5 each) or next sudden-death pair
    const needNewSuddenDeathPair =
      redTaken === blueTaken && redTaken >= PENALTY_SHOOTOUT_INITIAL_ROUNDS;

    if (needNewSuddenDeathPair) {
      const enteringSuddenDeathFirstTime = !this.state.isSuddenDeath;
      this.state.isSuddenDeath = true;
      this.state.rounds.red.push('pending');
      this.state.rounds.blue.push('pending');
      this.state.turnIndex += 1;
      this.state.round = redTaken + 1;
      this.state.kickingTeam = 'red';
      this.state.defendingTeam = 'blue';
      this.state.humanTurnRole = this.computeHumanRole('red', 'blue');

      if (enteringSuddenDeathFirstTime) {
        this.state.stage = 'sudden_death_banner';
        this.stageTimer = SHOOTOUT_SUDDEN_DEATH_BANNER_SEC;
        this.state.headline = 'الموت المفاجئ! ركلة بركلة! 💀🔥';
        this.adapter.playWhistle('double');
        this.adapter.setJumbotronHeadline?.('الموت المفاجئ! 💀🔥', 2.0);
        this.adapter.pushEvent('تعادل بعد 5 ركلات! ندخل الموت المفاجئ! 💀🔥', '💀', 'shootout');
        this.adapter.onSyncStore?.();
        return;
      }

      this.enterTurnSetup();
      return;
    }

    // 3. Advance to next kick
    this.state.turnIndex += 1;
    const nextKicking: TeamId = this.state.turnIndex % 2 === 0 ? 'red' : 'blue';
    const nextDefending: TeamId = nextKicking === 'red' ? 'blue' : 'red';
    this.state.kickingTeam = nextKicking;
    this.state.defendingTeam = nextDefending;
    this.state.round = Math.floor(this.state.turnIndex / 2) + 1;
    this.state.humanTurnRole = this.computeHumanRole(nextKicking, nextDefending);

    this.enterTurnSetup();
  }

  private finishShootout(winner: TeamId): void {
    this.state.stage = 'finished';
    this.state.winner = winner;
    this.state.shotTimerSec = 0;

    const winnerLabel = winner === 'red' ? 'الأحمر 🔴' : 'الأزرق 🔵';
    this.state.headline = `فريق ${winnerLabel} يفوز بركلات الترجيح (${this.state.shootoutScore.red} - ${this.state.shootoutScore.blue})! 🏆🔥`;

    // Celebrate winning team players
    for (const p of this.adapter.getPlayers()) {
      if (p.isBenched || p.isSentOff || p.role === 'coach' || p.role === 'referee') continue;
      p.animState = p.team === winner ? 'celebrate' : 'dive_flop';
    }

    this.adapter.playWhistle('double');
    this.adapter.playGoalCelebration();
    this.adapter.triggerFireworks?.();
    this.adapter.setJumbotronHeadline?.(`بطل الترجيح: ${winnerLabel} 🏆`, 4.0);
    this.adapter.pushEvent(this.state.headline, '🏆', 'shootout');
    this.adapter.onShootoutFinished?.(winner, { ...this.state.shootoutScore });
    this.adapter.onSyncStore?.();
  }

  /* ─────────────────────────── Positioning & Helpers ─────────────────────────── */

  private computeHumanRole(kickingTeam: TeamId, defendingTeam: TeamId): PenaltyShootoutTurnRole {
    if (this.isSpectator) return 'spectator';
    if (this.humanTeam === kickingTeam) return 'kicker';
    if (this.humanTeam === defendingTeam) return 'goalkeeper';
    return 'spectator';
  }

  private getSpotPos(config: StadiumConfig): Vec3 {
    return { x: 0, y: 0.22, z: config.penaltySpotZ };
  }

  private keepDeadBallAtSpot(): void {
    const config = this.adapter.getConfig();
    this.adapter.placeDeadBall(this.getSpotPos(config));
  }

  private getDiveTargetX(dir: ShootoutDiveDir, config: StadiumConfig): number {
    const reach = config.goalWidth * 0.36;
    if (dir === 'left') return -reach;
    if (dir === 'right') return reach;
    return 0;
  }

  private triggerGKDiveInternal(gkId: string, dir: ShootoutDiveDir): void {
    const config = this.adapter.getConfig();
    this.gkDiveTriggered = true;
    this.activeGKDiveDir = dir;
    this.adapter.triggerGKDive(gkId, dir, this.getDiveTargetX(dir, config));
  }

  private pickAIGKDive(shotDirX: number): ShootoutDiveDir {
    // 38% chance to read the corner correctly, otherwise random corner
    if (Math.random() < 0.38) {
      if (shotDirX < -0.25) return 'left';
      if (shotDirX > 0.25) return 'right';
      return 'center';
    }
    const choices: ShootoutDiveDir[] = ['left', 'center', 'right'];
    return choices[Math.floor(Math.random() * choices.length)];
  }

  private positionAllForCurrentTurn(): void {
    const config = this.adapter.getConfig();
    const players = this.adapter.getPlayers();
    const spot = this.getSpotPos(config);
    const goalLineZ = config.halfLength - 0.8;

    const shooter = this.pickShooter(players, this.state.kickingTeam);
    const gk = players.find(
      (p) =>
        p.team === this.state.defendingTeam &&
        p.role === 'goalkeeper' &&
        !p.isBenched &&
        !p.isSentOff
    );

    this.state.shooterId = shooter?.id ?? null;
    this.state.shooterName = shooter?.name ?? '';
    this.state.gkId = gk?.id ?? null;
    this.state.gkName = gk?.name ?? '';

    this.adapter.clearPossession();
    this.adapter.placeDeadBall(spot);

    // Position shooter 2.4m behind penalty spot facing +Z
    if (shooter) {
      shooter.pos.x = 0;
      shooter.pos.y = 0;
      shooter.pos.z = spot.z - 2.4;
      shooter.rotY = 0;
      shooter.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(shooter.id);
    }

    // Position defending GK on the +Z goal line facing -Z
    if (gk) {
      gk.pos.x = 0;
      gk.pos.y = 0;
      gk.pos.z = goalLineZ;
      gk.rotY = Math.PI;
      gk.animState = 'idle';
      this.adapter.setPlayerVelocityZero?.(gk.id);
    }

    // Park everyone else dramatically around the center circle watching
    let spectIdx = 0;
    for (const p of players) {
      if (
        p.id === shooter?.id ||
        p.id === gk?.id ||
        p.isBenched ||
        p.isSentOff ||
        p.role === 'coach'
      ) {
        continue;
      }
      if (p.role === 'referee') {
        p.pos.x = -7.5;
        p.pos.y = 0;
        p.pos.z = spot.z - 2.0;
        p.rotY = Math.PI * 0.42;
        p.animState = 'idle';
      } else {
        const side = spectIdx % 2 === 0 ? -1 : 1;
        const row = Math.floor(spectIdx / 2);
        p.pos.x = side * (3.2 + row * 2.2);
        p.pos.y = 0;
        p.pos.z = 1.5 - row * 1.4;
        p.rotY = 0;
        p.animState = 'idle';
        spectIdx += 1;
      }
      this.adapter.setPlayerVelocityZero?.(p.id);
    }

    const controlledId =
      this.state.humanTurnRole === 'kicker'
        ? (shooter?.id ?? null)
        : this.state.humanTurnRole === 'goalkeeper'
          ? (gk?.id ?? null)
          : null;
    this.adapter.setShootoutControl?.(this.state.humanTurnRole, controlledId);
  }

  private pickShooter(players: ShootoutPlayerProxy[], team: TeamId): ShootoutPlayerProxy | null {
    const candidates = players.filter(
      (p) => p.team === team && p.role === 'outfield' && !p.isBenched && !p.isSentOff
    );
    if (candidates.length === 0) {
      return (
        players.find(
          (p) => p.team === team && p.role === 'goalkeeper' && !p.isBenched && !p.isSentOff
        ) ?? null
      );
    }

    // If human is kicking on this team, prioritize human outfielder on their turns!
    if (this.state.humanTurnRole === 'kicker') {
      const humanOutfield = candidates.find((p) => p.isHumanControlled || p.isRemoteHuman);
      if (humanOutfield) return humanOutfield;
    }

    const idx = this.kickerRotationIndex[team] % candidates.length;
    this.kickerRotationIndex[team] += 1;
    return candidates[idx];
  }
}
