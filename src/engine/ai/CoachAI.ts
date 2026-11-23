import type {
  AdminRules,
  PlayerEntityState,
  TacticalStance,
  TeamId,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

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
  dt: number;
  elapsed: number;
}

export type CoachAIAction =
  | { kind: 'none' }
  | { kind: 'shout'; text: string }
  | { kind: 'setTactic'; stance: TacticalStance; shoutText: string }
  | { kind: 'subToBench'; playerId: string; shoutText: string };

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
 * - In Chaos Mode (`enableCoachBench`), occasionally substitutes tired or booked AI players
 *   and shouts comedic threats from the sideline!
 */
export class CoachAI {
  private readonly shoutTimers = new Map<TeamId, number>();
  private readonly tacticTimers = new Map<TeamId, number>();
  private readonly subTimers = new Map<TeamId, number>();

  reset(): void {
    this.shoutTimers.clear();
    this.tacticTimers.clear();
    this.subTimers.clear();
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
      dt,
      elapsed,
    } = ctx;

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
    const subCd = Math.max(0, (this.subTimers.get(team) ?? 22) - dt);

    this.shoutTimers.set(team, shoutCd);
    this.tacticTimers.set(team, tacticCd);
    this.subTimers.set(team, subCd);

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

    // 2. Chaos Mode automatic substitution for tired / booked AI players
    if (rules.enableCoachBench && subCd <= 0) {
      const hasBenchReserve = teamPlayers.some(
        (p) => p.role === 'outfield' && p.isBenched && !p.isSentOff
      );
      if (hasBenchReserve) {
        const subCandidate = teamPlayers.find(
          (p) =>
            p.role === 'outfield' &&
            !p.isBenched &&
            !p.isSentOff &&
            !p.isHumanControlled &&
            (p.stamina < 42 || p.yellowCards >= 1)
        );

        this.subTimers.set(team, 26 + Math.random() * 14);
        if (subCandidate) {
          return {
            targetPos,
            facingYaw,
            action: {
              kind: 'subToBench',
              playerId: subCandidate.id,
              shoutText: `اطلع دكة يا ${subCandidate.name}! كفاية كده 🪑🔥`,
            },
          };
        }
      }
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
