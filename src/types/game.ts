export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type TeamId = 'red' | 'blue';

export type RoleType = 'outfield' | 'goalkeeper' | 'referee' | 'coach' | 'spectator';

export type OutfieldPosition = 'striker' | 'defender';

export type ControlMode = 'locked_player' | 'team_switch';

export type CameraMode =
  | 'broadcast_top'
  | 'player_third'
  | 'gk_first_person'
  | 'referee_cam'
  | 'coach_touchline'
  | 'bench_cam'
  | 'stands_cam'
  | 'var_replay_cam';

export type PresetId = 'chaos' | 'classic' | 'custom';

export type TacticalStance =
  | 'balanced'
  | 'all_out_attack'
  | 'park_the_bus'
  | 'high_press';

export type CharacterAnimState =
  | 'idle'
  | 'run'
  | 'sprint'
  | 'kick'
  | 'skill_spin'
  | 'slide_tackle'
  | 'dive_flop'
  | 'protest'
  | 'celebrate'
  | 'gk_dive_left'
  | 'gk_dive_right'
  | 'gk_catch'
  | 'ref_whistle'
  | 'ref_yellow_card'
  | 'ref_red_card'
  | 'ref_var_signal'
  | 'coach_shout'
  | 'sitting_bench'
  | 'bench_rage';

export type VARVerdict =
  | 'goal_valid'
  | 'penalty_awarded'
  | 'play_on'
  | 'yellow_for_dive';

export type MatchPhase =
  | 'menu'
  | 'lobby'
  | 'kickoff'
  | 'playing'
  | 'paused_whistle'
  | 'penalty_setup'
  | 'var_review'
  | 'goal_celebration'
  | 'full_time';

export interface AdminRules {
  preset: PresetId;
  teamSize: 2 | 3;
  matchDurationSec: 120 | 180 | 300;
  allowTeamSwitch: boolean;
  allowedCameras: 'both' | 'top_only' | 'player_only';
  enableHumanRef: boolean;
  freeEgyptianRef: boolean;
  enableVAR: boolean;
  enableCoachBench: boolean;
  enableDivingAndProtests: boolean;
}

export const DEFAULT_CHAOS_RULES: AdminRules = {
  preset: 'chaos',
  teamSize: 3,
  matchDurationSec: 180,
  allowTeamSwitch: true,
  allowedCameras: 'both',
  enableHumanRef: true,
  freeEgyptianRef: true,
  enableVAR: true,
  enableCoachBench: true,
  enableDivingAndProtests: true,
};

export const DEFAULT_CLASSIC_RULES: AdminRules = {
  preset: 'classic',
  teamSize: 3,
  matchDurationSec: 180,
  allowTeamSwitch: true,
  allowedCameras: 'both',
  enableHumanRef: false,
  freeEgyptianRef: false,
  enableVAR: false,
  enableCoachBench: false,
  enableDivingAndProtests: false,
};

export interface PlayerStats {
  pace: number;
  shotPower: number;
  dribble: number;
  diveDrama: number;
  reflexes: number;
}

/**
 * Persistent player profile — upgrade hook for future career progression,
 * cosmetics, and unlockable Egyptian street-football archetypes.
 */
export interface PlayerProfile {
  id: string;
  name: string;
  number: number;
  preferredPosition?: OutfieldPosition;
  stats: PlayerStats;
}

export interface PlayerEntityState {
  id: string;
  name: string;
  number: number;
  team: TeamId | 'ref' | 'neutral';
  role: RoleType;
  positionRole?: OutfieldPosition;
  isHumanControlled: boolean;
  isBenched: boolean;
  isSentOff: boolean;
  yellowCards: number;
  stamina: number;
  animState: CharacterAnimState;
  pos: Vec3;
  rotY: number;
  speechBubble?: string;
  speechTimer?: number;
}

export interface HumanSlotConfig {
  team: TeamId;
  role: RoleType;
  positionRole: OutfieldPosition;
  controlMode: ControlMode;
  cameraMode: CameraMode;
  isBenched: boolean;
}

export const DEFAULT_HUMAN_SLOT: HumanSlotConfig = {
  team: 'red',
  role: 'outfield',
  positionRole: 'striker',
  controlMode: 'team_switch',
  cameraMode: 'broadcast_top',
  isBenched: false,
};

export type GameCommand =
  | { type: 'move'; dx: number; dz: number }
  | { type: 'sprint'; active: boolean }
  | { type: 'pass' }
  | { type: 'shootStart' }
  | { type: 'shootRelease' }
  | { type: 'skillMove' }
  | { type: 'slideTackle' }
  | { type: 'dive' }
  | { type: 'protest' }
  | { type: 'switchPlayer' }
  | { type: 'gkDive'; dir: 'left' | 'right' | 'center' }
  | { type: 'gkThrow' }
  | { type: 'refWhistle' }
  | { type: 'refYellowCard' }
  | { type: 'refRedCard' }
  | { type: 'refPenalty' }
  | { type: 'refStartVAR'; reason?: string }
  | { type: 'refVARVerdict'; verdict: VARVerdict }
  | { type: 'coachSubToBench'; playerId: string }
  | { type: 'coachTactic'; team: TeamId; stance: TacticalStance }
  | { type: 'benchEmote'; kind: 'rage' | 'water' | 'shout' }
  | { type: 'benchRequestReturn' }
  | { type: 'spectatorCheer' }
  | { type: 'spectatorBoo' }
  | { type: 'spectatorFireworks' }
  | { type: 'switchCamera'; camera?: CameraMode }
  | { type: 'sandboxSwitchRole'; role: RoleType; team?: TeamId; benchSelf?: boolean }
  | { type: 'startMatch' }
  | { type: 'restartMatch' }
  | { type: 'returnToLobby' }
  | { type: 'togglePause' }
  | { type: 'toggleMute' };

export type ComedyEventTone =
  | 'goal'
  | 'card_yellow'
  | 'card_red'
  | 'var'
  | 'bench'
  | 'dive'
  | 'tactic'
  | 'crowd';

export interface ComedyEvent {
  id: string;
  timestamp: number;
  text: string;
  icon: string;
  tone: ComedyEventTone;
}

export interface MatchAward {
  title: string;
  playerName: string;
  reason: string;
  emoji: string;
}

export interface VARState {
  active: boolean;
  progress: number;
  reason: string;
  replayElapsed: number;
  replayDuration: number;
}

export interface BallStateSnapshot {
  pos: Vec3;
  vel: Vec3;
  spin: Vec3;
  isSuperShot: boolean;
  lastTouchPlayerId: string | null;
  lastTouchTeam: TeamId | null;
}
