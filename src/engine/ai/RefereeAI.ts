import type {
  AdminRules,
  PlayerEntityState,
  TeamId,
  VARVerdict,
  Vec3,
} from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export interface RefereeIncident {
  kind: 'foul' | 'dive';
  offenderId: string;
  victimId?: string;
  team: TeamId;
  pos: Vec3;
  inPenaltyBox: boolean;
  penaltyForTeam: TeamId;
  severity: number; // 0..1
}

export interface RefereeAIContext {
  ref: PlayerEntityState;
  ballPos: Vec3;
  config: StadiumConfig;
  rules: AdminRules;
  isHumanRef: boolean;
  inVARReview: boolean;
  varElapsed: number;
  pendingIncident: RefereeIncident | null;
  dt: number;
}

export type RefereeCardLevel = 'none' | 'yellow' | 'red';

export const FOUL_MIN_SEVERITY = 0.24;
export const FOUL_YELLOW_SEVERITY = 0.45;
export const FOUL_RED_SEVERITY = 0.78;
export const FOUL_COOLDOWN_SEC = 2.0;

export function classifyFoulCard(severity: number): RefereeCardLevel {
  if (severity >= FOUL_RED_SEVERITY) return 'red';
  if (severity >= FOUL_YELLOW_SEVERITY) return 'yellow';
  return 'none';
}

export type RefereeAIAction =
  | { kind: 'none' }
  | { kind: 'yellowCard'; targetId: string; reason: string }
  | { kind: 'redCard'; targetId: string; reason: string }
  | {
      kind: 'freeKick';
      forTeam: TeamId;
      spot: Vec3;
      offenderId: string;
      card: RefereeCardLevel;
      reason: string;
    }
  | {
      kind: 'penalty';
      forTeam: TeamId;
      reason: string;
      offenderId?: string;
      card?: RefereeCardLevel;
    }
  | { kind: 'startVAR'; reason: string; focusPos: Vec3; forTeam: TeamId; suspectId: string }
  | { kind: 'varVerdict'; verdict: VARVerdict };

export interface RefereeAIDecision {
  targetPos: Vec3;
  sprint: boolean;
  facingYaw: number;
  action: RefereeAIAction;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Arcade Referee AI:
 * - Tracks play at smart mid-distance without obstructing the ball.
 * - When AI controls the referee, calls fouls on reckless slide tackles,
 *   gets hilariously fooled by box dives (awarding surprise penalties, flashing
 *   yellow for simulation, or jogging to the VAR booth!).
 * - Automatically issues a funny VAR verdict after ~3.8s when human is not the ref.
 */
export class RefereeAI {
  private decisionCooldown = 0;
  private foulCooldown = 0;
  private plannedVerdict: VARVerdict | null = null;

  reset(): void {
    this.decisionCooldown = 0;
    this.foulCooldown = 0;
    this.plannedVerdict = null;
  }

  evaluate(ctx: RefereeAIContext): RefereeAIDecision {
    const { ref, ballPos, config, rules, isHumanRef, inVARReview, varElapsed, pendingIncident, dt } = ctx;
    this.decisionCooldown = Math.max(0, this.decisionCooldown - dt);
    this.foulCooldown = Math.max(0, this.foulCooldown - dt);

    // During VAR review, run over toward the VAR booth on -X touchline!
    if (inVARReview) {
      const boothTarget: Vec3 = {
        x: config.varBoothPos.x + 2.4,
        y: 0,
        z: config.varBoothPos.z,
      };
      const facingYaw = Math.atan2(
        config.varBoothPos.x - ref.pos.x,
        config.varBoothPos.z - ref.pos.z
      );

      // If AI is referee, announce verdict after dramatic 3.8s slow-motion review
      if (!isHumanRef && varElapsed >= 3.8) {
        const verdict = this.plannedVerdict ?? this.pickRandomVARVerdict();
        this.plannedVerdict = null;
        this.decisionCooldown = 3.0;
        return {
          targetPos: boothTarget,
          sprint: false,
          facingYaw,
          action: { kind: 'varVerdict', verdict },
        };
      }

      return {
        targetPos: boothTarget,
        sprint: true,
        facingYaw,
        action: { kind: 'none' },
      };
    }

    // Smart mid-distance positioning slightly toward the -X (VAR) side
    const desiredX = clamp(ballPos.x - 7.5, -config.halfWidth + 2, config.halfWidth - 2);
    const desiredZ = clamp(ballPos.z * 0.78, -config.halfLength + 5, config.halfLength - 5);
    const dist = Math.hypot(desiredX - ref.pos.x, desiredZ - ref.pos.z);
    const facingYaw = Math.atan2(ballPos.x - ref.pos.x, ballPos.z - ref.pos.z);

    // If human controls referee or no incident, track play without automatic calls
    if (isHumanRef || !pendingIncident) {
      return {
        targetPos: { x: desiredX, y: 0, z: desiredZ },
        sprint: dist > 10,
        facingYaw,
        action: { kind: 'none' },
      };
    }

    if (pendingIncident.kind === 'dive') {
      if (this.decisionCooldown > 0) {
        return {
          targetPos: { x: desiredX, y: 0, z: desiredZ },
          sprint: dist > 10,
          facingYaw,
          action: { kind: 'none' },
        };
      }
      this.decisionCooldown = 2.6;
      const roll = Math.random();
      if (pendingIncident.inPenaltyBox) {
        if (rules.enableVAR && roll < 0.38) {
          this.plannedVerdict = Math.random() < 0.5 ? 'yellow_for_dive' : 'penalty_awarded';
          return {
            targetPos: { x: desiredX, y: 0, z: desiredZ },
            sprint: true,
            facingYaw,
            action: {
              kind: 'startVAR',
              reason: 'مراجعة الفار: هل هي ضربة جزاء أم غطسة أوسكار؟ 🎭📺',
              focusPos: pendingIncident.pos,
              forTeam: pendingIncident.penaltyForTeam,
              suspectId: pendingIncident.offenderId,
            },
          };
        }
        if (roll < 0.68) {
          return {
            targetPos: { x: desiredX, y: 0, z: desiredZ },
            sprint: false,
            facingYaw,
            action: {
              kind: 'penalty',
              forTeam: pendingIncident.penaltyForTeam,
              reason: 'الحكم بلع الطُعم! ضربة جزاء من الهوا! 😂🎯',
              offenderId: pendingIncident.offenderId,
              card: 'none',
            },
          };
        }
        return {
          targetPos: { x: desiredX, y: 0, z: desiredZ },
          sprint: false,
          facingYaw,
          action: {
            kind: 'yellowCard',
            targetId: pendingIncident.offenderId,
            reason: 'غطسة سينمائية! كارت أصفر للتمثيل 🎭🟨',
          },
        };
      }

      // Dive outside penalty box
      if (roll < 0.45) {
        return {
          targetPos: { x: desiredX, y: 0, z: desiredZ },
          sprint: false,
          facingYaw,
          action: {
            kind: 'yellowCard',
            targetId: pendingIncident.offenderId,
            reason: 'تمثيل واضح قدام عين الحكم! أصفر يا بطل 🎭🟨',
          },
        };
      }
      return {
        targetPos: { x: desiredX, y: 0, z: desiredZ },
        sprint: false,
        facingYaw,
        action: { kind: 'none' },
      };
    }

    // Real foul detection: ignore negligible brushes (< 0.24) and prevent double-whistles (2.0s hysteresis)
    if (this.foulCooldown > 0 || pendingIncident.severity < FOUL_MIN_SEVERITY) {
      return {
        targetPos: { x: desiredX, y: 0, z: desiredZ },
        sprint: dist > 10,
        facingYaw,
        action: { kind: 'none' },
      };
    }

    this.foulCooldown = FOUL_COOLDOWN_SEC;
    this.decisionCooldown = FOUL_COOLDOWN_SEC;
    const card = classifyFoulCard(pendingIncident.severity);

    // Foul inside defending penalty box -> Penalty (or VAR drama)
    if (pendingIncident.inPenaltyBox) {
      if (rules.enableVAR && Math.random() < 0.35) {
        this.plannedVerdict = Math.random() < 0.78 ? 'penalty_awarded' : 'play_on';
        return {
          targetPos: { x: desiredX, y: 0, z: desiredZ },
          sprint: true,
          facingYaw,
          action: {
            kind: 'startVAR',
            reason: 'تدخل عنيف داخل المنطقة.. الفار يحكم! 📺⚡',
            focusPos: pendingIncident.pos,
            forTeam: pendingIncident.penaltyForTeam,
            suspectId: pendingIncident.offenderId,
          },
        };
      }

      const penaltyReason =
        card === 'red'
          ? 'تدخل قاتل في المنطقة! ضربة جزاء وطرد مباشر! 🟥🎯'
          : card === 'yellow'
            ? 'زحلقة متهورة في المنطقة! ضربة جزاء وإنذار 🟨🎯'
            : 'فاول داخل المنطقة! ضربة جزاء مستحقة 🎯';

      return {
        targetPos: { x: desiredX, y: 0, z: desiredZ },
        sprint: false,
        facingYaw,
        action: {
          kind: 'penalty',
          forTeam: pendingIncident.penaltyForTeam,
          offenderId: pendingIncident.offenderId,
          card,
          reason: penaltyReason,
        },
      };
    }

    // Foul outside penalty box -> Direct Free Kick + appropriate card (none / yellow / red)
    const freeKickReason =
      card === 'red'
        ? 'تدخل قاتل! طرد مباشر وضربة حرة! 🟥😱'
        : card === 'yellow'
          ? 'زحلقة خشنة! كارت أصفر وضربة حرة 🟨📣'
          : 'فاول واضح! ضربة حرة مباشرة 📣⚽';

    return {
      targetPos: { x: desiredX, y: 0, z: desiredZ },
      sprint: false,
      facingYaw,
      action: {
        kind: 'freeKick',
        forTeam: pendingIncident.penaltyForTeam,
        spot: { x: pendingIncident.pos.x, y: 0.24, z: pendingIncident.pos.z },
        offenderId: pendingIncident.offenderId,
        card,
        reason: freeKickReason,
      },
    };
  }

  private pickRandomVARVerdict(): VARVerdict {
    const verdicts: VARVerdict[] = [
      'penalty_awarded',
      'play_on',
      'yellow_for_dive',
      'penalty_awarded',
    ];
    return verdicts[Math.floor(Math.random() * verdicts.length)];
  }
}
