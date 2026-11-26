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

export type AIDifficulty = 'easy' | 'medium' | 'hard';

export type TacticalStance =
  | 'balanced'
  | 'all_out_attack'
  | 'park_the_bus'
  | 'high_press';

export type GraphicsQuality = 'high' | 'medium' | 'low';

export type NetworkMode = 'offline' | 'host' | 'guest';

export type NetworkStatus =
  | 'idle'
  | 'creating'
  | 'waiting_peer'
  | 'connecting'
  | 'connected'
  | 'error';

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
  | 'gk_parry_left'
  | 'gk_parry_right'
  | 'gk_catch'
  | 'ref_whistle'
  | 'ref_yellow_card'
  | 'ref_red_card'
  | 'ref_var_signal'
  | 'red_card_shock'
  | 'walk_of_shame'
  | 'sub_walk_off'
  | 'sub_enter_pitch'
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
  | 'free_kick_setup'
  | 'penalty_setup'
  | 'penalty_shootout'
  | 'var_review'
  | 'red_card_drama'
  | 'substitution_stoppage'
  | 'goal_celebration'
  | 'goal_replay'
  | 'full_time';

export interface AdminRules {
  preset: PresetId;
  aiDifficulty: AIDifficulty;
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
  aiDifficulty: 'medium',
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
  aiDifficulty: 'medium',
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
  /** True when controlled by the remote P2 peer (distinguishes P2 human from local P1 human & AI). */
  isRemoteHuman?: boolean;
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

export type ShotPrecisionZone = 'none' | 'low' | 'good' | 'perfect' | 'overcharge';

export const DEFAULT_HUMAN_SLOT: HumanSlotConfig = {
  team: 'red',
  role: 'outfield',
  positionRole: 'striker',
  controlMode: 'team_switch',
  cameraMode: 'player_third',
  isBenched: false,
};

export const DEFAULT_GUEST_SLOT: HumanSlotConfig = {
  team: 'blue',
  role: 'outfield',
  positionRole: 'striker',
  controlMode: 'team_switch',
  cameraMode: 'player_third',
  isBenched: false,
};

export interface NetworkState {
  mode: NetworkMode;
  status: NetworkStatus;
  roomCode: string;
  peerConnected: boolean;
  pingMs: number;
  voiceActive: boolean;
  micMuted: boolean;
  errorMessage: string | null;
  guestSlot: HumanSlotConfig;
}

export const DEFAULT_NETWORK_STATE: NetworkState = {
  mode: 'offline',
  status: 'idle',
  roomCode: '',
  peerConnected: false,
  pingMs: 0,
  voiceActive: false,
  micMuted: true,
  errorMessage: null,
  guestSlot: { ...DEFAULT_GUEST_SLOT },
};

export interface GoalReplayState {
  active: boolean;
  scoringTeam: TeamId | null;
  scorerName: string;
  elapsed: number;
  duration: number;
}

export const GOAL_REPLAY_DURATION_SEC = 3.0;

export const INITIAL_GOAL_REPLAY_STATE: GoalReplayState = {
  active: false,
  scoringTeam: null,
  scorerName: '',
  elapsed: 0,
  duration: GOAL_REPLAY_DURATION_SEC,
};

/* ─────────────── Football-Law Stoppage & Match Drama Types ─────────────── */

export interface PendingSubstitution {
  team: TeamId;
  outPlayerId: string;
  outPlayerName: string;
  outPlayerNumber: number;
  inPlayerId: string;
  inPlayerName: string;
  inPlayerNumber: number;
  requestedByHumanBench?: boolean;
  actor?: 'host' | 'guest';
}

export interface MatchDramaState {
  kind: 'none' | 'red_card' | 'substitution';
  stage: 'confrontation' | 'walk_off' | 'exchange' | 'enter_pitch';
  team: TeamId;
  primaryPlayerId: string;
  primaryPlayerName: string;
  primaryPlayerNumber: number;
  secondaryPlayerId?: string;
  secondaryPlayerName?: string;
  secondaryPlayerNumber?: number;
  headline: string;
  subtext: string;
  elapsed: number;
  duration: number;
}

export const INITIAL_MATCH_DRAMA_STATE: MatchDramaState = {
  kind: 'none',
  stage: 'confrontation',
  team: 'red',
  primaryPlayerId: '',
  primaryPlayerName: '',
  primaryPlayerNumber: 0,
  headline: '',
  subtext: '',
  elapsed: 0,
  duration: 0,
};

/* ─────────────── Team Play, Coach Discipline, Free Kick & Penalty Shootout Contracts ─────────────── */

export interface CallForPassState {
  active: boolean;
  callerId: string | null;
  callerName: string;
  callerTeam: TeamId | null;
  actor?: 'host' | 'guest';
  remainingSec: number;
  cooldownSec: number;
}

export const CALL_FOR_PASS_WINDOW_SEC = 2.6;
export const CALL_FOR_PASS_COOLDOWN_SEC = 1.4;

export const INITIAL_CALL_FOR_PASS_STATE: CallForPassState = {
  active: false,
  callerId: null,
  callerName: '',
  callerTeam: null,
  remainingSec: 0,
  cooldownSec: 0,
};

export interface CoachDisciplineTeamStats {
  subsUsed: number;
  maxSubs: number;
  cooldownRemainingSec: number;
  lastSubMatchElapsedSec: number | null;
  subbedOutPlayerIds: string[];
}

export type CoachDisciplineStats = Record<TeamId, CoachDisciplineTeamStats>;

export const MAX_SUBS_PER_TEAM = 3;
export const COACH_SUB_COOLDOWN_SEC = 42;
export const MIN_ROUTINE_SUB_ELAPSED_SEC = 35;

export function createInitialCoachDisciplineStats(): CoachDisciplineStats {
  return {
    red: {
      subsUsed: 0,
      maxSubs: MAX_SUBS_PER_TEAM,
      cooldownRemainingSec: 0,
      lastSubMatchElapsedSec: null,
      subbedOutPlayerIds: [],
    },
    blue: {
      subsUsed: 0,
      maxSubs: MAX_SUBS_PER_TEAM,
      cooldownRemainingSec: 0,
      lastSubMatchElapsedSec: null,
      subbedOutPlayerIds: [],
    },
  };
}

export const INITIAL_COACH_DISCIPLINE_STATS: CoachDisciplineStats =
  createInitialCoachDisciplineStats();

export type FreeKickStage = 'whistle_freeze' | 'wall_setup' | 'ready_to_kick';

export interface FreeKickState {
  active: boolean;
  stage: FreeKickStage;
  awardedTeam: TeamId;
  spot: Vec3;
  takerId: string | null;
  takerName: string;
  isHumanTaker: boolean;
  isDirectRange: boolean;
  wallSize: number;
  wallPlayerIds: string[];
  retreatRadiusM: number;
  distanceToGoalM: number;
  reason: string;
  cardShown?: 'none' | 'yellow' | 'red';
  countdownSec: number;
  elapsedSec: number;
}

export const FREE_KICK_RETREAT_RADIUS_M = 8.5;
export const FREE_KICK_WALL_DISTANCE_M = 8.5;
export const FREE_KICK_DIRECT_RANGE_M = 28.0;

export function createInitialFreeKickState(): FreeKickState {
  return {
    active: false,
    stage: 'whistle_freeze',
    awardedTeam: 'red',
    spot: { x: 0, y: 0.42, z: 0 },
    takerId: null,
    takerName: '',
    isHumanTaker: false,
    isDirectRange: false,
    wallSize: 0,
    wallPlayerIds: [],
    retreatRadiusM: FREE_KICK_RETREAT_RADIUS_M,
    distanceToGoalM: 0,
    reason: '',
    cardShown: 'none',
    countdownSec: 0,
    elapsedSec: 0,
  };
}

export const INITIAL_FREE_KICK_STATE: FreeKickState = createInitialFreeKickState();

export type PenaltyKickOutcome = 'pending' | 'scored' | 'saved' | 'missed';

export type PenaltyShootoutStage =
  | 'intro'
  | 'turn_setup'
  | 'awaiting_kick'
  | 'ball_in_flight'
  | 'turn_result'
  | 'sudden_death_banner'
  | 'finished';

export type PenaltyShootoutTurnRole = 'kicker' | 'goalkeeper' | 'spectator';

export interface PenaltyShootoutState {
  active: boolean;
  stage: PenaltyShootoutStage;
  round: number;
  isSuddenDeath: boolean;
  turnIndex: number;
  kickingTeam: TeamId;
  defendingTeam: TeamId;
  humanTurnRole: PenaltyShootoutTurnRole;
  shooterId: string | null;
  shooterName: string;
  gkId: string | null;
  gkName: string;
  rounds: Record<TeamId, PenaltyKickOutcome[]>;
  shootoutScore: Record<TeamId, number>;
  lastOutcome: PenaltyKickOutcome;
  headline: string;
  winner: TeamId | null;
  shotTimerSec: number;
  fromDraw: boolean;
}

export const PENALTY_SHOOTOUT_INITIAL_ROUNDS = 5;

export function createInitialPenaltyShootoutState(): PenaltyShootoutState {
  return {
    active: false,
    stage: 'intro',
    round: 1,
    isSuddenDeath: false,
    turnIndex: 0,
    kickingTeam: 'red',
    defendingTeam: 'blue',
    humanTurnRole: 'kicker',
    shooterId: null,
    shooterName: '',
    gkId: null,
    gkName: '',
    rounds: {
      red: ['pending', 'pending', 'pending', 'pending', 'pending'],
      blue: ['pending', 'pending', 'pending', 'pending', 'pending'],
    },
    shootoutScore: { red: 0, blue: 0 },
    lastOutcome: 'pending',
    headline: '',
    winner: null,
    shotTimerSec: 0,
    fromDraw: false,
  };
}

export const INITIAL_PENALTY_SHOOTOUT_STATE: PenaltyShootoutState =
  createInitialPenaltyShootoutState();

/* ─────────────── v3 Rematch Feel & P2P Timing Constants ─────────────── */

export const MIN_MOUSE_SENSITIVITY = 0.4;
export const MAX_MOUSE_SENSITIVITY = 2.2;
export const DEFAULT_MOUSE_SENSITIVITY = 1.0;

/** Host snapshot broadcast rate (25Hz = 40ms) and Guest input send rate (30Hz = 33ms). */
export const HOST_SNAPSHOT_HZ = 25;
export const GUEST_INPUT_HZ = 30;
/** Guest entity/ball render interpolation buffer (~70ms) and teleport snap threshold (6m). */
export const GUEST_INTERP_DELAY_MS = 70;
export const GUEST_SNAP_DISTANCE_M = 6.0;

/** Rematch feel parameters (`#38`). */
export const LOB_HOLD_THRESHOLD_MS = 180;
export const KNOCK_ON_PUSH_M = 1.4;
export const KNOCK_ON_SPEED_BOOST = 1.22;
export const HIT_STOP_DURATION_SEC = 0.055;

/* ─────────────── Egyptian Quick-Chat Phrases (`B` + `1`..`8`) ─────────────── */

export interface QuickChatPhrase {
  id: string;
  key: string;
  text: string;
  emoji: string;
}

export const QUICK_CHAT_PHRASES: readonly QuickChatPhrase[] = [
  { id: 'pass_selfish', key: '1', text: 'باصي يا أناني!', emoji: '😤' },
  { id: 'rocket_shot', key: '2', text: 'صاروخ أرض جو!', emoji: '🚀' },
  { id: 'ref_bribed', key: '3', text: 'الحكم بايع الماتش!', emoji: '💸' },
  { id: 'check_var', key: '4', text: 'شوف الفار يا كابتن!', emoji: '📺' },
  { id: 'octopus_gk', key: '5', text: 'أنا الأخطبوط!', emoji: '🐙' },
  { id: 'sub_me_in', key: '6', text: 'نزلني هجيب جون!', emoji: '🪑' },
  { id: 'oscar_dive', key: '7', text: 'غطس أوسكار!', emoji: '🎭' },
  { id: 'robbed_goal', key: '8', text: 'حرام دي جون!', emoji: '😭' },
] as const;

export function getQuickChatPhrase(idOrKey: string): QuickChatPhrase | undefined {
  return QUICK_CHAT_PHRASES.find((p) => p.id === idOrKey || p.key === idOrKey);
}

/* ─────────────── Game Commands ─────────────── */

export type GameCommand =
  | { type: 'move'; dx: number; dz: number }
  | { type: 'sprint'; active: boolean }
  | { type: 'pass' }
  | { type: 'callForPass' }
  | { type: 'lobPass'; holdRatio?: number }
  | { type: 'knockOn' }
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
  | { type: 'refFreeKick'; forTeam?: TeamId; spot?: Vec3; reason?: string }
  | { type: 'refStartVAR'; reason?: string }
  | { type: 'refVARVerdict'; verdict: VARVerdict }
  | { type: 'coachSubToBench'; playerId: string }
  | { type: 'coachTactic'; team: TeamId; stance: TacticalStance }
  | { type: 'triggerQueuedSubNow' }
  | { type: 'benchEmote'; kind: 'rage' | 'water' | 'shout' }
  | { type: 'benchRequestReturn' }
  | { type: 'spectatorCheer' }
  | { type: 'spectatorBoo' }
  | { type: 'spectatorFireworks' }
  | { type: 'quickChat'; phraseId: string }
  | { type: 'skipGoalReplay' }
  | { type: 'switchCamera'; camera?: CameraMode }
  | { type: 'sandboxSwitchRole'; role: RoleType; team?: TeamId; benchSelf?: boolean }
  | { type: 'setMouseSensitivity'; value: number }
  | { type: 'setGraphicsQuality'; quality: GraphicsQuality }
  | { type: 'setAIDifficulty'; difficulty: AIDifficulty }
  | { type: 'startMatch' }
  | { type: 'startPenaltyShootout'; fromDraw?: boolean }
  | { type: 'shootoutKick'; dirX: -1 | 0 | 1; power?: number }
  | { type: 'restartMatch' }
  | { type: 'returnToLobby' }
  | { type: 'togglePause' }
  | { type: 'toggleMute' };

export type ComedyEventTone =
  | 'goal'
  | 'card_yellow'
  | 'card_red'
  | 'foul'
  | 'shootout'
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

/* ─────────────── P2P WebRTC Wire Packets (`peerjs`) ─────────────── */

export interface GuestInputPacket {
  seq: number;
  clientTime: number;
  moveDx: number;
  moveDz: number;
  aimAngle: number;
  sprint: boolean;
  commands: GameCommand[];
  slot?: HumanSlotConfig;
}

export interface WorldSnapshotPacket {
  seq: number;
  hostTime: number;
  phase: MatchPhase;
  clockSec: number;
  score: Record<TeamId, number>;
  players: PlayerEntityState[];
  hostControlledId: string | null;
  guestControlledId: string | null;
  ball: BallStateSnapshot & { quat: [number, number, number, number] };
  tactics: Record<TeamId, TacticalStance>;
  varState: VARState;
  goalReplayState: GoalReplayState;
  dramaState?: MatchDramaState;
  pendingSub?: PendingSubstitution | null;
  callForPass?: CallForPassState;
  freeKick?: FreeKickState;
  penaltyShootout?: PenaltyShootoutState;
  coachDiscipline?: CoachDisciplineStats;
  hitStopRemaining: number;
  guestStamina: number;
  guestShotCharge: number;
  guestPrecisionZone: ShotPrecisionZone;
  guestSkillCd: number;
  guestDiveCd: number;
  guestGkDiveCd: number;
  events?: ComedyEvent[];
  sfx?: Array<{ kind: string; power?: number }>;
}

export interface LobbySyncPacket {
  rules: AdminRules;
  hostSlot: HumanSlotConfig;
  guestSlot: HumanSlotConfig;
  phase: MatchPhase;
}

export type PeerWireMessage =
  | { type: 'guest_input'; packet: GuestInputPacket }
  | { type: 'world_snapshot'; snapshot: WorldSnapshotPacket }
  | { type: 'lobby_sync'; packet: LobbySyncPacket }
  | { type: 'guest_slot'; slot: HumanSlotConfig }
  | { type: 'quick_chat'; phraseId: string; sender: 'host' | 'guest'; playerId?: string | null }
  | { type: 'ping'; seq: number; sentAt: number }
  | { type: 'pong'; seq: number; sentAt: number };

/* ─────────────── Dual-Human Slot Conflict Resolution Rules ─────────────── */

/**
 * Dual-Human (P1 Host + P2 Guest) Slot Ownership & Conflict Resolution Rules:
 *
 * 1. **Authoritative Priority**: Host (`hostSlot`) has priority when resolving simultaneous
 *    or conflicting Guest (`guestSlot`) selections.
 * 2. **Single Human Referee**: At most ONE human `referee` is permitted (`rules.enableHumanRef`
 *    must be `true`). If `primarySlot.role === 'referee'`, a second human requesting `referee`
 *    is reassigned to `outfield` (`striker`).
 * 3. **Single Human Goalkeeper / Coach Per Team**: At most ONE human `goalkeeper` and ONE human
 *    `coach` per `TeamId` (`'red'` or `'blue'`). Opposing human GKs (`red` GK vs `blue` GK) are
 *    fully allowed; same-team duplicate `goalkeeper` or `coach` resolves to same-team `outfield`
 *    (`defender`).
 * 4. **Same-Team Outfield Co-Op**: Two humans on the SAME team as `outfield` are allowed and
 *    assigned distinct `OutfieldPosition` roles (`'striker'` vs `'defender'`) so they spawn onto
 *    distinct entities (`hostControlledId !== guestControlledId`).
 * 5. **Team-Switch (`Q`) Mutual Exclusion**: During `switchPlayer`, `MatchEngine` MUST skip any
 *    entity currently controlled by the other human (`entity.id !== otherHumanControlledId`).
 *    In 2v2 (`teamSize === 2`, 1 GK + 1 outfielder per team), same-team co-op cannot put 2 humans
 *    on 1 outfielder—second human on that team resolves to `goalkeeper` if free, else opposite team.
 */
export function isDualHumanSlotConflict(
  primarySlot: HumanSlotConfig,
  candidateRole: RoleType,
  candidateTeam: TeamId,
  candidatePos?: OutfieldPosition,
  rules?: Partial<Pick<AdminRules, 'enableHumanRef' | 'enableCoachBench' | 'teamSize'>>,
): { conflict: boolean; reason?: string } {
  if (candidateRole === 'referee') {
    if (rules?.enableHumanRef === false) {
      return { conflict: true, reason: 'الحكم البشري مقفول في إعدادات الروم' };
    }
    if (primarySlot.role === 'referee') {
      return { conflict: true, reason: 'فيه حكم بشري تاني في الماتش' };
    }
  }

  if (candidateRole === 'coach') {
    if (rules?.enableCoachBench === false) {
      return { conflict: true, reason: 'المدرب مقفول في إعدادات الروم' };
    }
    if (primarySlot.role === 'coach' && primarySlot.team === candidateTeam) {
      return { conflict: true, reason: 'الفريق ده عنده مدرب بشري بالفعل' };
    }
  }

  if (
    candidateRole === 'goalkeeper' &&
    primarySlot.role === 'goalkeeper' &&
    primarySlot.team === candidateTeam &&
    !primarySlot.isBenched
  ) {
    return { conflict: true, reason: 'مرمى الفريق ده محجوز للاعب التاني' };
  }

  if (
    candidateRole === 'outfield' &&
    primarySlot.role === 'outfield' &&
    primarySlot.team === candidateTeam &&
    !primarySlot.isBenched
  ) {
    if (rules?.teamSize === 2) {
      return { conflict: true, reason: 'في نظام 2 ضد 2 يوجد لاعب ميدان واحد فقط لكل فريق' };
    }
    if (candidatePos && primarySlot.positionRole === candidatePos) {
      return { conflict: true, reason: 'المركز ده محجوز لزميلك في الفريق' };
    }
  }

  return { conflict: false };
}

export function resolveDualHumanSlotConflict(
  primarySlot: HumanSlotConfig,
  candidateSlot: HumanSlotConfig,
  rules?: Partial<
    Pick<
      AdminRules,
      'enableHumanRef' | 'enableCoachBench' | 'allowTeamSwitch' | 'allowedCameras' | 'teamSize'
    >
  >,
): HumanSlotConfig {
  const next: HumanSlotConfig = { ...candidateSlot };
  const defaultOutfieldCam: CameraMode =
    rules?.allowedCameras === 'top_only' ? 'broadcast_top' : 'player_third';
  const defaultControl: ControlMode =
    rules?.allowTeamSwitch === false ? 'locked_player' : next.controlMode;

  // 1. Referee conflict -> fallback to outfield
  if (
    next.role === 'referee' &&
    (rules?.enableHumanRef === false || primarySlot.role === 'referee')
  ) {
    next.role = 'outfield';
    next.positionRole = 'striker';
    next.cameraMode = defaultOutfieldCam;
    next.controlMode = defaultControl;
    next.isBenched = false;
  }

  // 2. Coach conflict -> fallback to outfield on same team
  if (
    next.role === 'coach' &&
    (rules?.enableCoachBench === false ||
      (primarySlot.role === 'coach' && primarySlot.team === next.team))
  ) {
    next.role = 'outfield';
    next.positionRole = 'defender';
    next.cameraMode = defaultOutfieldCam;
    next.controlMode = defaultControl;
    next.isBenched = false;
  }

  // 3. Same-team goalkeeper conflict -> fallback to outfield defender on same team
  if (
    next.role === 'goalkeeper' &&
    primarySlot.role === 'goalkeeper' &&
    primarySlot.team === next.team &&
    !primarySlot.isBenched &&
    !next.isBenched
  ) {
    next.role = 'outfield';
    next.positionRole = 'defender';
    next.cameraMode = defaultOutfieldCam;
    next.controlMode = defaultControl;
  }

  // 4. Same-team outfield co-op resolution
  if (
    next.role === 'outfield' &&
    primarySlot.role === 'outfield' &&
    primarySlot.team === next.team &&
    !primarySlot.isBenched &&
    !next.isBenched
  ) {
    if (rules?.teamSize === 2) {
      // Only 1 outfielder exists per team in 2v2: move to free goalkeeper or opposing striker
      next.role = 'goalkeeper';
      next.cameraMode = 'gk_first_person';
      next.controlMode = 'locked_player';
    } else if (primarySlot.positionRole === next.positionRole) {
      next.positionRole = primarySlot.positionRole === 'striker' ? 'defender' : 'striker';
    }
  }

  return next;
}
