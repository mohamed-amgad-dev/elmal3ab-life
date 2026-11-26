import {
  COACH_SUB_COOLDOWN_SEC,
  MAX_SUBS_PER_TEAM,
  MIN_ROUTINE_SUB_ELAPSED_SEC,
  createInitialCoachDisciplineStats,
  type CoachDisciplineStats,
  type CoachDisciplineTeamStats,
  type PlayerEntityState,
  type TeamId,
} from '../../types/game';

export const EMERGENCY_FATIGUE_STAMINA_THRESHOLD = 18;
export const ROUTINE_FATIGUE_STAMINA_THRESHOLD = 28;
export const MIN_FATIGUE_STAMINA_ADVANTAGE = 22;
export const YELLOW_CARD_SUB_MIN_ELAPSED_SEC = 40;
export const LATE_TACTICAL_PUSH_CLOCK_SEC = 55;
export const LATE_TACTICAL_MIN_STAMINA_ADVANTAGE = 18;

export type CoachSubTrigger =
  | 'emergency_fatigue'
  | 'fatigue'
  | 'yellow_card_risk'
  | 'late_tactical_push'
  | 'human_coach';

export interface CoachSubEligibility {
  allowed: boolean;
  blockReason?: string;
}

export interface CoachSubEvaluationInput {
  team: TeamId;
  teamPlayers: ReadonlyArray<PlayerEntityState>;
  scoreDiff: number;
  clockSec: number;
  matchElapsedSec: number;
  tracker: CoachDisciplineTracker;
  hasPendingSub?: boolean;
}

export interface CoachSubDecision {
  outPlayer: PlayerEntityState;
  inPlayer: PlayerEntityState;
  trigger: CoachSubTrigger;
  reason: string;
  shoutText: string;
}

/**
 * Football-law substitution discipline tracker shared between AI coaches and
 * human coaches (`MatchEngine` / `@engine-wiring`).
 *
 * Enforces:
 * - Hard match cap (`MAX_SUBS_PER_TEAM` = 3 per team)
 * - Per-team cooldown (`COACH_SUB_COOLDOWN_SEC` = 42s between subs)
 * - Minimum match elapsed gate (`MIN_ROUTINE_SUB_ELAPSED_SEC` = 35s) unless emergency fatigue (< 18 stamina)
 * - Anti-ping-pong tracking of subbed-out and yellow-card-replaced players
 */
export class CoachDisciplineTracker {
  private stats: CoachDisciplineStats = createInitialCoachDisciplineStats();
  private readonly bookedReplacedIds: Record<TeamId, Set<string>> = {
    red: new Set<string>(),
    blue: new Set<string>(),
  };

  reset(): void {
    this.stats = createInitialCoachDisciplineStats();
    this.bookedReplacedIds.red.clear();
    this.bookedReplacedIds.blue.clear();
  }

  /** Decrements substitution cooldowns for both teams. Call once per simulation frame. */
  tick(dt: number): void {
    this.tickTeam('red', dt);
    this.tickTeam('blue', dt);
  }

  /** Decrements substitution cooldown for a single team (safe for per-team evaluation loops). */
  tickTeam(team: TeamId, dt: number): void {
    const teamStats = this.stats[team];
    if (teamStats.cooldownRemainingSec > 0) {
      teamStats.cooldownRemainingSec = Math.max(0, teamStats.cooldownRemainingSec - dt);
    }
  }

  canMakeSub(
    team: TeamId,
    matchElapsedSec: number,
    opts?: {
      isEmergencyFatigue?: boolean;
      bypassMinElapsed?: boolean;
    }
  ): CoachSubEligibility {
    const s = this.stats[team];
    if (s.subsUsed >= s.maxSubs) {
      return {
        allowed: false,
        blockReason: `استنفدت التبديلات الـ${s.maxSubs} المسموحة`,
      };
    }

    if (s.cooldownRemainingSec > 0.05) {
      const waitSec = Math.ceil(s.cooldownRemainingSec);
      return {
        allowed: false,
        blockReason: `استنى ${waitSec}ث قبل التبديل الجاي`,
      };
    }

    if (
      !opts?.isEmergencyFatigue &&
      !opts?.bypassMinElapsed &&
      matchElapsedSec < MIN_ROUTINE_SUB_ELAPSED_SEC
    ) {
      return {
        allowed: false,
        blockReason: 'لسه بدري على التبديلات',
      };
    }

    return { allowed: true };
  }

  recordSub(
    team: TeamId,
    outPlayerId: string,
    _inPlayerId: string,
    matchElapsedSec: number,
    trigger: CoachSubTrigger = 'human_coach'
  ): void {
    const s = this.stats[team];
    s.subsUsed = Math.min(s.maxSubs, s.subsUsed + 1);
    s.cooldownRemainingSec = COACH_SUB_COOLDOWN_SEC;
    s.lastSubMatchElapsedSec = matchElapsedSec;
    if (outPlayerId && !s.subbedOutPlayerIds.includes(outPlayerId)) {
      s.subbedOutPlayerIds.push(outPlayerId);
    }
    if (trigger === 'yellow_card_risk' && outPlayerId) {
      this.bookedReplacedIds[team].add(outPlayerId);
    }
  }

  wasSubbedOut(team: TeamId, playerId: string): boolean {
    return (
      this.stats[team].subbedOutPlayerIds.includes(playerId) ||
      this.bookedReplacedIds[team].has(playerId)
    );
  }

  wasBookedReplaced(team: TeamId, playerId: string): boolean {
    return this.bookedReplacedIds[team].has(playerId);
  }

  getRemainingSubs(team: TeamId): number {
    const s = this.stats[team];
    return Math.max(0, s.maxSubs - s.subsUsed);
  }

  getTeamStats(team: TeamId): CoachDisciplineTeamStats {
    const s = this.stats[team];
    return {
      subsUsed: s.subsUsed,
      maxSubs: s.maxSubs,
      cooldownRemainingSec: s.cooldownRemainingSec,
      lastSubMatchElapsedSec: s.lastSubMatchElapsedSec,
      subbedOutPlayerIds: [...s.subbedOutPlayerIds],
    };
  }

  getSnapshot(): CoachDisciplineStats {
    return {
      red: this.getTeamStats('red'),
      blue: this.getTeamStats('blue'),
    };
  }
}

function getEligibleBenchReserves(
  team: TeamId,
  teamPlayers: ReadonlyArray<PlayerEntityState>,
  tracker: CoachDisciplineTracker
): PlayerEntityState[] {
  return teamPlayers
    .filter(
      (p) =>
        p.role === 'outfield' &&
        p.isBenched &&
        !p.isSentOff &&
        !tracker.wasSubbedOut(team, p.id)
    )
    .sort((a, b) => b.stamina - a.stamina);
}

function getEligibleOnPitchCandidates(
  team: TeamId,
  teamPlayers: ReadonlyArray<PlayerEntityState>,
  tracker: CoachDisciplineTracker
): PlayerEntityState[] {
  return teamPlayers.filter(
    (p) =>
      p.role === 'outfield' &&
      !p.isBenched &&
      !p.isSentOff &&
      !p.isHumanControlled &&
      !tracker.wasSubbedOut(team, p.id)
  );
}

/**
 * Evaluates whether an AI coach has a genuine football reason to make a substitution:
 * 1. Emergency fatigue (`stamina < 18` & bench has `>= +22` stamina) — allowed anytime after kickoff.
 * 2. Routine fatigue (`stamina < 28` & bench has `>= +22` stamina) — after `MIN_ROUTINE_SUB_ELAPSED_SEC`.
 * 3. Yellow-card discipline risk (`yellowCards >= 1`, `matchElapsedSec >= 40`, clean fitter bench reserve).
 * 4. Late tactical push (`clockSec <= 55`, trailing by `>= 1`, fresher bench legs).
 */
export function evaluateCoachSubstitution(
  input: CoachSubEvaluationInput
): CoachSubDecision | null {
  const { team, teamPlayers, scoreDiff, clockSec, matchElapsedSec, tracker, hasPendingSub } =
    input;

  if (hasPendingSub) return null;

  const benchReserves = getEligibleBenchReserves(team, teamPlayers, tracker);
  if (benchReserves.length === 0) return null;

  const onPitch = getEligibleOnPitchCandidates(team, teamPlayers, tracker);
  if (onPitch.length === 0) return null;

  const freshestBench = benchReserves[0];

  // 1. Emergency severe fatigue (< 18 stamina) — allowed even before 35s elapsed
  const emergencyCapCheck = tracker.canMakeSub(team, matchElapsedSec, {
    isEmergencyFatigue: true,
  });
  if (!emergencyCapCheck.allowed) return null;

  const tiredSorted = [...onPitch].sort((a, b) => a.stamina - b.stamina);
  const mostTired = tiredSorted[0];

  if (
    mostTired &&
    mostTired.stamina < EMERGENCY_FATIGUE_STAMINA_THRESHOLD &&
    freshestBench.stamina - mostTired.stamina >= MIN_FATIGUE_STAMINA_ADVANTAGE
  ) {
    return {
      outPlayer: mostTired,
      inPlayer: freshestBench,
      trigger: 'emergency_fatigue',
      reason: 'إرهاق شديد — لازم يرتاح فوراً',
      shoutText: `اطلع ارتاح يا ${mostTired.name}، هتنزل يا ${freshestBench.name}! 🪑💦`,
    };
  }

  // All routine triggers require >= MIN_ROUTINE_SUB_ELAPSED_SEC (35s)
  const routineCheck = tracker.canMakeSub(team, matchElapsedSec);
  if (!routineCheck.allowed) return null;

  // 2. Genuine fatigue (< 28 stamina and bench >= +22 stamina fresher)
  if (
    mostTired &&
    mostTired.stamina < ROUTINE_FATIGUE_STAMINA_THRESHOLD &&
    freshestBench.stamina - mostTired.stamina >= MIN_FATIGUE_STAMINA_ADVANTAGE
  ) {
    return {
      outPlayer: mostTired,
      inPlayer: freshestBench,
      trigger: 'fatigue',
      reason: 'تعب بدني — تجديد دماء',
      shoutText: `نفسك اتقطع يا ${mostTired.name}، انزل يا ${freshestBench.name} جري! 🔄⚡`,
    };
  }

  // 3. Yellow-card discipline risk (only if matchElapsed >= 40s & clean fitter bench player exists)
  if (matchElapsedSec >= YELLOW_CARD_SUB_MIN_ELAPSED_SEC) {
    const cleanBench = benchReserves.find((b) => b.yellowCards === 0);
    if (cleanBench) {
      const bookedCandidate = onPitch
        .filter(
          (p) =>
            p.yellowCards >= 1 &&
            !tracker.wasBookedReplaced(team, p.id) &&
            (cleanBench.stamina >= p.stamina + 8 || cleanBench.stamina >= 60)
        )
        .sort((a, b) => a.stamina - b.stamina)[0];

      if (bookedCandidate) {
        return {
          outPlayer: bookedCandidate,
          inPlayer: cleanBench,
          trigger: 'yellow_card_risk',
          reason: 'خوف من الطرد بعد الإنذار',
          shoutText: `اطلع يا ${bookedCandidate.name} قبل الكارت التاني! انزل يا ${cleanBench.name} 🟨🔄`,
        };
      }
    }
  }

  // 4. Late tactical push (clock <= 55s, trailing by >= 1 goal, fresher legs on bench)
  if (clockSec <= LATE_TACTICAL_PUSH_CLOCK_SEC && scoreDiff <= -1) {
    const targetOut = tiredSorted.find(
      (p) =>
        freshestBench.stamina >= 65 &&
        freshestBench.stamina - p.stamina >= LATE_TACTICAL_MIN_STAMINA_ADVANTAGE
    );
    if (targetOut) {
      return {
        outPlayer: targetOut,
        inPlayer: freshestBench,
        trigger: 'late_tactical_push',
        reason: 'تبديل هجومي متأخر للحاق بالنتيجة',
        shoutText: `تبديل هجومي يا رجالة! انزل يا ${freshestBench.name} هات التعادل 🔥🔄`,
      };
    }
  }

  return null;
}

export { MAX_SUBS_PER_TEAM, COACH_SUB_COOLDOWN_SEC, MIN_ROUTINE_SUB_ELAPSED_SEC };
