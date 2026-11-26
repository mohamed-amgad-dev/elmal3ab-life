import type {
  AdminRules,
  CoachDisciplineStats,
  PlayerEntityState,
  TacticalStance,
  TeamId,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';
import {
  CoachDisciplineTracker,
  evaluateCoachSubstitution,
  type CoachSubTrigger,
} from './CoachDiscipline';

export interface CoachAIContext {
  coach: PlayerEntityState;
  team: TeamId;
  teamPlayers: ReadonlyArray<PlayerEntityState>;
  score: Record<TeamId, number>;
  clockSec: number;
  currentStance: TacticalStance;
  config: StadiumConfig;
  rules: AdminRules;
  isHumanCoach: boolean;
  /** Optional shared tracker owned by MatchEngine so human and AI subs share caps & cooldowns. */
  disciplineTracker?: CoachDisciplineTracker;
  /** True when a substitution is already queued/pending for this team. */
  hasPendingSub?: boolean;
  /** Optional elapsed match time in seconds; defaults to `rules.matchDurationSec - clockSec`. */
  matchElapsedSec?: number;
  dt: number;
  elapsed: number;
}

export type CoachAIAction =
  | { kind: 'none' }
  | { kind: 'shout'; text: string }
  | { kind: 'setTactic'; stance: TacticalStance; shoutText: string }
  | {
      kind: 'subToBench';
      playerId: string;
      inPlayerId: string;
      reason: string;
      trigger: CoachSubTrigger;
      shoutText: string;
    };

export interface CoachAIDecision {
  targetPos: Vec3;
  facingYaw: number;
  action: CoachAIAction;
}

const TOUCHLINE_SHOUTS = [
  'العب عالطرف يا ابني! 📢',
  'افتح ملعب يا رجالة! ⚽',
  'اضغط عليه ماتسيبهوش! 🔥',
  'فين التغطية يا كابتن?! 😤',
  'شوط يا عم مستني إيه?! 🎯',
  'اللي هيتمشى هيقعد دكة! 🪑',
];

/**
 * Animated Touchline Coach AI:
 * - Paces energetically along the technical zone facing the pitch.
 * - Adjusts team TacticalStance dynamically based on score & remaining clock.
 * - Uses strict football-law substitution discipline (`CoachDiscipline`):
 *   hard 3-sub cap, 42s per-team cooldown, 35s minimum elapsed gate (except
 *   emergency fatigue < 18), zero yellow-card ping-pong, and genuine football triggers only.
 */
export class CoachAI {
  private readonly shoutTimers = new Map<TeamId, number>();
  private readonly tacticTimers = new Map<TeamId, number>();
  private readonly subCheckTimers = new Map<TeamId, number>();
  private readonly internalDiscipline = new CoachDisciplineTracker();

  reset(): void {
    this.shoutTimers.clear();
    this.tacticTimers.clear();
    this.subCheckTimers.clear();
    this.internalDiscipline.reset();
  }

  getDisciplineTracker(): CoachDisciplineTracker {
    return this.internalDiscipline;
  }

  getDisciplineSnapshot(): CoachDisciplineStats {
    return this.internalDiscipline.getSnapshot();
  }

  evaluate(ctx: CoachAIContext): CoachAIDecision {
    const {
      team,
      teamPlayers,
      score,
      clockSec,
      currentStance,
      config,
      rules,
      isHumanCoach,
      disciplineTracker,
      hasPendingSub,
      dt,
      elapsed,
    } = ctx;

    const tracker = disciplineTracker ?? this.internalDiscipline;
    if (!disciplineTracker) {
      this.internalDiscipline.tickTeam(team, dt);
    }

    const zone = config.coachZones[team];
    const paceOffset = Math.sin(elapsed * 1.15 + (team === 'red' ? 0 : 2.1)) * 2.4;
    const targetPos: Vec3 = {
      x: zone.x,
      y: 0,
      z: zone.z + paceOffset,
    };
    // Technical zone is on +X facing -X (toward pitch)
    const facingYaw = -Math.PI / 2;

    if (isHumanCoach) {
      return { targetPos, facingYaw, action: { kind: 'none' } };
    }

    const shoutCd = Math.max(0, (this.shoutTimers.get(team) ?? 6) - dt);
    const tacticCd = Math.max(0, (this.tacticTimers.get(team) ?? 12) - dt);
    const subCheckCd = Math.max(0, (this.subCheckTimers.get(team) ?? 2.0) - dt);

    this.shoutTimers.set(team, shoutCd);
    this.tacticTimers.set(team, tacticCd);
    this.subCheckTimers.set(team, subCheckCd);

    const oppTeam: TeamId = team === 'red' ? 'blue' : 'red';
    const scoreDiff = score[team] - score[oppTeam];

    // 1. Tactical adjustment based on match situation
    if (tacticCd <= 0) {
      let desiredStance: TacticalStance = 'balanced';
      let shoutText = 'تنظيم يا شباب! العب متوازن 🧠';

      if (scoreDiff < 0 && clockSec < 85) {
        desiredStance = 'all_out_attack';
        shoutText = 'الكل يطلع هجوم! عايزين التعادل! 🔥';
      } else if (scoreDiff > 0 && clockSec < 50) {
        desiredStance = 'park_the_bus';
        shoutText = 'اركن الأتوبيس ورا يا رجالة! 🚌🧱';
      } else if (scoreDiff === 0 && clockSec < 95) {
        desiredStance = 'high_press';
        shoutText = 'ضغط عالي في ملعبهم! ⚡';
      }

      this.tacticTimers.set(team, 18 + Math.random() * 10);
      if (desiredStance !== currentStance) {
        return {
          targetPos,
          facingYaw,
          action: { kind: 'setTactic', stance: desiredStance, shoutText },
        };
      }
    }

    // 2. Disciplined, football-law substitutions (real triggers only — no blind timer spam)
    if (rules.enableCoachBench && subCheckCd <= 0) {
      const matchElapsedSec =
        ctx.matchElapsedSec ?? Math.max(0, rules.matchDurationSec - clockSec);

      const subDecision = evaluateCoachSubstitution({
        team,
        teamPlayers,
        scoreDiff,
        clockSec,
        matchElapsedSec,
        tracker,
        hasPendingSub,
      });

      if (subDecision) {
        // If CoachAI is running standalone without an external shared tracker, record immediately.
        if (!disciplineTracker) {
          this.internalDiscipline.recordSub(
            team,
            subDecision.outPlayer.id,
            subDecision.inPlayer.id,
            matchElapsedSec,
            subDecision.trigger
          );
        }
        // Brief guard so we do not double-propose while MatchEngine queues the stoppage
        this.subCheckTimers.set(team, 8.0);
        return {
          targetPos,
          facingYaw,
          action: {
            kind: 'subToBench',
            playerId: subDecision.outPlayer.id,
            inPlayerId: subDecision.inPlayer.id,
            reason: subDecision.reason,
            trigger: subDecision.trigger,
            shoutText: subDecision.shoutText,
          },
        };
      }

      this.subCheckTimers.set(team, 1.5);
    }

    // 3. Energetic Egyptian touchline shouts!
    if (shoutCd <= 0) {
      this.shoutTimers.set(team, 9 + Math.random() * 7);
      const shout =
        TOUCHLINE_SHOUTS[Math.floor(Math.random() * TOUCHLINE_SHOUTS.length)];
      return {
        targetPos,
        facingYaw,
        action: { kind: 'shout', text: shout },
      };
    }

    return { targetPos, facingYaw, action: { kind: 'none' } };
  }
}
