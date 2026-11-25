import * as THREE from 'three';
import { commandBus } from './CommandBus';
import { CameraDirector, type GKDiveVisualState } from './cameras/CameraDirector';
import { ReplayRecorder } from './cameras/ReplayRecorder';
import { InputManager } from './controllers/InputManager';
import { CoachAI } from './ai/CoachAI';
import { GoalkeeperAI } from './ai/GoalkeeperAI';
import { OutfieldAI } from './ai/OutfieldAI';
import { RefereeAI, type RefereeIncident } from './ai/RefereeAI';
import { useGameStore } from '../store/useGameStore';
import type {
  IAimingGuide,
  IBallPhysics,
  ICharacterSystem,
  IEffectsManager,
  IMatchEngine,
  INetworkManager,
  ISoundEngine,
  IStadiumScene,
  QuickChatNetworkEvent,
} from '../types/engine';
import {
  DEFAULT_GUEST_SLOT,
  GOAL_REPLAY_DURATION_SEC,
  GUEST_INPUT_HZ,
  GUEST_INTERP_DELAY_MS,
  GUEST_SNAP_DISTANCE_M,
  HIT_STOP_DURATION_SEC,
  HOST_SNAPSHOT_HZ,
  INITIAL_GOAL_REPLAY_STATE,
  KNOCK_ON_PUSH_M,
  KNOCK_ON_SPEED_BOOST,
  getQuickChatPhrase,
  resolveDualHumanSlotConflict,
  type AdminRules,
  type CameraMode,
  type CharacterAnimState,
  type ComedyEvent,
  type ComedyEventTone,
  type GameCommand,
  type GoalReplayState,
  type GraphicsQuality,
  type GuestInputPacket,
  type HumanSlotConfig,
  type LobbySyncPacket,
  type MatchAward,
  type MatchPhase,
  type NetworkMode,
  type OutfieldPosition,
  type PlayerEntityState,
  type RoleType,
  type ShotPrecisionZone,
  type TacticalStance,
  type TeamId,
  type VARState,
  type VARVerdict,
  type Vec3,
  type WorldSnapshotPacket,
} from '../types/game';

export interface MatchEngineDeps {
  stadium: IStadiumScene;
  characters: ICharacterSystem;
  ball: IBallPhysics;
  effects: IEffectsManager;
  sound: ISoundEngine;
  camera: THREE.PerspectiveCamera;
  domElement?: HTMLElement | null;
  aimingGuide?: IAimingGuide;
  onRender?: () => void;
  onQualityChange?: (quality: GraphicsQuality) => void;
}

type HumanActor = 'host' | 'guest';

interface EntityRuntime {
  entity: PlayerEntityState;
  vx: number;
  vz: number;
  animLockTimer: number;
  kickCooldown: number;
  skillCooldown: number;
  slideCooldown: number;
  diveCooldown: number;
  gkDiveCooldown: number;
  knockOnCooldown: number;
  knockOnBoostTimer: number;
  gkDiveState: GKDiveVisualState;
  gkDiveDirVec: Vec3;
  slideDirVec: Vec3;
  slideTimer: number;
  jukeImmuneTimer: number;
  knockbackVx: number;
  knockbackVz: number;
  knockbackTimer: number;
  benchSlotIndex: number;
  // Match stats for Full-Time Comedy Awards
  goals: number;
  saves: number;
  dives: number;
  tackles: number;
  protests: number;
  redCards: number;
}

interface PenaltyContext {
  attackingTeam: TeamId;
  shooterId: string;
  gkId: string;
  aiKickTimer: number;
}

interface VARContext {
  reason: string;
  focusPos: Vec3;
  attackingTeam: TeamId;
  suspectId: string | null;
  previousCamera: CameraMode;
  previousPhase: MatchPhase;
  replayElapsed: number;
  savedLivePoses: Map<string, { pos: Vec3; rotY: number; animState: CharacterAnimState }>;
  savedBallPos: Vec3;
}

const RED_OUTFIELD_ROSTER: Array<{ name: string; number: number; posRole: OutfieldPosition }> = [
  { name: 'أبو تريكة الصغير', number: 10, posRole: 'striker' },
  { name: 'وائل صخرة', number: 4, posRole: 'defender' },
  { name: 'صلاح السريع', number: 11, posRole: 'striker' },
];

const BLUE_OUTFIELD_ROSTER: Array<{ name: string; number: number; posRole: OutfieldPosition }> = [
  { name: 'شيكابالا الساحر', number: 10, posRole: 'striker' },
  { name: 'حجازي البرج', number: 5, posRole: 'defender' },
  { name: 'مرموش الصاروخ', number: 7, posRole: 'striker' },
];

const PROTEST_LINES = [
  'يا حكم حرام عليك!! 😤',
  'الكورة فاول واضحة يا كابتن! 🗣️',
  'راجع الفار يا عم!! 📺',
  'ده لعب ولا مصارعة?! 😂',
];

const DIVE_LINES = [
  'آآآه رجلي!! ضربة جزاء!! 😭🎭',
  'كسرني يا حكم!! فين الفار?! 🤕',
  'طرت في الهوا يا كابتن!! ✈️',
];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalizeXZ(x: number, z: number): Vec3 {
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: x / len, y: 0, z: z / len };
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Core simulation orchestrator for ElMal3abLife (الملعب لايف).
 * Connects stadium, 3D characters, arcade ball physics, particles, procedural audio,
 * cameras, VAR replay buffer, AI controllers, input manager, and Zustand HUD store.
 */
export class MatchEngine implements IMatchEngine {
  private readonly stadium: IStadiumScene;
  private readonly characters: ICharacterSystem;
  private readonly ball: IBallPhysics;
  private readonly effects: IEffectsManager;
  private readonly rawSound: ISoundEngine;
  private readonly sound: ISoundEngine;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly aimingGuide?: IAimingGuide;
  private readonly onRender?: () => void;
  private readonly onQualityChange?: (quality: GraphicsQuality) => void;

  private readonly cameraDirector: CameraDirector;
  private readonly replayRecorder = new ReplayRecorder();
  private readonly inputManager: InputManager;
  private readonly outfieldAI = new OutfieldAI();
  private readonly gkAI = new GoalkeeperAI();
  private readonly refAI = new RefereeAI();
  private readonly coachAI = new CoachAI();

  private readonly unsubCommandBus: () => void;
  private networkManager: INetworkManager | null = null;
  private netUnsubs: Array<() => void> = [];

  private rafId: number | null = null;
  private lastFrameMs = 0;
  private elapsed = 0;
  private hudSyncAccum = 0;
  private running = false;
  private disposed = false;

  // Match simulation state (preserve 'lobby' across React StrictMode remounts when ?room= redirected)
  private phase: MatchPhase = useGameStore.getState().phase === 'lobby' ? 'lobby' : 'menu';
  private isPaused = false;
  private score: Record<TeamId, number> = { red: 0, blue: 0 };
  private clockSec = 180;
  private tactics: Record<TeamId, TacticalStance> = {
    red: 'balanced',
    blue: 'balanced',
  };
  private humanSlot: HumanSlotConfig = { ...useGameStore.getState().humanSlot };
  private guestSlot: HumanSlotConfig = { ...DEFAULT_GUEST_SLOT };
  private activeCamera: CameraMode = useGameStore.getState().activeCamera;

  private entities: EntityRuntime[] = [];
  private controlledPlayerId: string | null = null;
  private guestControlledId: string | null = null;
  private nearestRefTargetId: string | null = null;
  private possessorId: string | null = null;
  private gkCaughtById: string | null = null;
  private gkCatchHoldTimer = 0;
  private gkSaveGraceTimer = 0;

  // Local (Host / Solo / Guest-local) shot charge, precision aiming & direct move override
  private isChargingShot = false;
  private shotCharge = 0;
  private aimCurl = 0;
  private humanAimDir: Vec3 = { x: 0, y: 0, z: 1 };
  private externalMoveVec: { dx: number; dz: number } | null = null;
  private externalSprint = false;

  // Host-side Guest (P2) input & shot state
  private guestMoveVec: Vec3 = { x: 0, y: 0, z: 0 };
  private guestAimAngle = Math.PI;
  private guestAimDir: Vec3 = { x: 0, y: 0, z: -1 };
  private guestSprint = false;
  private guestIsChargingShot = false;
  private guestShotCharge = 0;
  private guestAimCurl = 0;
  private lastGuestInputSeq = 0;

  // Hit-Stop, 3s Goal Replay & 3D Jumbotron state
  private hitStopRemaining = 0;
  private goalReplayState: GoalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
  private goalReplayFreezeTimer = 0;
  private lastGoalFocusPos: Vec3 = { x: 0, y: 1, z: 0 };
  private replayDisplayPlayers: PlayerEntityState[] | null = null;
  private jumbotronHeadline: string | null = null;
  private jumbotronHeadlineTimer = 0;

  // P2P Host broadcast & Guest interpolation state
  private lastNetworkMode: NetworkMode = 'offline';
  private wasPeerConnected = false;
  private hostSnapshotAccum = 0;
  private hostLobbyCheckAccum = 0;
  private lastSyncedLobbySig = '';
  private snapshotSeq = 0;
  private pendingSnapshotEvents: ComedyEvent[] = [];
  private pendingSnapshotSfx: Array<{ kind: string; power?: number }> = [];

  private guestInputAccum = 0;
  private guestInputSeq = 0;
  private outgoingGuestCommands: GameCommand[] = [];
  private guestSnapshotBuffer: WorldSnapshotPacket[] = [];
  private lastReceivedSnapshotSeq = 0;
  private guestRenderHostTime = 0;
  private guestTimelineInitialized = false;
  private guestHitStopRemaining = 0;
  private guestLocalGKDiveState: GKDiveVisualState = 'none';
  private guestLocalGKDiveTimer = 0;
  private remoteHostControlledId: string | null = null;
  private readonly seenSnapshotEventIds = new Set<string>();
  private readonly localSpeechOverrides = new Map<string, { text: string; remaining: number }>();
  private readonly tmpQuat0 = new THREE.Quaternion();
  private readonly tmpQuat1 = new THREE.Quaternion();
  private readonly tmpQuatOut = new THREE.Quaternion();

  // Phase & event timers
  private kickoffTimer = 0;
  private celebrationTimer = 0;
  private whistlePauseTimer = 0;
  private pendingIncident: RefereeIncident | null = null;
  private penaltyCtx: PenaltyContext | null = null;
  private varCtx: VARContext | null = null;
  private awards: MatchAward[] = [];
  private crowdExcitement = 0.25;

  constructor(deps: MatchEngineDeps) {
    this.stadium = deps.stadium;
    this.characters = deps.characters;
    this.ball = deps.ball;
    this.effects = deps.effects;
    this.rawSound = deps.sound;
    this.sound = this.createTrackedSoundProxy(deps.sound);
    this.camera = deps.camera;
    this.aimingGuide = deps.aimingGuide;
    this.onRender = deps.onRender;
    this.onQualityChange = deps.onQualityChange;

    this.cameraDirector = new CameraDirector(this.camera);
    this.inputManager = new InputManager({
      domElement: deps.domElement,
      onUserGesture: () => this.rawSound.unlock(),
    });

    this.unsubCommandBus = commandBus.subscribe((cmd) => {
      this.dispatchCommand(cmd);
    });

    const initStore = useGameStore.getState();
    this.stadium.setQuality?.(initStore.graphicsQuality);

    // Spawn preview players on the pitch for the cinematic menu/lobby backdrop
    this.spawnRoster(initStore.rules);
    this.positionForKickoff();
    this.ball.reset({ x: 0, y: 0.22, z: 0 });
    this.updateStadiumJumbotron();
    this.syncStoreImmediate();
  }

  private createTrackedSoundProxy(raw: ISoundEngine): ISoundEngine {
    const recordSfx = (kind: string, power?: number): void => {
      if (this.isHostWithGuest() && this.pendingSnapshotSfx.length < 12) {
        this.pendingSnapshotSfx.push(power !== undefined ? { kind, power } : { kind });
      }
    };
    return {
      unlock: () => raw.unlock(),
      setMuted: (muted) => raw.setMuted(muted),
      isMuted: () => raw.isMuted(),
      playWhistle: (type) => {
        raw.playWhistle(type);
        recordSfx(`whistle_${type}`);
      },
      playKick: (power) => {
        raw.playKick(power);
        recordSfx('kick', power);
      },
      playPostClang: () => {
        raw.playPostClang();
        recordSfx('post_clang');
      },
      playGoalCelebration: () => {
        raw.playGoalCelebration();
        recordSfx('goal_celebration');
      },
      playCrowdReaction: (type) => {
        raw.playCrowdReaction(type);
        recordSfx(`crowd_${type}`);
      },
      playCard: (color) => {
        raw.playCard(color);
        recordSfx(`card_${color}`);
      },
      playVARChime: () => {
        raw.playVARChime();
        recordSfx('var_chime');
      },
      playBenchBuzzer: () => {
        raw.playBenchBuzzer();
        recordSfx('bench_buzzer');
      },
      playDiveWhoosh: () => {
        raw.playDiveWhoosh();
        recordSfx('dive_whoosh');
      },
      playFireworks: () => {
        raw.playFireworks();
        recordSfx('fireworks');
      },
      dispose: () => raw.dispose(),
    };
  }

  setNetworkManager(net: INetworkManager | null): void {
    this.clearNetworkSubscriptions();
    this.networkManager = net;
    if (!net || this.disposed) return;

    const addSub = (unsub: (() => void) | void): void => {
      if (typeof unsub === 'function') {
        this.netUnsubs.push(unsub);
      }
    };

    addSub(net.onGuestInput((packet) => this.handleNetworkGuestInput(packet)));
    addSub(net.onSnapshot((snapshot) => this.handleNetworkSnapshot(snapshot)));
    addSub(net.onLobbySync((packet) => this.handleNetworkLobbySync(packet)));
    addSub(net.onGuestSlotUpdate((slot) => this.handleNetworkGuestSlotUpdate(slot)));
    addSub(net.onQuickChat((event) => this.handleNetworkQuickChat(event)));
  }

  private clearNetworkSubscriptions(): void {
    for (const unsub of this.netUnsubs) {
      try {
        unsub();
      } catch {
        // Ignore stale listener cleanup errors
      }
    }
    this.netUnsubs = [];
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  setPaused(paused: boolean): void {
    if (this.phase === 'menu' || this.phase === 'lobby' || this.phase === 'full_time') {
      this.isPaused = false;
    } else {
      this.isPaused = paused;
      if (paused) {
        this.inputManager.exitPointerLock();
      }
    }
    this.syncStoreImmediate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.clearNetworkSubscriptions();
    this.networkManager = null;
    this.unsubCommandBus();
    this.inputManager.dispose();
    this.ball.setTrajectoryVisible(false);
    this.stadium.setVARActive(false);
  }

  dispatchCommand(cmd: GameCommand): void {
    if (this.disposed) return;
    this.rawSound.unlock();

    const store = useGameStore.getState();
    const rules = store.rules;

    // Universal local settings & audio commands (work identically on Offline, Host, and Guest)
    switch (cmd.type) {
      case 'setMouseSensitivity':
        store.setMouseSensitivity(cmd.value);
        return;

      case 'setGraphicsQuality':
        store.setGraphicsQuality(cmd.quality);
        this.stadium.setQuality?.(cmd.quality);
        this.onQualityChange?.(cmd.quality);
        return;

      case 'toggleMute': {
        const nextMuted = !this.rawSound.isMuted();
        this.rawSound.setMuted(nextMuted);
        store.setMuted(nextMuted);
        return;
      }

      case 'quickChat':
        this.handleQuickChatCommand(cmd.phraseId);
        return;
    }

    // Guest-mode command routing: local responsiveness + queued P2P GuestInputPacket commands
    if (store.network.mode === 'guest') {
      this.dispatchGuestLocalCommand(cmd, rules);
      return;
    }

    switch (cmd.type) {
      case 'startMatch':
      case 'restartMatch':
        this.startNewMatch();
        break;

      case 'returnToLobby':
        this.isPaused = false;
        this.varCtx = null;
        this.penaltyCtx = null;
        this.hitStopRemaining = 0;
        this.goalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
        this.replayDisplayPlayers = null;
        this.setJumbotronHeadline(null, 0);
        this.replayRecorder.unfreeze();
        this.stadium.setVARActive(false);
        this.ball.setFrozen(false);
        this.ball.setTrajectoryVisible(false);
        this.hideAimingGuide();
        this.inputManager.exitPointerLock();
        this.phase = 'lobby';
        this.positionForKickoff();
        this.ball.reset({ x: 0, y: 0.42, z: 0 });
        this.updateStadiumJumbotron();
        this.syncStoreImmediate();
        this.broadcastLobbySync();
        break;

      case 'togglePause':
        if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
          this.setPaused(!this.isPaused);
        }
        break;

      case 'move':
        this.externalMoveVec =
          Math.abs(cmd.dx) > 0.01 || Math.abs(cmd.dz) > 0.01
            ? { dx: cmd.dx, dz: cmd.dz }
            : null;
        break;

      case 'sprint':
        this.externalSprint = cmd.active;
        break;

      case 'switchCamera':
        this.handleSwitchCamera(cmd.camera, rules);
        break;

      case 'switchPlayer':
        this.handleSwitchPlayer(rules, 'host');
        break;

      case 'pass':
        this.handleHumanPassOrTackle('host');
        break;

      case 'lobPass':
        this.handleHumanLobPass(cmd.holdRatio ?? 0.5, 'host');
        break;

      case 'knockOn':
        this.handleHumanKnockOn('host');
        break;

      case 'skipGoalReplay':
        if (this.phase === 'goal_replay') {
          this.finishGoalReplayToKickoff();
        }
        break;

      case 'shootStart':
        if (
          !this.humanSlot.isBenched &&
          this.humanSlot.role === 'outfield' &&
          (this.phase === 'playing' || this.phase === 'penalty_setup')
        ) {
          this.isChargingShot = true;
          this.shotCharge = 0.08;
          this.aimCurl = 0;
        }
        break;

      case 'shootRelease':
        if (this.isChargingShot) {
          this.handleHumanShootRelease('host');
          this.isChargingShot = false;
          this.shotCharge = 0;
          this.aimCurl = 0;
        }
        break;

      case 'skillMove':
        this.handleHumanSkillMove('host');
        break;

      case 'slideTackle':
        this.handleHumanSlideTackle('host');
        break;

      case 'dive':
        this.handleHumanDive(rules, 'host');
        break;

      case 'protest':
        this.handleHumanProtest(rules, 'host');
        break;

      case 'gkDive':
        this.handleHumanGKDive(cmd.dir, 'host');
        break;

      case 'gkThrow':
        this.handleHumanGKThrow('host');
        break;

      case 'refWhistle':
        this.handleRefWhistle();
        break;

      case 'refYellowCard':
        this.handleRefCard('yellow', rules);
        break;

      case 'refRedCard':
        this.handleRefCard('red', rules);
        break;

      case 'refPenalty':
        this.handleRefPenalty(rules);
        break;

      case 'refStartVAR':
        this.handleRefStartVAR(rules, cmd.reason);
        break;

      case 'refVARVerdict':
        this.applyVARVerdict(cmd.verdict);
        break;

      case 'coachSubToBench':
        this.handleCoachSubToBench(cmd.playerId, rules);
        break;

      case 'coachTactic':
        this.applyTeamTactic(cmd.team, cmd.stance, true);
        break;

      case 'benchEmote':
        this.handleBenchEmote(cmd.kind, 'host');
        break;

      case 'benchRequestReturn':
        this.handleBenchRequestReturn('host');
        break;

      case 'spectatorCheer':
        this.triggerSpectatorReaction('cheer');
        break;

      case 'spectatorBoo':
        this.triggerSpectatorReaction('boo');
        break;

      case 'spectatorFireworks':
        this.triggerSpectatorReaction('fireworks');
        break;

      case 'sandboxSwitchRole':
        this.handleSandboxSwitchRole(cmd.role, cmd.team, cmd.benchSelf, rules, 'host');
        break;
    }
  }

  private readonly loop = (nowMs: number): void => {
    if (!this.running || this.disposed) return;

    const rawDt = (nowMs - this.lastFrameMs) / 1000;
    this.lastFrameMs = nowMs;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

    this.step(dt);
    this.onRender?.();

    this.rafId = requestAnimationFrame(this.loop);
  };

  private step(dt: number): void {
    const store = useGameStore.getState();
    const netMode = store.network.mode;

    this.reconcileNetworkTransitions(dt, store);

    if (this.jumbotronHeadlineTimer > 0) {
      this.jumbotronHeadlineTimer = Math.max(0, this.jumbotronHeadlineTimer - dt);
      if (this.jumbotronHeadlineTimer <= 0) {
        this.jumbotronHeadline = null;
      }
    }

    // Dedicated Guest interpolated client loop
    if (netMode === 'guest') {
      this.stepGuest(dt);
      return;
    }

    // Sync menu/lobby phase driven externally by UI (e.g. MainMenu -> Lobby)
    if (
      (store.phase === 'menu' || store.phase === 'lobby') &&
      (this.phase === 'menu' || this.phase === 'lobby')
    ) {
      this.phase = store.phase;
    }

    // Only freeze simulation on local pause when solo/offline (keep P2P host live!)
    const freezeForPause = this.isPaused && !this.isHostWithGuest();
    if (this.isPaused || store.isControlsOpen || store.isQuickChatOpen) {
      if (this.inputManager.isPointerLocked() && (this.isPaused || store.isControlsOpen)) {
        this.inputManager.exitPointerLock();
      }
      if (freezeForPause) {
        this.stadium.update(dt * 0.25, this.elapsed);
        this.updateStadiumJumbotron();
        this.updateCameraAndVisuals(dt);
        return;
      }
    }

    this.elapsed += dt;
    this.crowdExcitement = Math.max(0.22, this.crowdExcitement - dt * 0.09);
    this.stadium.setCrowdExcitement(this.crowdExcitement);
    this.stadium.update(dt, this.elapsed);

    // Update speech bubble timers across all entities
    for (const rt of this.entities) {
      if (rt.entity.speechTimer && rt.entity.speechTimer > 0) {
        rt.entity.speechTimer = Math.max(0, rt.entity.speechTimer - dt);
        if (rt.entity.speechTimer <= 0) {
          rt.entity.speechBubble = undefined;
        }
      }
    }

    if (this.phase === 'menu' || this.phase === 'lobby' || this.phase === 'full_time') {
      this.replayDisplayPlayers = null;
      this.ball.setTrajectoryVisible(false);
      this.hideAimingGuide();
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt,
        this.elapsed
      );
      this.effects.update(dt, this.ball.state.pos, false);
      this.updateStadiumJumbotron();
      this.updateCameraAndVisuals(dt);
      this.maybeTickHostSnapshotBroadcast(dt);
      return;
    }

    if (this.phase === 'var_review') {
      this.stepVARReview(dt);
      this.updateStadiumJumbotron();
      this.maybeTickHostSnapshotBroadcast(dt);
      return;
    }

    if (this.phase === 'goal_replay') {
      this.stepGoalReplay(dt);
      this.updateStadiumJumbotron();
      this.maybeTickHostSnapshotBroadcast(dt);
      return;
    }

    // Apply visceral Rematch Hit-Stop scaling (0.12x simulation dt during 55..80ms impact window)
    let simDt = dt;
    if (this.hitStopRemaining > 0) {
      this.hitStopRemaining = Math.max(0, this.hitStopRemaining - dt);
      simDt = dt * 0.12;
    }

    // Active match phases: kickoff, playing, paused_whistle, penalty_setup, goal_celebration
    this.stepActiveMatch(simDt, store.rules, dt);
    this.updateStadiumJumbotron();
    this.maybeTickHostSnapshotBroadcast(dt);
  }

  private stepActiveMatch(dt: number, rules: AdminRules, cameraDt = dt): void {
    const config = this.stadium.config;
    this.replayDisplayPlayers = null;

    // 1. Update timers & phase transitions
    if (this.gkSaveGraceTimer > 0) {
      this.gkSaveGraceTimer = Math.max(0, this.gkSaveGraceTimer - dt);
    }

    if (this.phase === 'kickoff') {
      this.kickoffTimer -= dt;
      if (this.kickoffTimer <= 0) {
        this.phase = 'playing';
        this.sound.playWhistle('short');
        this.syncStoreImmediate();
      }
    } else if (this.phase === 'paused_whistle') {
      this.whistlePauseTimer -= dt;
      if (this.whistlePauseTimer <= 0) {
        this.phase = 'playing';
        this.syncStoreImmediate();
      }
    } else if (this.phase === 'goal_celebration') {
      if (this.goalReplayFreezeTimer > 0) {
        this.goalReplayFreezeTimer -= dt;
        if (this.goalReplayFreezeTimer <= 0) {
          this.replayRecorder.freeze();
        }
      }
      this.celebrationTimer -= dt;
      if (this.celebrationTimer <= 0) {
        this.enterGoalReplay();
        return;
      }
    } else if (this.phase === 'playing') {
      this.clockSec = Math.max(0, this.clockSec - dt);
      if (this.clockSec <= 0) {
        this.finishMatch();
        return;
      }
    } else if (this.phase === 'penalty_setup') {
      this.stepPenaltySetup(dt);
    }

    // 2. Charge human shot(s) & update live free-mouse aim direction + curl spin
    this.updateHumanAimAndCurl(dt);
    if (this.isChargingShot) {
      this.shotCharge = Math.min(1, this.shotCharge + dt * 1.05);
    }
    if (this.guestIsChargingShot) {
      this.guestShotCharge = Math.min(1, this.guestShotCharge + dt * 1.05);
    }

    // 3. Cooldowns on every entity
    for (const rt of this.entities) {
      rt.animLockTimer = Math.max(0, rt.animLockTimer - dt);
      rt.kickCooldown = Math.max(0, rt.kickCooldown - dt);
      rt.skillCooldown = Math.max(0, rt.skillCooldown - dt);
      rt.slideCooldown = Math.max(0, rt.slideCooldown - dt);
      rt.diveCooldown = Math.max(0, rt.diveCooldown - dt);
      rt.gkDiveCooldown = Math.max(0, rt.gkDiveCooldown - dt);
      rt.knockOnCooldown = Math.max(0, rt.knockOnCooldown - dt);
      rt.knockOnBoostTimer = Math.max(0, rt.knockOnBoostTimer - dt);
      rt.jukeImmuneTimer = Math.max(0, rt.jukeImmuneTimer - dt);

      if (rt.slideTimer > 0) {
        rt.slideTimer = Math.max(0, rt.slideTimer - dt);
      }
      if (rt.animLockTimer <= 0 && rt.gkDiveState !== 'none' && rt.gkDiveState !== 'catch') {
        rt.gkDiveState = 'none';
      }
    }

    // 4. Update all entities (Host Human + Guest Human + AI)
    const canMove =
      this.phase === 'playing' ||
      this.phase === 'paused_whistle' ||
      this.phase === 'penalty_setup';

    for (const rt of this.entities) {
      if (rt.entity.isBenched) {
        this.stepBenchedPlayer(rt, dt);
        continue;
      }
      if (rt.entity.isSentOff) {
        this.stepSentOffPlayer(rt);
        continue;
      }
      if (this.phase === 'goal_celebration') {
        this.stepCelebrationEntity(rt, dt);
        continue;
      }

      if (rt.entity.role === 'coach') {
        this.stepCoachEntity(rt, dt, rules);
      } else if (rt.entity.role === 'referee') {
        this.stepRefereeEntity(rt, dt, rules);
      } else if (rt.entity.role === 'goalkeeper') {
        this.stepGoalkeeperEntity(rt, dt, canMove);
      } else if (rt.entity.role === 'outfield') {
        this.stepOutfieldEntity(rt, dt, rules, canMove);
      }
    }

    // Clear pending referee incident after referee evaluated it this tick
    this.pendingIncident = null;

    // 4b. Apply physical knockback momentum & player-vs-player body contact separation
    this.stepKnockbackAndBodyCollisions(dt);

    // 5. Update ball physics + possession + GK catches/saves + goal detection
    this.stepBallAndInteractions(dt);

    // 6. Compute nearest target for Referee HUD
    this.updateNearestRefTarget();

    // 7. Record replay frame for VAR & 3s Goal Replay slow-motion playback
    if (
      (this.phase === 'playing' || this.phase === 'goal_celebration' || this.phase === 'penalty_setup') &&
      !this.replayRecorder.isFrozen()
    ) {
      const ballVis = this.ball.getVisualTransform();
      this.replayRecorder.record(
        dt,
        {
          pos: ballVis.pos,
          quat: ballVis.quat,
          isSuperShot: this.ball.state.isSuperShot,
        },
        this.entities.map((e) => e.entity)
      );
    }

    // 8. Sync 3D characters, particles, aiming guide, trajectory line, and camera
    this.updateBallTrajectoryGuide();
    this.updateAimingGuideVisual();
    this.characters.syncPlayers(
      this.entities.map((e) => e.entity),
      dt,
      this.elapsed
    );
    this.effects.update(dt, this.ball.state.pos, this.ball.state.isSuperShot);
    this.updateCameraAndVisuals(cameraDt);

    // 9. Throttled HUD store sync (~20Hz)
    this.hudSyncAccum += cameraDt;
    if (this.hudSyncAccum >= 0.05) {
      this.hudSyncAccum = 0;
      this.syncStoreImmediate();
    }

    // Keep bounds clamped for sanity
    for (const rt of this.entities) {
      if (rt.entity.role === 'outfield' && !rt.entity.isBenched && !rt.entity.isSentOff) {
        rt.entity.pos.x = clamp(rt.entity.pos.x, -config.halfWidth + 0.7, config.halfWidth - 0.7);
        rt.entity.pos.z = clamp(rt.entity.pos.z, -config.halfLength + 0.8, config.halfLength - 0.8);
      }
    }
  }

  private stepVARReview(dt: number): void {
    const varCtx = this.varCtx;
    if (!varCtx) {
      this.phase = 'playing';
      return;
    }

    varCtx.replayElapsed += dt;

    // Sample 0.35x slow-motion replay frame from the 4-second ring buffer!
    const sampled = this.replayRecorder.sampleAt(varCtx.replayElapsed, 0.35);
    let focusPos = varCtx.focusPos;

    if (sampled) {
      this.ball.setFrozen(true);
      this.ball.applyVisualTransform(sampled.ball.pos, sampled.ball.quat);
      focusPos = sampled.ball.pos;

      const frameById = new Map(sampled.players.map((p) => [p.id, p]));
      const replayPlayers: PlayerEntityState[] = this.entities.map((rt) => {
        const snap = frameById.get(rt.entity.id);
        if (!snap) return rt.entity;
        return {
          ...rt.entity,
          pos: { ...snap.pos },
          rotY: snap.rotY,
          animState: snap.animState,
        };
      });

      this.replayDisplayPlayers = replayPlayers;
      this.characters.syncPlayers(replayPlayers, dt * 0.35, this.elapsed);
      this.effects.update(dt * 0.35, sampled.ball.pos, sampled.ball.isSuperShot);
    } else {
      this.replayDisplayPlayers = null;
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt * 0.35,
        this.elapsed
      );
      this.effects.update(dt * 0.35, this.ball.state.pos, false);
    }

    // Let AI Referee deliberate and issue a verdict ONLY if neither Host nor Guest is human referee
    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    const anyHumanRef =
      (this.humanSlot.role === 'referee' && !this.humanSlot.isBenched) ||
      (this.isHostWithGuest() && this.guestSlot.role === 'referee' && !this.guestSlot.isBenched);

    if (refRt) {
      const refDecision = this.refAI.evaluate({
        ref: refRt.entity,
        ballPos: focusPos,
        config: this.stadium.config,
        rules: useGameStore.getState().rules,
        isHumanRef: anyHumanRef,
        inVARReview: true,
        varElapsed: varCtx.replayElapsed,
        pendingIncident: null,
        dt,
      });

      if (refDecision.action.kind === 'varVerdict') {
        this.applyVARVerdict(refDecision.action.verdict);
        return;
      }
    }

    // Drive dramatic VAR replay camera
    const freeLook = this.inputManager.getFreeLook();
    this.hideAimingGuide();
    this.cameraDirector.update(dt, this.elapsed, {
      phase: 'var_review',
      cameraMode: 'var_replay_cam',
      config: this.stadium.config,
      ballPos: focusPos,
      ballVel: { x: 0, y: 0, z: 0 },
      controlledPlayer: this.getControlledRuntime()?.entity ?? null,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
      freeYaw: freeLook.yaw,
      freePitch: freeLook.pitch,
      isSprinting: false,
      gkDiveState: 'none',
      benchSeatPos: this.getHumanBenchSeatPos(),
      varFocusPos: focusPos,
    });
    this.characters.updateFPGloves(this.camera, false, 'none', dt);

    this.hudSyncAccum += dt;
    if (this.hudSyncAccum >= 0.05) {
      this.hudSyncAccum = 0;
      this.syncStoreImmediate();
    }
  }

  private stepOutfieldEntity(
    rt: EntityRuntime,
    dt: number,
    rules: AdminRules,
    canMove: boolean
  ): void {
    const p = rt.entity;

    // During penalty setup, keep non-shooter outfielders still
    if (this.phase === 'penalty_setup') {
      if (this.penaltyCtx?.shooterId === p.id) {
        if (p.isHumanControlled) {
          const move = this.getHumanMoveInput();
          const aimAngle = p.team === 'red' ? 0 : Math.PI;
          p.rotY = aimAngle - move.dx * 0.35;
        } else if (p.isRemoteHuman) {
          p.rotY = this.guestAimAngle;
        }
      }
      if (rt.animLockTimer <= 0) p.animState = 'idle';
      return;
    }

    if (!canMove) {
      if (rt.animLockTimer <= 0) p.animState = 'idle';
      return;
    }

    // Active physical knockback launch from slide-tackle collision
    if (rt.knockbackTimer > 0) {
      return;
    }

    // Active slide tackle lunge overrides normal movement
    if (rt.slideTimer > 0) {
      const slideSpeed = 13.5;
      p.pos.x += rt.slideDirVec.x * slideSpeed * dt;
      p.pos.z += rt.slideDirVec.z * slideSpeed * dt;
      p.animState = 'slide_tackle';
      this.checkSlideTackleImpact(rt);
      return;
    }

    // Locked in dive_flop or protest -> stay put until animation completes
    if (rt.animLockTimer > 0 && (p.animState === 'dive_flop' || p.animState === 'protest')) {
      return;
    }

    if (p.isHumanControlled) {
      const rawMove = this.getHumanMoveInput();
      const sprinting =
        (this.inputManager.isSprinting() || this.externalSprint || rt.knockOnBoostTimer > 0) &&
        p.stamina > 4;
      const axes = this.cameraDirector.getHorizontalAxes();

      // Convert camera-relative input (dx right, dz forward) into world XZ!
      let worldX = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
      let worldZ = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
      const moveNorm = normalizeXZ(worldX, worldZ);
      worldX = moveNorm.x;
      worldZ = moveNorm.z;

      const moving = Math.hypot(worldX, worldZ) > 0.05;
      const baseSpeed = 8.4;
      const sprintBonus = sprinting ? 3.8 : 0;
      const skillBonus = rt.jukeImmuneTimer > 0 ? 2.4 : 0;
      const knockOnMult = rt.knockOnBoostTimer > 0 ? KNOCK_ON_SPEED_BOOST : 1.0;
      const speed = moving ? (baseSpeed + sprintBonus + skillBonus) * knockOnMult : 0;

      p.pos.x += worldX * speed * dt;
      p.pos.z += worldZ * speed * dt;
      rt.vx = worldX * speed;
      rt.vz = worldZ * speed;

      if (moving && !this.isChargingShot) {
        const targetYaw = Math.atan2(worldX, worldZ);
        p.rotY = lerpAngle(p.rotY, targetYaw, 1 - Math.exp(-14 * dt));
      } else if (this.activeCamera === 'player_third' || this.isChargingShot) {
        const aimYaw = Math.atan2(this.humanAimDir.x, this.humanAimDir.z);
        p.rotY = lerpAngle(p.rotY, aimYaw, 1 - Math.exp(-16 * dt));
      }

      // Stamina drain/regen
      if (moving && sprinting && rt.knockOnBoostTimer <= 0) {
        p.stamina = Math.max(0, p.stamina - 22 * dt);
      } else {
        p.stamina = Math.min(100, p.stamina + (moving ? 9 : 18) * dt);
      }

      if (rt.animLockTimer <= 0) {
        p.animState = moving ? (sprinting ? 'sprint' : 'run') : 'idle';
      }
      return;
    }

    // Remote P2 Human-controlled outfielder (Host-authoritative simulation, never run AI!)
    if (p.isRemoteHuman) {
      const moveNorm = normalizeXZ(this.guestMoveVec.x, this.guestMoveVec.z);
      const worldX = moveNorm.x;
      const worldZ = moveNorm.z;
      const sprinting = (this.guestSprint || rt.knockOnBoostTimer > 0) && p.stamina > 4;
      const moving = Math.hypot(worldX, worldZ) > 0.05;
      const baseSpeed = 8.4;
      const sprintBonus = sprinting ? 3.8 : 0;
      const skillBonus = rt.jukeImmuneTimer > 0 ? 2.4 : 0;
      const knockOnMult = rt.knockOnBoostTimer > 0 ? KNOCK_ON_SPEED_BOOST : 1.0;
      const speed = moving ? (baseSpeed + sprintBonus + skillBonus) * knockOnMult : 0;

      p.pos.x += worldX * speed * dt;
      p.pos.z += worldZ * speed * dt;
      rt.vx = worldX * speed;
      rt.vz = worldZ * speed;

      if (moving && !this.guestIsChargingShot) {
        const targetYaw = Math.atan2(worldX, worldZ);
        p.rotY = lerpAngle(p.rotY, targetYaw, 1 - Math.exp(-14 * dt));
      } else {
        p.rotY = lerpAngle(p.rotY, this.guestAimAngle, 1 - Math.exp(-16 * dt));
      }

      if (moving && sprinting && rt.knockOnBoostTimer <= 0) {
        p.stamina = Math.max(0, p.stamina - 22 * dt);
      } else {
        p.stamina = Math.min(100, p.stamina + (moving ? 9 : 18) * dt);
      }

      if (rt.animLockTimer <= 0) {
        p.animState = moving ? (sprinting ? 'sprint' : 'run') : 'idle';
      }
      return;
    }

    // AI-controlled outfielder!
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const decision = this.outfieldAI.evaluate({
      player: p,
      allPlayers: this.entities.map((e) => e.entity),
      ballPos: this.ball.state.pos,
      ballVel: this.ball.state.vel,
      possessorId: this.possessorId,
      stance: this.tactics[team],
      config: this.stadium.config,
      rules,
      humanRole: this.humanSlot.role,
      humanTeam: this.humanSlot.team,
      dt,
      elapsed: this.elapsed,
    });

    const moving = Math.hypot(decision.moveDir.x, decision.moveDir.z) > 0.05;
    const sprinting = decision.sprint && p.stamina > 8;
    const speed = moving ? (sprinting ? 10.6 : 7.5) : 0;

    p.pos.x += decision.moveDir.x * speed * dt;
    p.pos.z += decision.moveDir.z * speed * dt;
    rt.vx = decision.moveDir.x * speed;
    rt.vz = decision.moveDir.z * speed;

    if (moving) {
      const targetYaw = Math.atan2(decision.moveDir.x, decision.moveDir.z);
      p.rotY = lerpAngle(p.rotY, targetYaw, 1 - Math.exp(-12 * dt));
    }

    if (moving && sprinting) {
      p.stamina = Math.max(0, p.stamina - 14 * dt);
    } else {
      p.stamina = Math.min(100, p.stamina + 11 * dt);
    }

    if (rt.animLockTimer <= 0) {
      p.animState = moving ? (sprinting ? 'sprint' : 'run') : 'idle';
    }

    // Execute AI action
    switch (decision.action.kind) {
      case 'kick': {
        const act = decision.action;
        this.performKick(rt, act.dir, act.power, act.lift, act.isSuperShot);
        break;
      }
      case 'slideTackle':
        this.performSlideTackle(rt, decision.action.dir);
        break;
      case 'skillMove':
        this.performSkillMove(rt);
        break;
      case 'dive':
        this.performDive(rt);
        break;
      case 'protest':
        this.performProtest(rt);
        break;
      case 'none':
        break;
    }
  }

  private stepGoalkeeperEntity(rt: EntityRuntime, dt: number, canMove: boolean): void {
    const gk = rt.entity;
    const config = this.stadium.config;
    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    const forwardZ = team === 'red' ? 1 : -1;
    const goalLineZ = team === 'red' ? -config.halfLength + 1.0 : config.halfLength - 1.0;

    const minZ = team === 'red' ? -config.halfLength + 0.6 : config.halfLength - 7.5;
    const maxZ = team === 'red' ? -config.halfLength + 7.5 : config.halfLength - 0.6;
    const maxX = config.goalWidth * 0.56;

    // Active GK dive lunge
    if (rt.animLockTimer > 0 && (rt.gkDiveState === 'left' || rt.gkDiveState === 'right')) {
      const diveSpeed = 10.5;
      gk.pos.x = clamp(gk.pos.x + rt.gkDiveDirVec.x * diveSpeed * dt, -maxX - 1.2, maxX + 1.2);
      gk.pos.z = clamp(gk.pos.z + rt.gkDiveDirVec.z * diveSpeed * dt, minZ, maxZ);
      return;
    }

    if (!canMove) {
      if (rt.animLockTimer <= 0) gk.animState = 'idle';
      return;
    }

    if (gk.isHumanControlled || gk.isRemoteHuman) {
      let dir: Vec3;
      if (gk.isHumanControlled) {
        const rawMove = this.getHumanMoveInput();
        const axes = this.cameraDirector.getHorizontalAxes();
        const wx = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
        const wz = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
        dir = normalizeXZ(wx, wz);
      } else {
        dir = normalizeXZ(this.guestMoveVec.x, this.guestMoveVec.z);
      }
      const moving = Math.hypot(dir.x, dir.z) > 0.05;
      const speed = moving ? 7.6 : 0;

      gk.pos.x = clamp(gk.pos.x + dir.x * speed * dt, -maxX, maxX);
      gk.pos.z = clamp(gk.pos.z + dir.z * speed * dt, minZ, maxZ);
      gk.rotY = team === 'red' ? 0 : Math.PI;

      if (rt.animLockTimer <= 0) {
        gk.animState =
          this.gkCaughtById === gk.id ? 'gk_catch' : moving ? 'run' : 'idle';
      }
      return;
    }

    // AI Goalkeeper
    const teammates = this.entities
      .filter((e) => e.entity.team === team)
      .map((e) => e.entity);

    const decision = this.gkAI.evaluate({
      gk,
      ballPos: this.ball.state.pos,
      ballVel: this.ball.state.vel,
      config,
      hasCaughtBall: this.gkCaughtById === gk.id,
      teammates,
      diveCooldown: rt.gkDiveCooldown,
      dt,
    });

    if (decision.throwDir && this.gkCaughtById === gk.id) {
      this.releaseGKCatch(rt, decision.throwDir);
      return;
    }

    if (decision.diveDir !== 'none' && rt.gkDiveCooldown <= 0) {
      this.performGKDive(rt, decision.diveDir);
      return;
    }

    const dx = decision.targetPos.x - gk.pos.x;
    const dz = decision.targetPos.z - gk.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.15) {
      const speed = decision.sprint ? 7.8 : 5.4;
      const stepDist = Math.min(dist, speed * dt);
      gk.pos.x = clamp(gk.pos.x + (dx / dist) * stepDist, -maxX - 1.5, maxX + 1.5);
      gk.pos.z = clamp(gk.pos.z + (dz / dist) * stepDist, minZ - 1, maxZ + 1);
      if (rt.animLockTimer <= 0) {
        gk.animState = this.gkCaughtById === gk.id ? 'gk_catch' : 'run';
      }
    } else if (rt.animLockTimer <= 0) {
      gk.animState = this.gkCaughtById === gk.id ? 'gk_catch' : 'idle';
    }

    gk.rotY = lerpAngle(gk.rotY, decision.facingYaw, 1 - Math.exp(-10 * dt));
    // Keep GK near goal line during penalty setup
    if (this.phase === 'penalty_setup') {
      gk.pos.z = goalLineZ;
      gk.rotY = forwardZ > 0 ? 0 : Math.PI;
    }
  }

  private stepRefereeEntity(rt: EntityRuntime, dt: number, rules: AdminRules): void {
    const ref = rt.entity;
    const config = this.stadium.config;

    if (ref.isHumanControlled || ref.isRemoteHuman) {
      let dir: Vec3;
      let sprinting: boolean;
      if (ref.isHumanControlled) {
        const rawMove = this.getHumanMoveInput();
        const axes = this.cameraDirector.getHorizontalAxes();
        const wx = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
        const wz = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
        dir = normalizeXZ(wx, wz);
        sprinting = this.inputManager.isSprinting() || this.externalSprint;
      } else {
        dir = normalizeXZ(this.guestMoveVec.x, this.guestMoveVec.z);
        sprinting = this.guestSprint;
      }
      const moving = Math.hypot(dir.x, dir.z) > 0.05;
      const speed = moving ? (sprinting ? 11.2 : 8.0) : 0;

      ref.pos.x = clamp(ref.pos.x + dir.x * speed * dt, -config.halfWidth - 2, config.halfWidth + 1);
      ref.pos.z = clamp(ref.pos.z + dir.z * speed * dt, -config.halfLength + 1, config.halfLength - 1);
      if (moving) {
        ref.rotY = lerpAngle(ref.rotY, Math.atan2(dir.x, dir.z), 1 - Math.exp(-12 * dt));
      }
      if (rt.animLockTimer <= 0) {
        ref.animState = moving ? (sprinting ? 'sprint' : 'run') : 'idle';
      }
      return;
    }

    // AI Referee
    const decision = this.refAI.evaluate({
      ref,
      ballPos: this.ball.state.pos,
      config,
      rules,
      isHumanRef: false,
      inVARReview: false,
      varElapsed: 0,
      pendingIncident: this.pendingIncident,
      dt,
    });

    const dx = decision.targetPos.x - ref.pos.x;
    const dz = decision.targetPos.z - ref.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.4) {
      const speed = decision.sprint ? 8.5 : 5.8;
      const stepDist = Math.min(dist, speed * dt);
      ref.pos.x += (dx / dist) * stepDist;
      ref.pos.z += (dz / dist) * stepDist;
      if (rt.animLockTimer <= 0) ref.animState = decision.sprint ? 'sprint' : 'run';
    } else if (rt.animLockTimer <= 0) {
      ref.animState = 'idle';
    }
    ref.rotY = lerpAngle(ref.rotY, decision.facingYaw, 1 - Math.exp(-9 * dt));

    // Execute AI Referee decisions!
    switch (decision.action.kind) {
      case 'yellowCard':
        this.issueCardToPlayer(decision.action.targetId, 'yellow', decision.action.reason);
        break;
      case 'redCard':
        this.issueCardToPlayer(decision.action.targetId, 'red', decision.action.reason);
        break;
      case 'penalty':
        this.startPenaltyKick(decision.action.forTeam, decision.action.reason);
        break;
      case 'startVAR':
        this.enterVARReview(
          decision.action.reason,
          decision.action.focusPos,
          decision.action.forTeam,
          decision.action.suspectId
        );
        break;
      case 'none':
      case 'varVerdict':
        break;
    }
  }

  private stepCoachEntity(rt: EntityRuntime, dt: number, rules: AdminRules): void {
    const coach = rt.entity;
    const team: TeamId = coach.team === 'blue' ? 'blue' : 'red';
    const isHumanCoach =
      (this.humanSlot.role === 'coach' &&
        this.humanSlot.team === team &&
        !this.humanSlot.isBenched) ||
      (this.isHostWithGuest() &&
        this.guestSlot.role === 'coach' &&
        this.guestSlot.team === team &&
        !this.guestSlot.isBenched);

    const decision = this.coachAI.evaluate({
      coach,
      team,
      teamPlayers: this.entities
        .filter((e) => e.entity.team === team)
        .map((e) => e.entity),
      score: this.score,
      clockSec: this.clockSec,
      currentStance: this.tactics[team],
      config: this.stadium.config,
      rules,
      isHumanCoach,
      dt,
      elapsed: this.elapsed,
    });

    const dx = decision.targetPos.x - coach.pos.x;
    const dz = decision.targetPos.z - coach.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.1) {
      const stepDist = Math.min(dist, 2.2 * dt);
      coach.pos.x += (dx / dist) * stepDist;
      coach.pos.z += (dz / dist) * stepDist;
      if (rt.animLockTimer <= 0) coach.animState = 'run';
    } else if (rt.animLockTimer <= 0) {
      coach.animState = 'idle';
    }
    coach.rotY = decision.facingYaw;

    switch (decision.action.kind) {
      case 'shout':
        coach.animState = 'coach_shout';
        rt.animLockTimer = 1.1;
        this.setSpeech(rt, decision.action.text, 2.8);
        break;
      case 'setTactic':
        coach.animState = 'coach_shout';
        rt.animLockTimer = 1.3;
        this.setSpeech(rt, decision.action.shoutText, 3.2);
        this.applyTeamTactic(team, decision.action.stance, false);
        break;
      case 'subToBench':
        coach.animState = 'coach_shout';
        rt.animLockTimer = 1.3;
        this.setSpeech(rt, decision.action.shoutText, 3.2);
        this.handleCoachSubToBench(decision.action.playerId, rules);
        break;
      case 'none':
        break;
    }
  }

  private stepBenchedPlayer(rt: EntityRuntime, dt: number): void {
    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const seat = this.stadium.getBenchSeatPosition(team, rt.benchSlotIndex);
    p.pos.x = seat.x;
    p.pos.y = seat.y;
    p.pos.z = seat.z;
    p.rotY = -Math.PI / 2;
    p.stamina = Math.min(100, p.stamina + 18 * dt);
    if (rt.animLockTimer <= 0) {
      p.animState = 'sitting_bench';
    }
  }

  private stepSentOffPlayer(rt: EntityRuntime): void {
    const p = rt.entity;
    // Stand gloomily behind the -X touchline tunnel
    p.pos.x = -this.stadium.config.halfWidth - 5.5;
    p.pos.y = 0;
    p.pos.z = p.team === 'red' ? -18 : 18;
    p.rotY = Math.PI / 2;
    p.animState = 'protest';
  }

  private stepCelebrationEntity(rt: EntityRuntime, dt: number): void {
    const p = rt.entity;
    if (p.role === 'coach' || p.role === 'referee') {
      if (rt.animLockTimer <= 0) p.animState = 'idle';
      return;
    }
    if (p.animState === 'celebrate') {
      p.rotY += dt * 1.6;
    }
  }

  private stepPenaltySetup(dt: number): void {
    const pen = this.penaltyCtx;
    if (!pen) return;

    const shooter = this.entities.find((e) => e.entity.id === pen.shooterId);
    if (!shooter) {
      this.phase = 'playing';
      this.penaltyCtx = null;
      return;
    }

    // If AI is taking the penalty (neither Host nor Guest human), count down tension beat then fire!
    if (!shooter.entity.isHumanControlled && !shooter.entity.isRemoteHuman) {
      pen.aiKickTimer -= dt;
      if (pen.aiKickTimer <= 0) {
        const targetGoalZ =
          pen.attackingTeam === 'red'
            ? this.stadium.config.halfLength
            : -this.stadium.config.halfLength;
        const cornerSign = Math.random() < 0.5 ? -1 : 1;
        const aimX = cornerSign * (this.stadium.config.goalWidth * (0.26 + Math.random() * 0.16));
        const dir = normalizeXZ(aimX - this.ball.state.pos.x, targetGoalZ - this.ball.state.pos.z);
        this.performKick(shooter, dir, 27 + Math.random() * 5, 0.24, true);
        this.phase = 'playing';
        this.penaltyCtx = null;
        this.syncStoreImmediate();
      }
    }
  }

  private stepBallAndInteractions(dt: number): void {
    const config = this.stadium.config;

    // 1. If a GK is holding a caught ball, keep ball glued in front of GK hands
    if (this.gkCaughtById) {
      const gkRt = this.entities.find((e) => e.entity.id === this.gkCaughtById);
      if (gkRt && !gkRt.entity.isBenched && !gkRt.entity.isSentOff) {
        const forwardZ = gkRt.entity.team === 'red' ? 1 : -1;
        this.ball.setPositionAndStop({
          x: gkRt.entity.pos.x + Math.sin(gkRt.entity.rotY) * 0.65,
          y: 1.15,
          z: gkRt.entity.pos.z + forwardZ * 0.65,
        });
        this.gkCatchHoldTimer += dt;
        // Auto-release after 3.5s for human GK (Host or Guest) so play never stalls
        if (
          (gkRt.entity.isHumanControlled || gkRt.entity.isRemoteHuman) &&
          this.gkCatchHoldTimer >= 3.5
        ) {
          this.releaseGKCatch(gkRt, { x: 0, y: 0, z: forwardZ });
        }
        return;
      } else {
        this.gkCaughtById = null;
      }
    }

    // 2. Sync solid player capsule colliders into Rapier3D, then step ball physics
    if (this.ball.syncPlayerColliders) {
      this.ball.syncPlayerColliders(
        this.entities.map((rt) => ({
          id: rt.entity.id,
          pos: rt.entity.pos,
          vx: rt.vx,
          vz: rt.vz,
          active:
            (rt.entity.role === 'outfield' || rt.entity.role === 'goalkeeper') &&
            !rt.entity.isBenched &&
            !rt.entity.isSentOff,
          isKickerCooldown:
            rt.kickCooldown > 0 || this.possessorId === rt.entity.id,
        }))
      );
    }

    const tick = this.ball.update(dt, config);
    const ballPos = this.ball.state.pos;
    const ballSpeed = tick.speed;

    if (tick.hitPost) {
      this.sound.playPostClang();
      this.sound.playCrowdReaction('ooh');
      this.cameraDirector.triggerShake(0.32, 0.25);
      this.effects.spawnBurst(ballPos, 0xfbbf24, 18, 4.5);
      this.pushEvent('في العارضة!! يا ساتر يا رب! 😱🥅', '🥅', 'crowd');
    }

    if (tick.goalScored && this.phase === 'playing') {
      this.handleGoalScored(tick.goalScored);
      return;
    }

    if (this.phase !== 'playing') {
      this.possessorId = null;
      return;
    }

    // 3. Check Goalkeeper saves & catches!
    if (this.gkSaveGraceTimer <= 0) {
      for (const rt of this.entities) {
        const gk = rt.entity;
        if (gk.role !== 'goalkeeper' || gk.isBenched || gk.isSentOff) continue;

        const isDiving = rt.gkDiveState === 'left' || rt.gkDiveState === 'right';
        const isHumanGK = gk.isHumanControlled || Boolean(gk.isRemoteHuman);
        // Generous arcade save radius, especially rewarding for human FP GK!
        const reachXZ = isDiving
          ? isHumanGK
            ? 3.1
            : 2.35
          : isHumanGK
            ? 1.95
            : 1.65;
        const reachY = isDiving ? 2.65 : 2.35;

        const d = distXZ(gk.pos, ballPos);
        if (d <= reachXZ && ballPos.y <= reachY) {
          this.handleGoalkeeperSave(rt, ballSpeed);
          return;
        }
      }
    }

    // 4. Outfield soft possession & natural arcade dribbling
    let closestCarrier: EntityRuntime | null = null;
    let closestDist = 1.28;

    for (const rt of this.entities) {
      const p = rt.entity;
      if (
        p.role !== 'outfield' ||
        p.isBenched ||
        p.isSentOff ||
        rt.kickCooldown > 0 ||
        p.animState === 'dive_flop' ||
        p.animState === 'slide_tackle'
      ) {
        continue;
      }

      const d = distXZ(p.pos, ballPos);
      if (d < closestDist && ballPos.y < 1.35) {
        // Respect juke immunity when current possessor just did a skill spin
        if (
          this.possessorId &&
          this.possessorId !== p.id &&
          this.entities.some(
            (e) =>
              e.entity.id === this.possessorId &&
              e.jukeImmuneTimer > 0 &&
              distXZ(e.entity.pos, ballPos) < 1.6
          )
        ) {
          continue;
        }
        closestDist = d;
        closestCarrier = rt;
      }
    }

    if (closestCarrier) {
      this.possessorId = closestCarrier.entity.id;
      const p = closestCarrier.entity;
      const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
      const leadX = p.isHumanControlled
        ? this.humanAimDir.x
        : p.isRemoteHuman
          ? this.guestAimDir.x
          : Math.sin(p.rotY);
      const leadZ = p.isHumanControlled
        ? this.humanAimDir.z
        : p.isRemoteHuman
          ? this.guestAimDir.z
          : Math.cos(p.rotY);
      const dribbleAnchor: Vec3 = {
        x: p.pos.x + leadX * 0.98,
        y: 0.42,
        z: p.pos.z + leadZ * 0.98,
      };
      const toAnchorX = dribbleAnchor.x - ballPos.x;
      const toAnchorZ = dribbleAnchor.z - ballPos.z;
      const toAnchorDist = Math.hypot(toAnchorX, toAnchorZ);
      const playerSpeed = Math.hypot(closestCarrier.vx, closestCarrier.vz);

      if (this.ball.applyDribbleVelocity) {
        const targetVel: Vec3 = {
          x: clamp(toAnchorX * 8.5 + closestCarrier.vx, -16, 16),
          y: 0,
          z: clamp(toAnchorZ * 8.5 + closestCarrier.vz, -16, 16),
        };
        this.ball.applyDribbleVelocity(targetVel, p.id, team);
      } else if (toAnchorDist > 0.14 || playerSpeed > 0.5) {
        const dir = normalizeXZ(
          toAnchorX * 4.5 + closestCarrier.vx,
          toAnchorZ * 4.5 + closestCarrier.vz
        );
        const guideSpeed = clamp(playerSpeed * 1.12 + toAnchorDist * 4.5, 2.2, 13.5);
        this.ball.kick(dir, guideSpeed, 0, false, p.id, team);
      }
    } else if (this.possessorId) {
      const current = this.entities.find((e) => e.entity.id === this.possessorId);
      if (!current || distXZ(current.entity.pos, ballPos) > 1.75 || ballPos.y > 1.6) {
        this.possessorId = null;
      }
    }
  }

  private handleGoalkeeperSave(gkRt: EntityRuntime, incomingSpeed: number): void {
    const gk = gkRt.entity;
    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    const forwardZ = team === 'red' ? 1 : -1;
    const isDiving = gkRt.gkDiveState === 'left' || gkRt.gkDiveState === 'right';

    gkRt.saves += 1;
    this.possessorId = null;
    this.gkSaveGraceTimer = 0.55;

    // Rematch visceral Hit-Stop + extra burst on diving GK saves!
    if (isDiving) {
      this.triggerHitStop(0.08);
      this.effects.spawnBurst(this.ball.state.pos, 0x38bdf8, 26, 5.4);
      this.cameraDirector.triggerShake(0.35, 0.24);
    }

    if (incomingSpeed > 11 || isDiving) {
      this.sound.playCrowdReaction('cheer');
      this.crowdExcitement = Math.min(1, this.crowdExcitement + 0.5);
      this.effects.spawnBurst(this.ball.state.pos, 0x10b981, 22, 5);
      this.cameraDirector.triggerShake(0.28, 0.22);
      this.pushEvent(`تصدّي خرافي من ${gk.name}! سد منيع 🧤🔥`, '🧤', 'crowd');
      this.setSpeech(gkRt, 'مفيش كورة هتعدّي! 🧤', 2.2);
    }

    // Super shots get parried wide; regular shots get cleanly caught!
    if (this.ball.state.isSuperShot && incomingSpeed > 22) {
      const parrySide = this.ball.state.pos.x >= gk.pos.x ? 1 : -1;
      const parryDir = normalizeXZ(parrySide * 0.85, forwardZ * 0.65);
      this.ball.kick(parryDir, 15, 0.3, false, gk.id, team);
      this.sound.playKick(0.75);
    } else {
      this.gkCaughtById = gk.id;
      this.gkCatchHoldTimer = 0;
      gkRt.gkDiveState = 'catch';
      gk.animState = 'gk_catch';
      gkRt.animLockTimer = 0.45;
      this.ball.setPositionAndStop({
        x: gk.pos.x,
        y: 1.15,
        z: gk.pos.z + forwardZ * 0.65,
      });
    }
  }

  private releaseGKCatch(gkRt: EntityRuntime, dir: Vec3): void {
    const gk = gkRt.entity;
    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    this.gkCaughtById = null;
    this.gkCatchHoldTimer = 0;
    this.gkSaveGraceTimer = 0.65;
    gkRt.gkDiveState = 'none';
    gk.animState = 'kick';
    gkRt.animLockTimer = 0.35;
    this.ball.kick(dir, 23, 0.32, false, gk.id, team);
    this.sound.playKick(0.7);
  }

  private handleGoalScored(scoringTeam: TeamId): void {
    this.score[scoringTeam] += 1;
    const concedingTeam: TeamId = scoringTeam === 'red' ? 'blue' : 'red';

    // Credit goal to last touch player on scoring team, or nearest scoring striker
    let scorer = this.entities.find(
      (e) =>
        e.entity.id === this.ball.state.lastTouchPlayerId &&
        e.entity.team === scoringTeam
    );
    if (!scorer) {
      scorer = this.entities
        .filter((e) => e.entity.team === scoringTeam && e.entity.role === 'outfield' && !e.entity.isBenched)
        .sort((a, b) => distXZ(a.entity.pos, this.ball.state.pos) - distXZ(b.entity.pos, this.ball.state.pos))[0];
    }
    if (scorer) {
      scorer.goals += 1;
    }

    this.lastGoalFocusPos = { ...this.ball.state.pos };
    this.stadium.triggerGoalNetRipple(concedingTeam, this.ball.state.pos);
    this.stadium.triggerGoalCelebration(scoringTeam);
    this.sound.playGoalCelebration();
    this.effects.spawnFireworks(
      { x: this.ball.state.pos.x, y: 5, z: this.ball.state.pos.z },
      scoringTeam === 'red' ? 0xff2e4c : 0x00c2ff
    );
    this.cameraDirector.triggerShake(0.65, 0.55);
    this.crowdExcitement = 1.0;

    // Trigger player animations
    for (const rt of this.entities) {
      if (rt.entity.isBenched || rt.entity.isSentOff || rt.entity.role === 'coach' || rt.entity.role === 'referee') {
        continue;
      }
      if (rt.entity.team === scoringTeam) {
        rt.entity.animState = 'celebrate';
        rt.animLockTimer = 1.8;
      } else {
        rt.entity.animState = 'protest';
        rt.animLockTimer = 1.8;
      }
    }

    const teamLabel = scoringTeam === 'red' ? 'النسور الحمر 🔴' : 'موج بحري 🔵';
    const scorerName = scorer ? scorer.entity.name : teamLabel;
    this.pushEvent(
      `جووووول عالمي!! ${scorerName} يهز الشباك لصالح ${teamLabel}! ⚽🔥`,
      '⚽',
      'goal'
    );
    if (scorer) {
      this.setSpeech(scorer, 'جوووول يا بلد!! 🔥⚽', 2.8);
    }

    this.goalReplayState = {
      active: false,
      scoringTeam,
      scorerName,
      elapsed: 0,
      duration: GOAL_REPLAY_DURATION_SEC,
    };
    this.goalReplayFreezeTimer = 0.35;
    this.setJumbotronHeadline('جووووول عالمي! ⚽🔥', 5.0);

    this.possessorId = null;
    this.gkCaughtById = null;
    this.isChargingShot = false;
    this.shotCharge = 0;
    this.guestIsChargingShot = false;
    this.guestShotCharge = 0;
    this.phase = 'goal_celebration';
    this.celebrationTimer = 1.7;
    this.syncStoreImmediate();
    this.broadcastWorldSnapshot();
  }

  private handleHumanPassOrTackle(actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.entity.isBenched || rt.entity.isSentOff) return;

    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const aimRaw = actor === 'host' ? this.humanAimDir : this.guestAimDir;
    const slot = this.getActorSlot(actor);
    const otherHumanId = this.getOtherActorControlledId(actor);
    const dBall = distXZ(p.pos, this.ball.state.pos);

    if (this.phase === 'penalty_setup' && this.penaltyCtx?.shooterId === p.id) {
      const dir = normalizeXZ(aimRaw.x, aimRaw.z);
      this.performKick(rt, dir, 24, 3.6, false);
      this.phase = 'playing';
      this.penaltyCtx = null;
      this.syncStoreImmediate();
      return;
    }

    // If close to ball -> Aimed Pass strictly along humanAimDir (snapping onto teammate inside cone)
    if (dBall < 2.65 && this.ball.state.pos.y < 1.9) {
      const aim = normalizeXZ(aimRaw.x, aimRaw.z);
      const bestTarget = this.findAimedPassTarget(rt, aim);

      const passDir = bestTarget
        ? normalizeXZ(bestTarget.entity.pos.x - p.pos.x, bestTarget.entity.pos.z - p.pos.z)
        : aim;
      const dist = bestTarget ? distXZ(p.pos, bestTarget.entity.pos) : 14;
      const power = clamp(14 + dist * 0.52, 16, 24);

      this.performKick(rt, passDir, power, 1.4, false);

      // PES auto-switch to pass receiver when team_switch is active (skipping the other human!)
      const rules = useGameStore.getState().rules;
      if (
        bestTarget &&
        bestTarget.entity.id !== otherHumanId &&
        rules.allowTeamSwitch &&
        slot.controlMode === 'team_switch'
      ) {
        this.assignActorControlTo(actor, bestTarget.entity.id);
      }
      return;
    }

    // Otherwise -> standing tackle / lunge toward ball!
    const toBall = normalizeXZ(this.ball.state.pos.x - p.pos.x, this.ball.state.pos.z - p.pos.z);
    p.pos.x += toBall.x * 1.05;
    p.pos.z += toBall.z * 1.05;
    p.rotY = Math.atan2(toBall.x, toBall.z);
    p.animState = 'kick';
    rt.animLockTimer = 0.28;

    if (distXZ(p.pos, this.ball.state.pos) < 2.2) {
      this.possessorId = null;
      this.ball.kick(toBall, 11, 1.1, false, p.id, team);
      this.sound.playKick(0.45);
      rt.tackles += 1;
    }
  }

  private handleHumanLobPass(holdRatio = 0.5, actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.entity.isBenched || rt.entity.isSentOff) return;

    const p = rt.entity;
    const r = clamp(holdRatio, 0, 1);
    const aimRaw = actor === 'host' ? this.humanAimDir : this.guestAimDir;
    const curlRaw = actor === 'host' ? this.aimCurl : this.guestAimCurl;
    const slot = this.getActorSlot(actor);
    const otherHumanId = this.getOtherActorControlledId(actor);
    const aim = normalizeXZ(aimRaw.x, aimRaw.z);

    if (this.phase === 'penalty_setup' && this.penaltyCtx?.shooterId === p.id) {
      const power = 16 + r * 6;
      const lift = 6.4 + r * 2.4;
      const curlSpinY = curlRaw * 12;
      this.performKickWithSpin(rt, aim, power, lift, curlSpinY, false);
      this.phase = 'playing';
      this.penaltyCtx = null;
      this.syncStoreImmediate();
      return;
    }

    const dBall = distXZ(p.pos, this.ball.state.pos);
    if (dBall < 2.75 && this.ball.state.pos.y < 2.0) {
      const bestTarget = this.findAimedPassTarget(rt, aim);
      const leadPos = bestTarget
        ? {
            x: bestTarget.entity.pos.x + bestTarget.vx * 0.32,
            y: 0,
            z: bestTarget.entity.pos.z + bestTarget.vz * 0.32,
          }
        : null;
      const lobDir = leadPos
        ? normalizeXZ(leadPos.x - p.pos.x, leadPos.z - p.pos.z)
        : aim;
      const dist = leadPos ? distXZ(p.pos, leadPos) : 14 + r * 10;

      const power = clamp(16 + r * 6 + (leadPos ? clamp((dist - 12) * 0.18, -1.2, 1.5) : 0), 16, 22);
      const lift = clamp(6.4 + r * 2.4, 6.4, 8.8);
      const crossY = aim.x * lobDir.z - aim.z * lobDir.x;
      const lateralBias = clamp(curlRaw + crossY * 2.2, -1, 1);
      const curlSpinY =
        Math.abs(lateralBias) > 0.04
          ? lateralBias * 14
          : (lobDir.x >= 0 ? 1 : -1) * (4.5 + r * 4.5);

      this.performKickWithSpin(rt, lobDir, power, lift, curlSpinY, false);
      this.effects.spawnBurst(this.ball.state.pos, 0x38bdf8, 10, 2.4);

      const rules = useGameStore.getState().rules;
      if (
        bestTarget &&
        bestTarget.entity.id !== otherHumanId &&
        rules.allowTeamSwitch &&
        slot.controlMode === 'team_switch'
      ) {
        this.assignActorControlTo(actor, bestTarget.entity.id);
      }
      return;
    }

    // Fallback to standing tackle if defending off the ball
    this.handleHumanPassOrTackle(actor);
  }

  private handleHumanKnockOn(actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing') return;
    const rt = this.getActorRuntime(actor);
    if (
      !rt ||
      rt.entity.role !== 'outfield' ||
      rt.entity.isBenched ||
      rt.entity.isSentOff ||
      rt.knockOnCooldown > 0
    ) {
      return;
    }

    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    let moveDir: Vec3;
    if (actor === 'host') {
      const rawMove = this.getHumanMoveInput();
      const axes = this.cameraDirector.getHorizontalAxes();
      moveDir = normalizeXZ(
        axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz,
        axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz
      );
    } else {
      moveDir = normalizeXZ(this.guestMoveVec.x, this.guestMoveVec.z);
    }

    if (Math.hypot(moveDir.x, moveDir.z) < 0.05 && Math.hypot(rt.vx, rt.vz) > 0.4) {
      moveDir = normalizeXZ(rt.vx, rt.vz);
    }
    if (Math.hypot(moveDir.x, moveDir.z) < 0.05) {
      return;
    }

    const dBall = distXZ(p.pos, this.ball.state.pos);
    if (dBall > 2.0 || this.ball.state.pos.y > 1.65) {
      return;
    }

    const config = this.stadium.config;
    const pushedPos: Vec3 = {
      x: clamp(p.pos.x + moveDir.x * KNOCK_ON_PUSH_M, -config.halfWidth + 0.6, config.halfWidth - 0.6),
      y: Math.max(0.24, this.ball.state.pos.y),
      z: clamp(p.pos.z + moveDir.z * KNOCK_ON_PUSH_M, -config.halfLength + 0.6, config.halfLength - 0.6),
    };

    rt.knockOnCooldown = 0.9;
    rt.knockOnBoostTimer = 0.38;
    rt.kickCooldown = 0.22;
    this.possessorId = null;

    this.ball.setPositionAndStop(pushedPos);
    this.ball.kick(moveDir, 10.2, 0.35, false, p.id, team);
    p.rotY = Math.atan2(moveDir.x, moveDir.z);
    p.animState = 'sprint';

    this.effects.spawnSlideDust(p.pos);
    this.effects.spawnBurst(pushedPos, 0xffffff, 8, 2.0);
    this.sound.playKick(0.38);
  }

  private handleHumanShootRelease(actor: HumanActor = 'host'): void {
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.entity.isBenched || rt.entity.isSentOff) return;
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;

    const p = rt.entity;
    const dBall = distXZ(p.pos, this.ball.state.pos);
    if (dBall > 2.95 && this.phase !== 'penalty_setup') return;

    const aimRaw = actor === 'host' ? this.humanAimDir : this.guestAimDir;
    const charge = actor === 'host' ? this.shotCharge : this.guestShotCharge;
    const curl = actor === 'host' ? this.aimCurl : this.guestAimCurl;

    // Fire strictly along the 3D aiming arrow direction!
    const dir = normalizeXZ(aimRaw.x, aimRaw.z);
    const zone = this.computePrecisionZone(charge, true);
    const isSweet = zone === 'perfect';
    const isOver = zone === 'overcharge';

    const speedMult = isSweet ? 1.22 : 1.0;
    const power = (18 + charge * 18) * speedMult;
    const liftVel = 3.2 + charge * 5.8 + (isOver ? 5.2 : 0);
    const curlSpinY = (isSweet ? 22 : 14) * curl;
    const isSuperShot = isSweet || charge >= 0.78;

    this.performKickWithSpin(rt, dir, power, liftVel, curlSpinY, isSuperShot);

    if (isSweet) {
      this.triggerHitStop(0.08);
      this.cameraDirector.triggerShake(0.38, 0.24);
      this.effects.spawnBurst(this.ball.state.pos, 0x34d399, 28, 5.6);
      this.effects.spawnBurst(this.ball.state.pos, 0xfbbf24, 14, 4.0);
      this.setJumbotronHeadline('في المقص يا معلم! 🎯', 2.4);
      this.pushEvent('تسديدة في المقص! دقة مثالية 🎯🔥', '🎯', 'crowd');
    } else if (isOver) {
      this.pushEvent('شاطها في المدرجات! خفّ إيدك شوية 😂🚀', '🚀', 'crowd');
    }

    if (this.phase === 'penalty_setup') {
      this.phase = 'playing';
      this.penaltyCtx = null;
      this.syncStoreImmediate();
    }
  }

  private handleHumanSkillMove(actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing') return;
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.skillCooldown > 0) return;
    this.performSkillMove(rt);
  }

  private handleHumanSlideTackle(actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing') return;
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.slideCooldown > 0) return;
    const dir = { x: Math.sin(rt.entity.rotY), y: 0, z: Math.cos(rt.entity.rotY) };
    this.performSlideTackle(rt, dir);
  }

  private handleHumanDive(rules: AdminRules, actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing') return;
    if (!rules.enableDivingAndProtests) {
      this.pushEvent('التمثيل والغطس مقفولين بقرار الأدمن 🚫', '🚫', 'dive');
      return;
    }
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield' || rt.diveCooldown > 0) return;
    this.performDive(rt);
  }

  private handleHumanProtest(rules: AdminRules, actor: HumanActor = 'host'): void {
    if (!rules.enableDivingAndProtests) {
      this.pushEvent('الاعتراض والشغب مقفولين في النظام الكلاسيك 🚫', '🚫', 'dive');
      return;
    }
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'outfield') return;
    this.performProtest(rt);
  }

  private handleHumanGKDive(dir: 'left' | 'right' | 'center', actor: HumanActor = 'host'): void {
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'goalkeeper' || rt.gkDiveCooldown > 0) return;
    this.performGKDive(rt, dir);
  }

  private handleHumanGKThrow(actor: HumanActor = 'host'): void {
    const rt = this.getActorRuntime(actor);
    if (!rt || rt.entity.role !== 'goalkeeper') return;
    if (this.gkCaughtById !== rt.entity.id) {
      // Allow quick punt if loose ball is right at GK's feet
      if (distXZ(rt.entity.pos, this.ball.state.pos) < 2.2) {
        const forwardZ = rt.entity.team === 'red' ? 1 : -1;
        this.performKick(rt, { x: 0, y: 0, z: forwardZ }, 24, 0.34, false);
      }
      return;
    }
    const throwDir =
      actor === 'host'
        ? this.cameraDirector.getHorizontalAxes().forward
        : normalizeXZ(this.guestAimDir.x, this.guestAimDir.z);
    const fallbackZ = rt.entity.team === 'red' ? 1 : -1;
    const safeDir =
      Math.hypot(throwDir.x, throwDir.z) > 0.05 ? throwDir : { x: 0, y: 0, z: fallbackZ };
    this.releaseGKCatch(rt, safeDir);
  }

  private handleSwitchPlayer(rules: AdminRules, actor: HumanActor = 'host'): void {
    const slot = this.getActorSlot(actor);
    if (!rules.allowTeamSwitch || slot.controlMode === 'locked_player') {
      if (actor === 'host') {
        this.pushEvent('تبديل اللعيبة مقفول — أنت مقفول على لاعب واحد 🔒', '🔒', 'tactic');
      }
      return;
    }
    if (slot.role !== 'outfield' || slot.isBenched) return;

    const currentId = actor === 'host' ? this.controlledPlayerId : this.guestControlledId;
    const otherHumanId = this.getOtherActorControlledId(actor);

    const candidates = this.entities
      .filter(
        (e) =>
          e.entity.team === slot.team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff &&
          e.entity.id !== otherHumanId
      )
      .sort(
        (a, b) =>
          distXZ(a.entity.pos, this.ball.state.pos) -
          distXZ(b.entity.pos, this.ball.state.pos)
      );

    if (candidates.length === 0) return;
    const next =
      candidates.find((c) => c.entity.id !== currentId) ?? candidates[0];
    if (next.entity.id === currentId) return;

    this.assignActorControlTo(actor, next.entity.id);
    this.syncStoreImmediate();
  }

  private handleSwitchCamera(explicit: CameraMode | undefined, rules: AdminRules): void {
    // Goalkeeper is ALWAYS strictly locked to first-person!
    if (this.humanSlot.role === 'goalkeeper' && !this.humanSlot.isBenched) {
      this.activeCamera = 'gk_first_person';
      this.humanSlot.cameraMode = 'gk_first_person';
      this.syncStoreImmediate();
      return;
    }

    if (this.humanSlot.isBenched) {
      this.activeCamera = explicit === 'broadcast_top' ? 'broadcast_top' : 'bench_cam';
      this.humanSlot.cameraMode = this.activeCamera;
      this.syncStoreImmediate();
      return;
    }

    let nextCam: CameraMode = this.activeCamera;

    if (this.humanSlot.role === 'outfield') {
      if (rules.allowedCameras === 'top_only') {
        nextCam = 'broadcast_top';
      } else if (rules.allowedCameras === 'player_only') {
        nextCam = 'player_third';
      } else if (explicit === 'broadcast_top' || explicit === 'player_third') {
        nextCam = explicit;
      } else {
        nextCam =
          this.activeCamera === 'broadcast_top' ? 'player_third' : 'broadcast_top';
      }
    } else if (this.humanSlot.role === 'spectator') {
      nextCam =
        explicit === 'stands_cam' || explicit === 'broadcast_top'
          ? explicit
          : this.activeCamera === 'stands_cam'
            ? 'broadcast_top'
            : 'stands_cam';
    } else if (this.humanSlot.role === 'referee') {
      nextCam =
        explicit === 'referee_cam' || explicit === 'broadcast_top'
          ? explicit
          : this.activeCamera === 'referee_cam'
            ? 'broadcast_top'
            : 'referee_cam';
    } else if (this.humanSlot.role === 'coach') {
      nextCam =
        explicit === 'coach_touchline' || explicit === 'broadcast_top'
          ? explicit
          : this.activeCamera === 'coach_touchline'
            ? 'broadcast_top'
            : 'coach_touchline';
    }

    const prevCam = this.activeCamera;
    this.activeCamera = nextCam;
    this.humanSlot.cameraMode = nextCam;
    if (nextCam === 'player_third' && prevCam !== 'player_third') {
      const rt = this.getControlledRuntime();
      if (rt) {
        this.inputManager.setFreeYaw(rt.entity.rotY);
      }
    }
    if (
      nextCam !== 'player_third' &&
      nextCam !== 'gk_first_person' &&
      nextCam !== 'referee_cam'
    ) {
      this.inputManager.exitPointerLock();
    }
    this.syncStoreImmediate();
  }

  private handleRefWhistle(): void {
    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    if (refRt) {
      refRt.entity.animState = 'ref_whistle';
      refRt.animLockTimer = 0.7;
      this.setSpeech(refRt, 'صفّارة! وقف اللعب! 🏁', 2.0);
    }

    if (this.phase === 'playing') {
      this.sound.playWhistle('double');
      this.phase = 'paused_whistle';
      this.whistlePauseTimer = 2.0;
      this.pushEvent('الحكم صفّر ووقف الماتش! 🏁', '🏁', 'card_yellow');
      this.syncStoreImmediate();
    } else if (this.phase === 'paused_whistle') {
      this.sound.playWhistle('short');
      this.phase = 'playing';
      this.whistlePauseTimer = 0;
      this.syncStoreImmediate();
    } else {
      this.sound.playWhistle('short');
    }
  }

  private handleRefCard(color: 'yellow' | 'red', rules: AdminRules): void {
    if (!rules.freeEgyptianRef && !this.pendingIncident && this.phase === 'playing') {
      this.pushEvent('التحكيم الحر مقفول — استنى مخالفة أو فعّل التحكيم المصري! ⚖️', '⚖️', 'card_yellow');
      return;
    }

    this.updateNearestRefTarget();
    const targetId = this.nearestRefTargetId;
    if (!targetId) {
      this.pushEvent('قرّب من أي لاعب عشان ترفع له الكارت! 🏃🟨', '🟨', 'card_yellow');
      return;
    }

    const reason =
      color === 'yellow'
        ? 'كارت أصفر بمزاج الحكم المصري! 🟨😂'
        : 'طرد أحمر مباشر! برّه يا كابتن! 🟥😱';
    this.issueCardToPlayer(targetId, color, reason);
  }

  private handleRefPenalty(rules: AdminRules): void {
    if (!rules.freeEgyptianRef && !this.pendingIncident) {
      this.pushEvent('فعّل «تحكيم مصري حر» عشان تدي بلنتيات بمزاجك! 😂', '🎯', 'var');
      return;
    }

    // Award penalty to whichever team's opponent goal the ball is closer to
    const attackingTeam: TeamId = this.ball.state.pos.z >= 0 ? 'red' : 'blue';
    this.startPenaltyKick(
      attackingTeam,
      'بلنتي على مزاج الحكم المصري!! الملعب بيغلي 😂🎯'
    );
  }

  private handleRefStartVAR(rules: AdminRules, reason?: string): void {
    if (!rules.enableVAR) {
      this.pushEvent('غرفة الفار VAR مقفولة في إعدادات الروم 📺🚫', '📺', 'var');
      return;
    }
    if (this.phase === 'var_review') return;

    const attackingTeam: TeamId = this.ball.state.pos.z >= 0 ? 'red' : 'blue';
    this.enterVARReview(
      reason ?? 'الحكم رايح يراجع شاشة الفار بنفسه! 📺🔥',
      { ...this.ball.state.pos },
      attackingTeam,
      this.nearestRefTargetId
    );
  }

  private handleCoachSubToBench(playerId: string, rules: AdminRules): void {
    if (!rules.enableCoachBench) {
      this.pushEvent('تبديلات الدكة مقفولة بقرار الأدمن 🪑🚫', '🪑', 'bench');
      return;
    }

    const targetRt = this.entities.find((e) => e.entity.id === playerId);
    if (
      !targetRt ||
      targetRt.entity.role !== 'outfield' ||
      targetRt.entity.isBenched ||
      targetRt.entity.isSentOff
    ) {
      return;
    }

    const team: TeamId = targetRt.entity.team === 'blue' ? 'blue' : 'red';
    const reserveRt = this.entities.find(
      (e) =>
        e.entity.team === team &&
        e.entity.role === 'outfield' &&
        e.entity.isBenched &&
        !e.entity.isSentOff
    );
    if (!reserveRt) {
      this.pushEvent('مفيش بدلاء جاهزين على الدكة حالياً! 🪑', '🪑', 'bench');
      return;
    }

    const oldPos = { ...targetRt.entity.pos };
    const seatIdx = reserveRt.benchSlotIndex >= 0 ? reserveRt.benchSlotIndex : 0;

    // Move target physically onto 3D dugout bench
    targetRt.entity.isBenched = true;
    targetRt.benchSlotIndex = seatIdx;
    const seatPos = this.stadium.getBenchSeatPosition(team, seatIdx);
    targetRt.entity.pos = { ...seatPos };
    targetRt.entity.rotY = -Math.PI / 2;
    targetRt.entity.animState = 'sitting_bench';

    // Bring reserve onto pitch
    reserveRt.entity.isBenched = false;
    reserveRt.benchSlotIndex = -1;
    reserveRt.entity.pos = { ...oldPos };
    reserveRt.entity.stamina = 100;
    reserveRt.entity.animState = 'run';

    if (this.possessorId === targetRt.entity.id) {
      this.possessorId = null;
    }

    // If the benched player was Host-controlled -> switch into 3D Bench Cam!
    if (targetRt.entity.isHumanControlled) {
      this.humanSlot.isBenched = true;
      this.activeCamera = 'bench_cam';
      this.humanSlot.cameraMode = 'bench_cam';
      this.inputManager.exitPointerLock();
      this.cameraDirector.snapNextFrame();
    }

    // If the benched player was Guest-controlled -> update Guest slot to Bench Cam!
    if (targetRt.entity.isRemoteHuman) {
      this.guestSlot.isBenched = true;
      this.guestSlot.cameraMode = 'bench_cam';
      useGameStore.getState().setGuestSlot(this.guestSlot);
      this.broadcastLobbySync();
    }

    this.sound.playBenchBuzzer();
    this.setSpeech(targetRt, 'ليه كده يا كوتش?! أنا لسه قادر! 🪑🤬', 3.0);
    this.setSpeech(reserveRt, 'يلا بينا نقلب الماتش! 🔥', 2.4);
    this.pushEvent(
      `تبديل ناري! ${targetRt.entity.name} طلع دكة ونزل ${reserveRt.entity.name}! 🪑🔥`,
      '🪑',
      'bench'
    );
    this.syncStoreImmediate();
  }

  private handleBenchEmote(kind: 'rage' | 'water' | 'shout', actor: HumanActor = 'host'): void {
    const rt = this.getActorRuntime(actor);
    if (!rt) return;

    if (kind === 'rage') {
      rt.entity.animState = 'bench_rage';
      rt.animLockTimer = 1.4;
      this.setSpeech(rt, 'حرام عليك يا كوتش! نزلني الملعب! 🤬🪑', 2.8);
      this.effects.spawnBurst(rt.entity.pos, 0xff2e4c, 14, 3);
      this.pushEvent(`${rt.entity.name} بيشوّح بغضب من على الدكة! 🤬🪑`, '🤬', 'bench');
    } else if (kind === 'water') {
      rt.entity.animState = 'sitting_bench';
      rt.entity.stamina = 100;
      this.setSpeech(rt, 'مية ساقعة تهدّي الأعصاب 💧😌', 2.5);
      this.effects.spawnBurst(rt.entity.pos, 0x00c2ff, 12, 2.5);
    } else {
      rt.entity.animState = 'bench_rage';
      rt.animLockTimer = 1.1;
      this.setSpeech(rt, 'يا كوتش أنا جاهز أجيب جون! 📢⚽', 2.6);
      this.sound.playCrowdReaction('ooh');
    }
    this.syncStoreImmediate();
  }

  private handleBenchRequestReturn(actor: HumanActor = 'host'): void {
    const slot = this.getActorSlot(actor);
    if (!slot.isBenched) return;
    const benchedHuman = this.getActorRuntime(actor);
    if (!benchedHuman) return;

    const otherHumanId = this.getOtherActorControlledId(actor);
    const team: TeamId = slot.team;
    const swapOut = this.entities.find(
      (e) =>
        e.entity.team === team &&
        e.entity.role === 'outfield' &&
        !e.entity.isBenched &&
        !e.entity.isSentOff &&
        e.entity.id !== benchedHuman.entity.id &&
        e.entity.id !== otherHumanId
    );

    const seatIdx = benchedHuman.benchSlotIndex >= 0 ? benchedHuman.benchSlotIndex : 0;
    const returnPos: Vec3 = swapOut
      ? { ...swapOut.entity.pos }
      : { x: 16, y: 0, z: team === 'red' ? -6 : 6 };

    if (swapOut) {
      swapOut.entity.isBenched = true;
      swapOut.benchSlotIndex = seatIdx;
      swapOut.entity.pos = { ...this.stadium.getBenchSeatPosition(team, seatIdx) };
      swapOut.entity.rotY = -Math.PI / 2;
      swapOut.entity.animState = 'sitting_bench';
    }

    benchedHuman.entity.isBenched = false;
    benchedHuman.benchSlotIndex = -1;
    benchedHuman.entity.pos = returnPos;
    benchedHuman.entity.stamina = 100;
    benchedHuman.entity.animState = 'run';

    const rules = useGameStore.getState().rules;
    if (actor === 'host') {
      this.humanSlot.isBenched = false;
      this.humanSlot.role = 'outfield';
      this.activeCamera = this.resolveAllowedOutfieldCamera(rules);
      this.humanSlot.cameraMode = this.activeCamera;
    } else {
      this.guestSlot.isBenched = false;
      this.guestSlot.role = 'outfield';
      this.guestSlot.cameraMode = this.resolveAllowedOutfieldCamera(rules, this.guestSlot.cameraMode);
      useGameStore.getState().setGuestSlot(this.guestSlot);
      this.broadcastLobbySync();
    }

    this.sound.playBenchBuzzer();
    this.pushEvent(`المدرب رضي عنك! ${benchedHuman.entity.name} رجع للملعب! 🏃🔥`, '🏃', 'bench');
    this.syncStoreImmediate();
  }

  private handleSandboxSwitchRole(
    role: RoleType,
    teamOverride: TeamId | undefined,
    benchSelf: boolean | undefined,
    rules: AdminRules,
    actor: HumanActor = 'host'
  ): void {
    const slot = this.getActorSlot(actor);
    const otherHumanId = this.getOtherActorControlledId(actor);
    const desiredTeam: TeamId = teamOverride ?? slot.team;

    // Clear previous control flags for this actor only
    this.assignActorControlTo(actor, null);

    // Special Sandbox Bench View toggle!
    if (benchSelf) {
      let target = this.entities.find(
        (e) =>
          e.entity.team === desiredTeam &&
          e.entity.role === 'outfield' &&
          e.entity.isBenched &&
          !e.entity.isSentOff &&
          e.entity.id !== otherHumanId
      );
      if (!target) {
        target = this.entities.find(
          (e) =>
            e.entity.team === desiredTeam &&
            e.entity.role === 'outfield' &&
            !e.entity.isSentOff &&
            e.entity.id !== otherHumanId
        );
        if (target) {
          target.entity.isBenched = true;
          target.benchSlotIndex = 0;
          target.entity.pos = { ...this.stadium.getBenchSeatPosition(desiredTeam, 0) };
          target.entity.rotY = -Math.PI / 2;
          target.entity.animState = 'sitting_bench';
        }
      }

      const nextSlot: HumanSlotConfig = {
        ...slot,
        team: desiredTeam,
        role: 'outfield',
        isBenched: true,
        cameraMode: 'bench_cam',
      };
      if (actor === 'host') {
        this.humanSlot = nextSlot;
        this.activeCamera = 'bench_cam';
        this.inputManager.exitPointerLock();
        this.cameraDirector.snapNextFrame();
      } else {
        this.guestSlot = nextSlot;
        useGameStore.getState().setGuestSlot(nextSlot);
      }

      if (target) {
        this.assignActorControlTo(actor, target.entity.id);
      }
      this.pushEvent('اتنقلت لدكة البدلاء! شوّح للمدرب 🪑😂', '🪑', 'bench');
      this.syncStoreImmediate();
      this.broadcastLobbySync();
      return;
    }

    // Resolve dual-human slot conflicts cleanly
    const rawNextSlot: HumanSlotConfig = {
      ...slot,
      team: desiredTeam,
      role,
      isBenched: false,
    };

    const resolvedSlot =
      actor === 'guest'
        ? resolveDualHumanSlotConflict(this.humanSlot, rawNextSlot, rules)
        : rawNextSlot;

    const finalRole = resolvedSlot.role;
    const finalTeam = resolvedSlot.team;
    let nextCam: CameraMode = resolvedSlot.cameraMode;

    if (finalRole === 'outfield') {
      const target =
        this.entities.find(
          (e) =>
            e.entity.team === finalTeam &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            !e.entity.isSentOff &&
            e.entity.id !== otherHumanId &&
            e.entity.positionRole === resolvedSlot.positionRole
        ) ??
        this.entities.find(
          (e) =>
            e.entity.team === finalTeam &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            !e.entity.isSentOff &&
            e.entity.id !== otherHumanId
        ) ??
        null;
      if (target) {
        this.assignActorControlTo(actor, target.entity.id);
      }
      nextCam = this.resolveAllowedOutfieldCamera(rules, resolvedSlot.cameraMode);
      if (actor === 'host') {
        this.inputManager.setFreeYaw(finalTeam === 'red' ? 0 : Math.PI);
      }
      this.pushEvent('بدّلت لدور لاعب الملعب! ورّينا المهارة ⚽🔥', '⚽', 'tactic');
    } else if (finalRole === 'goalkeeper') {
      const gk = this.entities.find(
        (e) =>
          e.entity.team === finalTeam &&
          e.entity.role === 'goalkeeper' &&
          e.entity.id !== otherHumanId
      );
      if (gk) {
        this.assignActorControlTo(actor, gk.entity.id);
      }
      nextCam = 'gk_first_person';
      if (actor === 'host') {
        this.cameraDirector.snapNextFrame();
        this.inputManager.resetMouseLook();
      }
      this.pushEvent('لبست الجوانتي! حارس مرمى منظور شخصي 🧤🔥', '🧤', 'tactic');
    } else if (finalRole === 'referee') {
      const ref = this.entities.find(
        (e) => e.entity.role === 'referee' && e.entity.id !== otherHumanId
      );
      if (ref) {
        this.assignActorControlTo(actor, ref.entity.id);
        if (actor === 'host') {
          this.inputManager.setFreeYaw(ref.entity.rotY);
        }
      }
      nextCam = 'referee_cam';
      this.sound.playWhistle('short');
      this.pushEvent('الصفّارة في إيدك! احكم بمزاجك 🟨🟥', '🟨', 'card_yellow');
    } else if (finalRole === 'coach') {
      const coach = this.entities.find(
        (e) =>
          e.entity.team === finalTeam &&
          e.entity.role === 'coach' &&
          e.entity.id !== otherHumanId
      );
      if (coach) {
        this.assignActorControlTo(actor, coach.entity.id);
      }
      nextCam = 'coach_touchline';
      if (actor === 'host') {
        this.inputManager.exitPointerLock();
      }
      this.pushEvent('بقيت المدير الفني! ظبط التكتيك والدكة 🧥📢', '🧥', 'tactic');
    } else {
      this.assignActorControlTo(actor, null);
      nextCam = 'stands_cam';
      if (actor === 'host') {
        this.inputManager.exitPointerLock();
      }
      this.pushEvent('طلعت المدرجات تتفرج وتشجع! 🏟️🎉', '🏟️', 'crowd');
    }

    resolvedSlot.cameraMode = nextCam;
    if (actor === 'host') {
      this.humanSlot = resolvedSlot;
      this.activeCamera = nextCam;
      if (this.isHostWithGuest()) {
        const revalidatedGuest = resolveDualHumanSlotConflict(
          this.humanSlot,
          this.guestSlot,
          rules
        );
        if (
          revalidatedGuest.role !== this.guestSlot.role ||
          revalidatedGuest.team !== this.guestSlot.team ||
          revalidatedGuest.positionRole !== this.guestSlot.positionRole
        ) {
          this.guestSlot = revalidatedGuest;
          useGameStore.getState().setGuestSlot(revalidatedGuest);
          this.assignGuestEntityLive();
        }
      }
    } else {
      this.guestSlot = resolvedSlot;
      useGameStore.getState().setGuestSlot(resolvedSlot);
    }

    this.syncStoreImmediate();
    this.broadcastLobbySync();
  }

  private performKick(
    rt: EntityRuntime,
    dir: Vec3,
    power: number,
    lift: number,
    isSuperShot: boolean
  ): void {
    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const norm = normalizeXZ(dir.x, dir.z);

    this.ball.kick(norm, power, lift, isSuperShot, p.id, team);
    this.possessorId = null;
    rt.kickCooldown = 0.28;
    p.animState = 'kick';
    rt.animLockTimer = 0.34;
    p.rotY = Math.atan2(norm.x, norm.z);

    this.sound.playKick(clamp(power / 34, 0.25, 1));
    if (isSuperShot) {
      this.effects.spawnBurst(this.ball.state.pos, 0xff5500, 20, 4.5);
      this.cameraDirector.triggerShake(0.28, 0.22);
      this.sound.playCrowdReaction('ooh');
      this.pushEvent(`صاروخية من ${p.name}!! 🔥🚀`, '🚀', 'crowd');
    }
  }

  private performKickWithSpin(
    rt: EntityRuntime,
    dir: Vec3,
    power: number,
    lift: number,
    curlSpinY: number,
    isSuperShot: boolean
  ): void {
    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const norm = normalizeXZ(dir.x, dir.z);

    if (this.ball.kickWithSpin) {
      this.ball.kickWithSpin(norm, power, lift, curlSpinY, isSuperShot, p.id, team);
    } else {
      this.ball.kick(norm, power, lift, isSuperShot, p.id, team);
    }
    this.possessorId = null;
    rt.kickCooldown = 0.28;
    p.animState = 'kick';
    rt.animLockTimer = 0.34;
    p.rotY = Math.atan2(norm.x, norm.z);

    this.sound.playKick(clamp(power / 34, 0.25, 1));
    if (isSuperShot) {
      this.effects.spawnBurst(this.ball.state.pos, 0xff5500, 20, 4.5);
      this.cameraDirector.triggerShake(0.32, 0.24);
      this.sound.playCrowdReaction('ooh');
    }
  }

  private performSkillMove(rt: EntityRuntime): void {
    rt.skillCooldown = 2.5;
    rt.jukeImmuneTimer = 0.55;
    rt.entity.animState = 'skill_spin';
    rt.animLockTimer = 0.45;
    this.effects.spawnBurst(rt.entity.pos, 0x00c2ff, 12, 2.6);
    this.setSpeech(rt, 'ترقيصة بلدي! 🌀😎', 1.8);
  }

  private performSlideTackle(rt: EntityRuntime, dir: Vec3): void {
    const norm = normalizeXZ(dir.x, dir.z);
    rt.slideCooldown = 1.8;
    rt.slideTimer = 0.42;
    rt.slideDirVec = norm;
    rt.entity.rotY = Math.atan2(norm.x, norm.z);
    rt.entity.animState = 'slide_tackle';
    rt.animLockTimer = 0.48;
    this.effects.spawnSlideDust(rt.entity.pos);
    this.sound.playDiveWhoosh();
  }

  private checkSlideTackleImpact(tackler: EntityRuntime): void {
    const tp = tackler.entity;
    const team: TeamId = tp.team === 'blue' ? 'blue' : 'red';

    // Cleanly poke ball if reached
    if (distXZ(tp.pos, this.ball.state.pos) < 1.35) {
      this.possessorId = null;
      this.ball.kick(tackler.slideDirVec, 14, 0.08, false, tp.id, team);
      this.sound.playKick(0.5);
      tackler.tackles += 1;
      tackler.slideTimer = 0;
      return;
    }

    // Check collision with opponent player!
    for (const other of this.entities) {
      const op = other.entity;
      if (
        op.id === tp.id ||
        op.team === tp.team ||
        op.role !== 'outfield' ||
        op.isBenched ||
        op.isSentOff ||
        other.jukeImmuneTimer > 0
      ) {
        continue;
      }

      if (distXZ(tp.pos, op.pos) < 1.3) {
        op.animState = 'dive_flop';
        other.animLockTimer = 0.85;
        other.knockbackVx = tackler.slideDirVec.x * 11.5;
        other.knockbackVz = tackler.slideDirVec.z * 11.5;
        other.knockbackTimer = 0.42;
        this.effects.spawnDiveStars(op.pos);
        this.cameraDirector.triggerShake(0.22, 0.2);
        tackler.tackles += 1;
        tackler.slideTimer = 0;

        if (this.possessorId === op.id) {
          this.possessorId = null;
        }

        const victimTeam: TeamId = op.team === 'blue' ? 'blue' : 'red';
        const inBox = this.isInsideDefendingPenaltyBox(op.pos, team);
        this.pendingIncident = {
          kind: 'foul',
          offenderId: tp.id,
          victimId: op.id,
          team,
          pos: { ...op.pos },
          inPenaltyBox: inBox,
          penaltyForTeam: victimTeam,
          severity: 0.45 + Math.random() * 0.5,
        };
        this.setSpeech(other, 'يا حكم!! كسرني! 🤕', 2.0);
        return;
      }
    }
  }

  private performDive(rt: EntityRuntime): void {
    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const oppTeam: TeamId = team === 'red' ? 'blue' : 'red';

    rt.diveCooldown = 3.0;
    rt.dives += 1;
    p.animState = 'dive_flop';
    rt.animLockTimer = 0.95;
    if (this.possessorId === p.id) this.possessorId = null;

    this.effects.spawnDiveStars(p.pos);
    this.sound.playDiveWhoosh();
    const line = DIVE_LINES[Math.floor(Math.random() * DIVE_LINES.length)];
    this.setSpeech(rt, line, 2.5);
    this.pushEvent(`${p.name} عمل غطسة أوسكار في الملعب! 🎭😂`, '🎭', 'dive');

    const inOppBox = this.isInsideDefendingPenaltyBox(p.pos, oppTeam);
    this.pendingIncident = {
      kind: 'dive',
      offenderId: p.id,
      team,
      pos: { ...p.pos },
      inPenaltyBox: inOppBox,
      penaltyForTeam: team,
      severity: 0.6,
    };
  }

  private performProtest(rt: EntityRuntime): void {
    rt.protests += 1;
    rt.entity.animState = 'protest';
    rt.animLockTimer = 0.95;
    const line = PROTEST_LINES[Math.floor(Math.random() * PROTEST_LINES.length)];
    this.setSpeech(rt, line, 2.4);
    this.sound.playCrowdReaction('boo');
  }

  private performGKDive(rt: EntityRuntime, dir: 'left' | 'right' | 'center'): void {
    const gk = rt.entity;
    const team: TeamId = gk.team === 'blue' ? 'blue' : 'red';
    // Red GK faces +Z -> right is -X, left is +X; Blue GK faces -Z -> right is +X, left is -X
    const rightSignX = team === 'red' ? -1 : 1;

    rt.gkDiveCooldown = 1.05;
    rt.animLockTimer = 0.52;

    if (dir === 'left') {
      rt.gkDiveState = 'left';
      rt.gkDiveDirVec = { x: -rightSignX, y: 0, z: 0 };
      gk.animState = 'gk_dive_left';
    } else if (dir === 'right') {
      rt.gkDiveState = 'right';
      rt.gkDiveDirVec = { x: rightSignX, y: 0, z: 0 };
      gk.animState = 'gk_dive_right';
    } else {
      rt.gkDiveState = 'catch';
      rt.gkDiveDirVec = { x: 0, y: 0, z: 0 };
      gk.animState = 'gk_catch';
    }

    this.sound.playDiveWhoosh();
  }

  private issueCardToPlayer(targetId: string, color: 'yellow' | 'red', reason: string): void {
    const targetRt = this.entities.find((e) => e.entity.id === targetId);
    if (!targetRt || targetRt.entity.isSentOff) return;

    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    if (refRt) {
      refRt.entity.animState = color === 'yellow' ? 'ref_yellow_card' : 'ref_red_card';
      refRt.animLockTimer = 1.1;
    }

    this.sound.playWhistle('short');
    this.sound.playCard(color);

    if (color === 'yellow') {
      targetRt.entity.yellowCards += 1;
      if (targetRt.entity.yellowCards >= 2) {
        // Second yellow -> automatic RED!
        this.sendOffPlayer(targetRt, `إنذار تاني وطرد لـ ${targetRt.entity.name}! برّه الملعب! 🟨🟥😱`);
        return;
      }
      this.setSpeech(targetRt, 'ليه أصفر يا كابتن?! والله ما لمسته! 🟨😤', 2.6);
      this.pushEvent(`${targetRt.entity.name}: ${reason}`, '🟨', 'card_yellow');
    } else {
      this.sendOffPlayer(targetRt, `${targetRt.entity.name}: ${reason}`);
    }

    this.syncStoreImmediate();
  }

  private sendOffPlayer(targetRt: EntityRuntime, message: string): void {
    targetRt.entity.isSentOff = true;
    targetRt.redCards += 1;
    this.sound.playCard('red');
    this.sound.playCrowdReaction('boo');
    this.pushEvent(message, '🟥', 'card_red');

    if (this.possessorId === targetRt.entity.id) {
      this.possessorId = null;
    }

    // If Host's controlled outfield player got sent off, transfer to an active teammate (excluding Guest!)
    if (targetRt.entity.isHumanControlled && targetRt.entity.role === 'outfield') {
      const nextTeammate = this.entities.find(
        (e) =>
          e.entity.team === targetRt.entity.team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff &&
          e.entity.id !== targetRt.entity.id &&
          e.entity.id !== this.guestControlledId
      );
      this.assignActorControlTo('host', nextTeammate ? nextTeammate.entity.id : null);
    }

    // If Guest's controlled outfield player got sent off, transfer to an active teammate (excluding Host!)
    if (targetRt.entity.isRemoteHuman && targetRt.entity.role === 'outfield') {
      const nextTeammate = this.entities.find(
        (e) =>
          e.entity.team === targetRt.entity.team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff &&
          e.entity.id !== targetRt.entity.id &&
          e.entity.id !== this.controlledPlayerId
      );
      this.assignActorControlTo('guest', nextTeammate ? nextTeammate.entity.id : null);
    }

    this.syncStoreImmediate();
  }

  private startPenaltyKick(attackingTeam: TeamId, reason: string): void {
    const defendingTeam: TeamId = attackingTeam === 'red' ? 'blue' : 'red';
    const attackDir = attackingTeam === 'red' ? 1 : -1;
    const spotZ = attackDir * this.stadium.config.penaltySpotZ;
    const goalLineZ = attackDir * (this.stadium.config.halfLength - 0.8);

    // Pick shooter (prefer human Host or Guest if on attacking team outfield)
    const shooter =
      this.entities.find(
        (e) =>
          e.entity.team === attackingTeam &&
          e.entity.role === 'outfield' &&
          (e.entity.isHumanControlled || e.entity.isRemoteHuman) &&
          !e.entity.isBenched &&
          !e.entity.isSentOff
      ) ??
      this.entities.find(
        (e) =>
          e.entity.team === attackingTeam &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff
      );

    const gk = this.entities.find(
      (e) => e.entity.team === defendingTeam && e.entity.role === 'goalkeeper'
    );

    if (!shooter || !gk) return;

    this.possessorId = null;
    this.gkCaughtById = null;
    this.ball.setFrozen(false);
    this.ball.setPositionAndStop({ x: 0, y: 0.22, z: spotZ });

    // Position shooter behind spot, GK on goal line, everyone else outside the box
    shooter.entity.pos = { x: 0, y: 0, z: spotZ - attackDir * 2.4 };
    shooter.entity.rotY = attackDir > 0 ? 0 : Math.PI;
    shooter.entity.animState = 'idle';

    gk.entity.pos = { x: 0, y: 0, z: goalLineZ };
    gk.entity.rotY = attackDir > 0 ? Math.PI : 0;
    gk.entity.animState = 'idle';

    let spreadIdx = 0;
    for (const rt of this.entities) {
      const p = rt.entity;
      if (
        p.id === shooter.entity.id ||
        p.id === gk.entity.id ||
        p.isBenched ||
        p.isSentOff ||
        p.role === 'coach'
      ) {
        continue;
      }
      if (p.role === 'goalkeeper') {
        const ownZ = p.team === 'red' ? -this.stadium.config.halfLength + 1 : this.stadium.config.halfLength - 1;
        p.pos = { x: 0, y: 0, z: ownZ };
      } else if (p.role === 'referee') {
        p.pos = { x: -8, y: 0, z: spotZ - attackDir * 4 };
      } else {
        const offsetX = (spreadIdx % 2 === 0 ? -1 : 1) * (4 + Math.floor(spreadIdx / 2) * 3.5);
        p.pos = { x: offsetX, y: 0, z: spotZ - attackDir * 10 };
        p.rotY = attackDir > 0 ? 0 : Math.PI;
        spreadIdx += 1;
      }
    }

    this.penaltyCtx = {
      attackingTeam,
      shooterId: shooter.entity.id,
      gkId: gk.entity.id,
      aiKickTimer: 1.65,
    };

    this.phase = 'penalty_setup';
    this.sound.playWhistle('long');
    this.crowdExcitement = 0.95;
    this.pushEvent(reason, '🎯', 'var');
    this.syncStoreImmediate();
  }

  private enterVARReview(
    reason: string,
    focusPos: Vec3,
    attackingTeam: TeamId,
    suspectId: string | null
  ): void {
    const savedLivePoses = new Map<
      string,
      { pos: Vec3; rotY: number; animState: CharacterAnimState }
    >();
    for (const rt of this.entities) {
      savedLivePoses.set(rt.entity.id, {
        pos: { ...rt.entity.pos },
        rotY: rt.entity.rotY,
        animState: rt.entity.animState,
      });
    }

    this.varCtx = {
      reason,
      focusPos: { ...focusPos },
      attackingTeam,
      suspectId,
      previousCamera: this.activeCamera,
      previousPhase: this.phase === 'var_review' ? 'playing' : this.phase,
      replayElapsed: 0,
      savedLivePoses,
      savedBallPos: { ...this.ball.state.pos },
    };

    this.replayRecorder.freeze();
    this.ball.setFrozen(true);
    this.stadium.setVARActive(true);
    this.setJumbotronHeadline('الفار بيحقق... 📺', 6.0);
    this.sound.playVARChime();
    this.inputManager.exitPointerLock();
    this.hideAimingGuide();

    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    if (refRt) {
      refRt.entity.animState = 'ref_var_signal';
      refRt.animLockTimer = 1.4;
      this.setSpeech(refRt, 'استنى يا كابتن.. راجع الفار! 📺', 3.0);
    }

    this.phase = 'var_review';
    this.activeCamera = 'var_replay_cam';
    this.pushEvent(`📺 مراجعة الفار VAR: ${reason}`, '📺', 'var');
    this.syncStoreImmediate();
    this.broadcastWorldSnapshot();
  }

  private applyVARVerdict(verdict: VARVerdict): void {
    const ctx = this.varCtx;
    if (!ctx) return;

    // Restore live poses & unfreeze replay buffer and ball
    this.replayRecorder.unfreeze();
    this.replayDisplayPlayers = null;
    this.ball.setFrozen(false);
    this.stadium.setVARActive(false);

    for (const rt of this.entities) {
      const saved = ctx.savedLivePoses.get(rt.entity.id);
      if (saved) {
        rt.entity.pos = { ...saved.pos };
        rt.entity.rotY = saved.rotY;
        rt.entity.animState = saved.animState;
      }
    }
    this.ball.setPositionAndStop(ctx.savedBallPos);

    // Restore camera (strictly respecting GK FP!)
    this.activeCamera =
      this.humanSlot.role === 'goalkeeper' && !this.humanSlot.isBenched
        ? 'gk_first_person'
        : ctx.previousCamera === 'var_replay_cam'
          ? this.humanSlot.cameraMode
          : ctx.previousCamera;

    this.varCtx = null;
    this.sound.playWhistle('long');

    switch (verdict) {
      case 'goal_valid':
        this.phase = 'playing';
        this.setJumbotronHeadline('الجون سليم! ✅', 2.8);
        this.pushEvent('قرار الفار: الهدف صحيح 100%! احتفل يا معلم 📺⚽🔥', '⚽', 'var');
        this.handleGoalScored(ctx.attackingTeam);
        return;

      case 'penalty_awarded':
        this.setJumbotronHeadline('ضربة جزاء! 👉', 2.8);
        this.startPenaltyKick(
          ctx.attackingTeam,
          'قرار الفار: ركلة جزاء مستحقة! 📺🎯🔥'
        );
        return;

      case 'play_on':
        this.phase = 'playing';
        this.setJumbotronHeadline('مفيهاش حاجة! 👋', 2.4);
        this.pushEvent('قرار الفار: العب مفيش أي حاجة! ✅😂', '✅', 'var');
        break;

      case 'yellow_for_dive': {
        this.phase = 'playing';
        this.setJumbotronHeadline('إنذار تمثيل! 🟨', 2.6);
        const targetId = ctx.suspectId ?? this.nearestRefTargetId;
        if (targetId) {
          this.issueCardToPlayer(
            targetId,
            'yellow',
            'قرار الفار: غطسة تمثيل مكشوفة! كارت أصفر 🎭🟨'
          );
        } else {
          this.pushEvent('قرار الفار: تمثيل وغطس! إنذار شفوي 🎭🟨', '🎭', 'card_yellow');
        }
        break;
      }
    }

    this.syncStoreImmediate();
    this.broadcastWorldSnapshot();
  }

  private applyTeamTactic(team: TeamId, stance: TacticalStance, announce: boolean): void {
    this.tactics[team] = stance;
    const labels: Record<TacticalStance, string> = {
      balanced: 'تكتيك متوازن ⚖️',
      all_out_attack: 'هجوم كاسح 🔥',
      park_the_bus: 'أتوبيس دفاعي 🚌🧱',
      high_press: 'ضغط عالي ⚡',
    };
    const teamLabel = team === 'red' ? 'النسور الحمر' : 'موج بحري';
    if (announce) {
      this.sound.playWhistle('short');
    }
    this.pushEvent(`مدرب ${teamLabel} غيّر التكتيك إلى: ${labels[stance]}`, '📋', 'tactic');
    this.syncStoreImmediate();
  }

  private normalizeSlotAgainstRules(raw: HumanSlotConfig, rules: AdminRules): HumanSlotConfig {
    const slot: HumanSlotConfig = { ...raw, isBenched: false };
    if (!rules.allowTeamSwitch) {
      slot.controlMode = 'locked_player';
    }
    if (slot.role === 'referee' && !rules.enableHumanRef) {
      slot.role = 'outfield';
    }
    if (slot.role === 'coach' && !rules.enableCoachBench) {
      slot.role = 'outfield';
    }
    if (slot.role === 'goalkeeper') {
      slot.cameraMode = 'gk_first_person';
    } else if (slot.role === 'referee') {
      slot.cameraMode = 'referee_cam';
    } else if (slot.role === 'coach') {
      slot.cameraMode = 'coach_touchline';
    } else if (slot.role === 'spectator') {
      slot.cameraMode = 'stands_cam';
    } else {
      slot.cameraMode = this.resolveAllowedOutfieldCamera(rules, slot.cameraMode);
    }
    return slot;
  }

  private startNewMatch(): void {
    const store = useGameStore.getState();
    const rules = store.rules;
    const hasGuest = store.network.mode === 'host' && store.network.peerConnected;

    this.isPaused = false;
    this.varCtx = null;
    this.penaltyCtx = null;
    this.pendingIncident = null;
    this.possessorId = null;
    this.gkCaughtById = null;
    this.isChargingShot = false;
    this.shotCharge = 0;
    this.guestIsChargingShot = false;
    this.guestShotCharge = 0;
    this.guestAimCurl = 0;
    this.hitStopRemaining = 0;
    this.goalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
    this.goalReplayFreezeTimer = 0;
    this.replayDisplayPlayers = null;
    this.setJumbotronHeadline(null, 0);
    this.awards = [];

    this.replayRecorder.clear();
    this.outfieldAI.reset();
    this.gkAI.reset();
    this.refAI.reset();
    this.coachAI.reset();
    this.stadium.setVARActive(false);
    this.ball.setFrozen(false);

    this.score = { red: 0, blue: 0 };
    this.clockSec = rules.matchDurationSec;
    this.tactics = { red: 'balanced', blue: 'balanced' };

    // Normalize Host (P1) slot against AdminRules
    const normalizedHost = this.normalizeSlotAgainstRules(store.humanSlot, rules);
    this.humanSlot = normalizedHost;
    this.activeCamera = normalizedHost.cameraMode;

    // Normalize & conflict-resolve Guest (P2) slot when connected on Host
    if (hasGuest) {
      const normalizedGuestRaw = this.normalizeSlotAgainstRules(store.network.guestSlot, rules);
      const resolvedGuest = resolveDualHumanSlotConflict(
        normalizedHost,
        normalizedGuestRaw,
        rules
      );
      this.guestSlot = this.normalizeSlotAgainstRules(resolvedGuest, rules);
      store.setGuestSlot(this.guestSlot);
    }

    this.cameraDirector.snapNextFrame();
    this.inputManager.resetMouseLook();
    this.inputManager.setFreeYaw(normalizedHost.team === 'red' ? 0 : Math.PI);
    this.aimCurl = 0;

    store.resetMatchStats();
    this.spawnRoster(rules);
    this.assignInitialHumanEntity();
    this.positionForKickoff();
    this.ball.reset({ x: 0, y: 0.42, z: 0 });

    this.phase = 'kickoff';
    this.kickoffTimer = 1.1;
    this.sound.playWhistle('short');
    this.pushEvent('صفّارة البداية! ولّع يا ملعب الليلة ⚽🌙🔥', '⚽', 'crowd');
    this.updateStadiumJumbotron();
    this.syncStoreImmediate();
    this.broadcastLobbySync();
    this.broadcastWorldSnapshot();
  }

  private finishMatch(): void {
    this.phase = 'full_time';
    this.isChargingShot = false;
    this.shotCharge = 0;
    this.aimCurl = 0;
    this.guestIsChargingShot = false;
    this.guestShotCharge = 0;
    this.hitStopRemaining = 0;
    this.goalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
    this.replayDisplayPlayers = null;
    this.inputManager.exitPointerLock();
    this.hideAimingGuide();
    this.ball.setTrajectoryVisible(false);
    this.sound.playWhistle('long');
    this.sound.playGoalCelebration();

    this.awards = this.computeComedyAwards();
    const winner =
      this.score.red > this.score.blue
        ? 'النسور الحمر 🔴'
        : this.score.blue > this.score.red
          ? 'موج بحري 🔵'
          : 'تعادل مثير 🤝';
    this.pushEvent(`صفّارة النهاية! النتيجة: ${winner} 🏆`, '🏆', 'goal');
    this.updateStadiumJumbotron();
    this.syncStoreImmediate();
    this.broadcastLobbySync();
    this.broadcastWorldSnapshot();
  }

  private computeComedyAwards(): MatchAward[] {
    const outfielders = this.entities.filter((e) => e.entity.role === 'outfield');
    const goalkeepers = this.entities.filter((e) => e.entity.role === 'goalkeeper');

    const topScorer = [...outfielders].sort((a, b) => b.goals - a.goals)[0];
    const topDiver = [...outfielders].sort(
      (a, b) => b.dives * 3 + b.protests - (a.dives * 3 + a.protests)
    )[0];
    const topCard = [...outfielders].sort(
      (a, b) =>
        b.redCards * 5 + b.entity.yellowCards * 2 + b.tackles -
        (a.redCards * 5 + a.entity.yellowCards * 2 + a.tackles)
    )[0];
    const topGK = [...goalkeepers].sort((a, b) => b.saves - a.saves)[0];

    return [
      {
        title: 'هدّاف الليلة',
        playerName: topScorer ? topScorer.entity.name : 'النسور الحمر',
        reason:
          topScorer && topScorer.goals > 0
            ? `سجّل ${topScorer.goals} أهداف ولّعت المدرجات!`
            : 'أخطر تهديد على المرمى طول الماتش!',
        emoji: '⚽',
      },
      {
        title: 'أوسكار أحسن غطاس',
        playerName: topDiver ? topDiver.entity.name : 'شيكابالا الساحر',
        reason:
          topDiver && topDiver.dives > 0
            ? `عمل ${topDiver.dives} غطسات تستاهل التمثيل في هوليوود!`
            : 'أكثر لاعب اشتكى للحكم بأداء درامي عالي!',
        emoji: '🎭',
      },
      {
        title: 'زبون الطرد والكروت',
        playerName: topCard ? topCard.entity.name : 'وائل صخرة',
        reason:
          topCard && (topCard.entity.yellowCards > 0 || topCard.redCards > 0)
            ? `جمع ${topCard.entity.yellowCards} أصفر و${topCard.redCards} أحمر بكل فخر!`
            : `نفّذ ${topCard?.tackles ?? 0} زحلقات نارية في نص الملعب!`,
        emoji: '🟥',
      },
      {
        title: 'سد منيع',
        playerName: topGK ? topGK.entity.name : 'الشناوي جونيور',
        reason:
          topGK && topGK.saves > 0
            ? `تألّق بـ ${topGK.saves} تصديات أنقذت فريقه!`
            : 'واقف زي الأسد في الجون طول الماتش!',
        emoji: '🧤',
      },
    ];
  }

  private spawnRoster(rules: AdminRules): void {
    const list: EntityRuntime[] = [];
    const makeRt = (entity: PlayerEntityState, benchSlotIndex = -1): EntityRuntime => ({
      entity: { ...entity, isRemoteHuman: false },
      vx: 0,
      vz: 0,
      animLockTimer: 0,
      kickCooldown: 0,
      skillCooldown: 0,
      slideCooldown: 0,
      diveCooldown: 0,
      gkDiveCooldown: 0,
      knockOnCooldown: 0,
      knockOnBoostTimer: 0,
      gkDiveState: 'none',
      gkDiveDirVec: { x: 0, y: 0, z: 0 },
      slideDirVec: { x: 0, y: 0, z: 1 },
      slideTimer: 0,
      jukeImmuneTimer: 0,
      knockbackVx: 0,
      knockbackVz: 0,
      knockbackTimer: 0,
      benchSlotIndex,
      goals: 0,
      saves: 0,
      dives: 0,
      tackles: 0,
      protests: 0,
      redCards: 0,
    });

    const teams: TeamId[] = ['red', 'blue'];
    for (const team of teams) {
      const roster = team === 'red' ? RED_OUTFIELD_ROSTER : BLUE_OUTFIELD_ROSTER;
      const gkName = team === 'red' ? 'الشناوي جونيور' : 'عصام السد';
      const reserveName = team === 'red' ? 'كهربا الدكة' : 'قفشة الاحتياطي';
      const coachName = team === 'red' ? 'الكابتن حسن' : 'الكابتن حسام';

      // Goalkeeper
      list.push(
        makeRt({
          id: `${team}-gk`,
          name: gkName,
          number: 1,
          team,
          role: 'goalkeeper',
          isHumanControlled: false,
          isBenched: false,
          isSentOff: false,
          yellowCards: 0,
          stamina: 100,
          animState: 'idle',
          pos: { x: 0, y: 0, z: team === 'red' ? -33 : 33 },
          rotY: team === 'red' ? 0 : Math.PI,
        })
      );

      // Active Outfielders (2 or 3 based on rules.teamSize)
      for (let i = 0; i < rules.teamSize; i++) {
        const spec = roster[i];
        list.push(
          makeRt({
            id: `${team}-out-${i + 1}`,
            name: spec.name,
            number: spec.number,
            team,
            role: 'outfield',
            positionRole: spec.posRole,
            isHumanControlled: false,
            isBenched: false,
            isSentOff: false,
            yellowCards: 0,
            stamina: 100,
            animState: 'idle',
            pos: { x: 0, y: 0, z: 0 },
            rotY: team === 'red' ? 0 : Math.PI,
          })
        );
      }

      // Physical Bench Reserve Player seated in the 3D dugout!
      const seat0 = this.stadium.getBenchSeatPosition(team, 0);
      list.push(
        makeRt(
          {
            id: `${team}-sub-1`,
            name: reserveName,
            number: team === 'red' ? 9 : 14,
            team,
            role: 'outfield',
            positionRole: 'striker',
            isHumanControlled: false,
            isBenched: true,
            isSentOff: false,
            yellowCards: 0,
            stamina: 100,
            animState: 'sitting_bench',
            pos: { ...seat0 },
            rotY: -Math.PI / 2,
          },
          0
        )
      );

      // Touchline Coach
      const coachZone = this.stadium.config.coachZones[team];
      list.push(
        makeRt({
          id: `${team}-coach`,
          name: coachName,
          number: 0,
          team,
          role: 'coach',
          isHumanControlled: false,
          isBenched: false,
          isSentOff: false,
          yellowCards: 0,
          stamina: 100,
          animState: 'idle',
          pos: { ...coachZone },
          rotY: -Math.PI / 2,
        })
      );
    }

    // Referee
    list.push(
      makeRt({
        id: 'match-ref',
        name: 'الكابتن جهاد (الحكم)',
        number: 99,
        team: 'ref',
        role: 'referee',
        isHumanControlled: false,
        isBenched: false,
        isSentOff: false,
        yellowCards: 0,
        stamina: 100,
        animState: 'idle',
        pos: { x: -8, y: 0, z: 0 },
        rotY: Math.PI / 2,
      })
    );

    this.entities = list;
  }

  private findSlotTargetRuntime(
    slot: HumanSlotConfig,
    excludeId: string | null
  ): EntityRuntime | undefined {
    const { role, team, positionRole, isBenched } = slot;
    if (role === 'outfield') {
      if (isBenched) {
        return this.entities.find(
          (e) =>
            e.entity.team === team &&
            e.entity.role === 'outfield' &&
            e.entity.isBenched &&
            !e.entity.isSentOff &&
            e.entity.id !== excludeId
        );
      }
      return (
        this.entities.find(
          (e) =>
            e.entity.team === team &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            !e.entity.isSentOff &&
            e.entity.id !== excludeId &&
            e.entity.positionRole === positionRole
        ) ??
        this.entities.find(
          (e) =>
            e.entity.team === team &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            !e.entity.isSentOff &&
            e.entity.id !== excludeId
        )
      );
    }
    if (role === 'goalkeeper') {
      return this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'goalkeeper' && e.entity.id !== excludeId
      );
    }
    if (role === 'referee') {
      return this.entities.find(
        (e) => e.entity.role === 'referee' && e.entity.id !== excludeId
      );
    }
    if (role === 'coach') {
      return this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'coach' && e.entity.id !== excludeId
      );
    }
    return undefined;
  }

  private assignInitialHumanEntity(): void {
    for (const rt of this.entities) {
      rt.entity.isHumanControlled = false;
      rt.entity.isRemoteHuman = false;
    }

    const chosenHost = this.findSlotTargetRuntime(this.humanSlot, null);
    if (chosenHost) {
      chosenHost.entity.isHumanControlled = true;
      chosenHost.entity.isRemoteHuman = false;
      this.controlledPlayerId = chosenHost.entity.id;
    } else {
      this.controlledPlayerId = null;
    }

    if (this.isHostWithGuest()) {
      this.assignGuestEntityLive();
    } else {
      this.guestControlledId = null;
    }
  }

  private assignGuestEntityLive(): void {
    for (const rt of this.entities) {
      rt.entity.isRemoteHuman = false;
    }
    if (!this.isHostWithGuest()) {
      this.guestControlledId = null;
      return;
    }
    const rules = useGameStore.getState().rules;
    this.guestSlot = resolveDualHumanSlotConflict(this.humanSlot, this.guestSlot, rules);
    const chosenGuest = this.findSlotTargetRuntime(this.guestSlot, this.controlledPlayerId);
    if (chosenGuest) {
      chosenGuest.entity.isHumanControlled = false;
      chosenGuest.entity.isRemoteHuman = true;
      this.guestControlledId = chosenGuest.entity.id;
      this.guestAimAngle = chosenGuest.entity.team === 'red' ? 0 : Math.PI;
      this.guestAimDir = {
        x: Math.sin(this.guestAimAngle),
        y: 0,
        z: Math.cos(this.guestAimAngle),
      };
    } else {
      this.guestControlledId = null;
    }
  }

  private assignHumanControlTo(entityId: string): void {
    this.assignActorControlTo('host', entityId);
  }

  private assignActorControlTo(actor: HumanActor, entityId: string | null): void {
    if (actor === 'host') {
      for (const rt of this.entities) {
        rt.entity.isHumanControlled = rt.entity.id === entityId;
        if (rt.entity.id === entityId) {
          rt.entity.isRemoteHuman = false;
        }
      }
      this.controlledPlayerId = entityId;
    } else {
      for (const rt of this.entities) {
        rt.entity.isRemoteHuman = rt.entity.id === entityId;
        if (rt.entity.id === entityId) {
          rt.entity.isHumanControlled = false;
        }
      }
      this.guestControlledId = entityId;
    }
  }

  private positionForKickoff(): void {
    const config = this.stadium.config;
    const redSlots: Vec3[] = [
      { x: 0, y: 0, z: -4.2 },
      { x: -6.5, y: 0, z: -15.5 },
      { x: 7.5, y: 0, z: -9.5 },
    ];
    const blueSlots: Vec3[] = [
      { x: 0, y: 0, z: 4.2 },
      { x: 6.5, y: 0, z: 15.5 },
      { x: -7.5, y: 0, z: 9.5 },
    ];

    let redIdx = 0;
    let blueIdx = 0;

    for (const rt of this.entities) {
      const p = rt.entity;
      rt.vx = 0;
      rt.vz = 0;
      rt.slideTimer = 0;
      rt.gkDiveState = 'none';

      if (p.isBenched) {
        const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
        p.pos = { ...this.stadium.getBenchSeatPosition(team, Math.max(0, rt.benchSlotIndex)) };
        p.rotY = -Math.PI / 2;
        p.animState = 'sitting_bench';
        continue;
      }
      if (p.isSentOff) {
        this.stepSentOffPlayer(rt);
        continue;
      }
      if (p.role === 'goalkeeper') {
        p.pos = { x: 0, y: 0, z: p.team === 'red' ? -config.halfLength + 1.0 : config.halfLength - 1.0 };
        p.rotY = p.team === 'red' ? 0 : Math.PI;
        p.animState = 'idle';
      } else if (p.role === 'outfield') {
        if (p.team === 'red') {
          p.pos = { ...(redSlots[redIdx % redSlots.length]) };
          p.rotY = 0;
          redIdx += 1;
        } else {
          p.pos = { ...(blueSlots[blueIdx % blueSlots.length]) };
          p.rotY = Math.PI;
          blueIdx += 1;
        }
        p.animState = 'idle';
      } else if (p.role === 'referee') {
        p.pos = { x: -8.5, y: 0, z: 0 };
        p.rotY = Math.PI / 2;
        p.animState = 'idle';
      } else if (p.role === 'coach') {
        const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
        p.pos = { ...config.coachZones[team] };
        p.rotY = -Math.PI / 2;
        p.animState = 'idle';
      }
    }
  }

  private updateBallTrajectoryGuide(): void {
    if (
      this.humanSlot.role === 'goalkeeper' &&
      !this.humanSlot.isBenched &&
      (this.phase === 'playing' || this.phase === 'penalty_setup')
    ) {
      const forwardZ = this.humanSlot.team === 'red' ? 1 : -1;
      const gkGoalZ =
        this.humanSlot.team === 'red'
          ? -this.stadium.config.halfLength
          : this.stadium.config.halfLength;
      const incoming = this.ball.state.vel.z * forwardZ < -4.5;
      this.ball.setTrajectoryVisible(incoming || this.phase === 'penalty_setup', gkGoalZ);
    } else {
      this.ball.setTrajectoryVisible(false);
    }
  }

  private updateCameraAndVisuals(dt: number): void {
    const controlledRt = this.getControlledRuntime();
    const gkDiveState: GKDiveVisualState =
      controlledRt && controlledRt.entity.role === 'goalkeeper'
        ? this.gkCaughtById === controlledRt.entity.id
          ? 'catch'
          : controlledRt.gkDiveState
        : 'none';
    const freeLook = this.inputManager.getFreeLook();
    const sprinting =
      (this.inputManager.isSprinting() || this.externalSprint) &&
      (controlledRt ? controlledRt.entity.stamina > 4 : false);

    const camOut = this.cameraDirector.update(dt, this.elapsed, {
      phase: this.phase,
      cameraMode: this.activeCamera,
      config: this.stadium.config,
      ballPos: this.ball.state.pos,
      ballVel: this.ball.state.vel,
      controlledPlayer: controlledRt?.entity ?? null,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
      freeYaw: freeLook.yaw,
      freePitch: freeLook.pitch,
      isSprinting: sprinting,
      gkDiveState,
      benchSeatPos: this.getHumanBenchSeatPos(),
      varFocusPos: this.varCtx?.focusPos ?? this.ball.state.pos,
    });

    this.characters.updateFPGloves(
      this.camera,
      camOut.isFirstPersonGK,
      camOut.gkDiveState,
      dt
    );
  }

  private updateNearestRefTarget(): void {
    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    if (!refRt) {
      this.nearestRefTargetId = null;
      return;
    }

    let nearestId: string | null = null;
    let bestDist = 11.5;
    for (const rt of this.entities) {
      const p = rt.entity;
      if (
        p.role === 'referee' ||
        p.role === 'coach' ||
        p.isBenched ||
        p.isSentOff
      ) {
        continue;
      }
      const d = distXZ(refRt.entity.pos, p.pos);
      if (d < bestDist) {
        bestDist = d;
        nearestId = p.id;
      }
    }
    this.nearestRefTargetId = nearestId;
  }

  private getControlledRuntime(): EntityRuntime | null {
    if (!this.controlledPlayerId) return null;
    return this.entities.find((e) => e.entity.id === this.controlledPlayerId) ?? null;
  }

  private getHumanMoveInput(): { dx: number; dz: number } {
    const kb = this.inputManager.getMoveVector();
    if (Math.abs(kb.dx) > 0.01 || Math.abs(kb.dz) > 0.01) {
      return kb;
    }
    return this.externalMoveVec ?? { dx: 0, dz: 0 };
  }

  private getHumanBenchSeatPos(): Vec3 {
    const rt = this.getControlledRuntime();
    const slot = rt && rt.benchSlotIndex >= 0 ? rt.benchSlotIndex : 0;
    return this.stadium.getBenchSeatPosition(this.humanSlot.team, slot);
  }

  private resolveAllowedOutfieldCamera(
    rules: AdminRules,
    preferred?: CameraMode
  ): CameraMode {
    if (rules.allowedCameras === 'top_only') return 'broadcast_top';
    if (rules.allowedCameras === 'player_only') return 'player_third';
    if (preferred === 'player_third' || preferred === 'broadcast_top') return preferred;
    return 'player_third';
  }

  private computePrecisionZone(charge: number, charging: boolean): ShotPrecisionZone {
    if (!charging) return 'none';
    if (charge < 0.35) return 'low';
    if (charge < 0.72) return 'good';
    if (charge <= 0.88) return 'perfect';
    return 'overcharge';
  }

  private updateHumanAimAndCurl(dt: number): void {
    const rt = this.getControlledRuntime();
    if (!rt) return;

    if (this.activeCamera === 'broadcast_top') {
      const ndc = this.inputManager.getMouseNDC();
      const groundHit = this.cameraDirector.raycastGround(ndc.x, ndc.y);
      if (groundHit) {
        const dx = groundHit.x - rt.entity.pos.x;
        const dz = groundHit.z - rt.entity.pos.z;
        if (Math.hypot(dx, dz) > 0.35) {
          this.humanAimDir = normalizeXZ(dx, dz);
        }
      }
    } else {
      const { yaw } = this.inputManager.getFreeLook();
      this.humanAimDir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    }

    if (this.isChargingShot) {
      const curlDelta = this.inputManager.consumeCurlDelta();
      const rawMove = this.getHumanMoveInput();
      const kbSteer = this.activeCamera === 'player_third' ? rawMove.dx * dt * 1.15 : 0;
      this.aimCurl = clamp(this.aimCurl + curlDelta + kbSteer, -1, 1);
    } else {
      this.aimCurl = 0;
    }
  }

  private stepKnockbackAndBodyCollisions(dt: number): void {
    const decay = Math.exp(-5.2 * dt);
    const activeBodies: EntityRuntime[] = [];

    for (const rt of this.entities) {
      if (rt.knockbackTimer > 0) {
        rt.knockbackTimer = Math.max(0, rt.knockbackTimer - dt);
        rt.entity.pos.x += rt.knockbackVx * dt;
        rt.entity.pos.z += rt.knockbackVz * dt;
        rt.knockbackVx *= decay;
        rt.knockbackVz *= decay;
      }

      if (
        (rt.entity.role === 'outfield' || rt.entity.role === 'goalkeeper') &&
        !rt.entity.isBenched &&
        !rt.entity.isSentOff
      ) {
        activeBodies.push(rt);
      }
    }

    // Physical player-vs-player body contact separation
    const minSep = 0.94;
    for (let i = 0; i < activeBodies.length; i++) {
      const a = activeBodies[i];
      for (let j = i + 1; j < activeBodies.length; j++) {
        const b = activeBodies[j];
        const dx = b.entity.pos.x - a.entity.pos.x;
        const dz = b.entity.pos.z - a.entity.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.001 && d < minSep) {
          const push = (minSep - d) * 0.5;
          const nx = dx / d;
          const nz = dz / d;
          if (a.entity.role !== 'goalkeeper') {
            a.entity.pos.x -= nx * push;
            a.entity.pos.z -= nz * push;
          }
          if (b.entity.role !== 'goalkeeper') {
            b.entity.pos.x += nx * push;
            b.entity.pos.z += nz * push;
          }
        }
      }
    }
  }

  private findAimedPassTarget(
    passer: EntityRuntime,
    aimDir: Vec3
  ): EntityRuntime | null {
    const p = passer.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const teammates = this.entities.filter(
      (e) =>
        e.entity.id !== p.id &&
        e.entity.team === team &&
        e.entity.role === 'outfield' &&
        !e.entity.isBenched &&
        !e.entity.isSentOff
    );

    const minConeCos = Math.cos((24 * Math.PI) / 180); // ±24° cone
    let bestTarget: EntityRuntime | null = null;
    let bestScore = -Infinity;
    for (const tm of teammates) {
      const toTm = normalizeXZ(tm.entity.pos.x - p.pos.x, tm.entity.pos.z - p.pos.z);
      const dot = toTm.x * aimDir.x + toTm.z * aimDir.z;
      if (dot < minConeCos) continue;
      const dist = distXZ(p.pos, tm.entity.pos);
      const score = dot * 18 - dist * 0.16;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = tm;
      }
    }
    return bestTarget;
  }

  private hideAimingGuide(): void {
    this.aimingGuide?.update({
      visible: false,
      playerPos: { x: 0, y: 0, z: 0 },
      aimDir: { x: 0, y: 0, z: 1 },
      charge: 0,
      curl: 0,
      isCharging: false,
      ballPos: this.ball.state.pos,
      passTargetPos: null,
      teamColor: 0x00e5ff,
      elapsed: this.elapsed,
    });
  }

  private updateAimingGuideVisual(): void {
    if (!this.aimingGuide) return;
    const rt = this.getControlledRuntime();
    const show =
      Boolean(rt) &&
      this.humanSlot.role === 'outfield' &&
      !this.humanSlot.isBenched &&
      (this.phase === 'playing' || this.phase === 'penalty_setup' || this.phase === 'kickoff');

    if (!show || !rt) {
      this.hideAimingGuide();
      return;
    }

    const aim = normalizeXZ(this.humanAimDir.x, this.humanAimDir.z);
    const hasBallNearby = distXZ(rt.entity.pos, this.ball.state.pos) < 2.8;
    const passTarget = hasBallNearby ? this.findAimedPassTarget(rt, aim) : null;
    const teamColor =
      rt.entity.team === 'blue'
        ? this.stadium.config.colors.blueTeam
        : this.stadium.config.colors.redTeam;

    this.aimingGuide.update({
      visible: true,
      playerPos: rt.entity.pos,
      aimDir: aim,
      charge: this.shotCharge,
      curl: this.aimCurl,
      isCharging: this.isChargingShot,
      ballPos: this.ball.state.pos,
      passTargetPos: passTarget ? passTarget.entity.pos : null,
      teamColor,
      elapsed: this.elapsed,
    });
  }

  private isInsideDefendingPenaltyBox(pos: Vec3, defendingTeam: TeamId): boolean {
    const config = this.stadium.config;
    const withinWidth = Math.abs(pos.x) <= config.penaltyBoxWidth * 0.5;
    if (!withinWidth) return false;
    if (defendingTeam === 'red') {
      return pos.z <= -config.halfLength + config.penaltyBoxDepth;
    }
    return pos.z >= config.halfLength - config.penaltyBoxDepth;
  }

  private setSpeech(rt: EntityRuntime, text: string, duration = 2.4): void {
    rt.entity.speechBubble = text;
    rt.entity.speechTimer = duration;
    this.characters.triggerSpeechBubble(rt.entity.id, text, duration);
  }

  private pushEvent(
    text: string,
    icon: string,
    tone: ComedyEventTone,
    broadcastToGuest = true
  ): void {
    const store = useGameStore.getState();
    store.pushComedyEvent({ text, icon, tone });
    if (broadcastToGuest && this.isHostWithGuest()) {
      const latest = useGameStore.getState().events[0];
      if (latest && this.pendingSnapshotEvents.length < 10) {
        this.pendingSnapshotEvents.push({ ...latest });
      }
    }
  }

  private syncStoreImmediate(): void {
    const controlledRt = this.getControlledRuntime();
    const varState: VARState = this.varCtx
      ? {
          active: true,
          progress: this.replayRecorder.getLoopProgress(this.varCtx.replayElapsed, 0.35),
          reason: this.varCtx.reason,
          replayElapsed: this.varCtx.replayElapsed,
          replayDuration: Math.max(0.1, this.replayRecorder.getDuration()),
        }
      : {
          active: false,
          progress: 0,
          reason: '',
          replayElapsed: 0,
          replayDuration: 4,
        };

    const playersSnapshot: PlayerEntityState[] = this.entities.map((rt) => ({
      ...rt.entity,
      pos: { ...rt.entity.pos },
    }));

    useGameStore.getState().updateMatchSnapshot({
      phase: this.phase,
      score: { ...this.score },
      clockSec: this.clockSec,
      players: playersSnapshot,
      controlledPlayerId: this.controlledPlayerId,
      nearestRefTargetId: this.nearestRefTargetId,
      shotCharge: this.shotCharge,
      aimPrecisionZone: this.computePrecisionZone(this.shotCharge, this.isChargingShot),
      aimCurl: this.aimCurl,
      pointerLocked: this.inputManager.isPointerLocked(),
      physicsBackend: this.ball.isRapierReady?.() ? 'rapier3d' : 'fallback',
      stamina: controlledRt ? controlledRt.entity.stamina : 100,
      skillCooldown: controlledRt ? controlledRt.skillCooldown : 0,
      diveCooldown: controlledRt ? controlledRt.diveCooldown : 0,
      gkDiveCooldown: controlledRt ? controlledRt.gkDiveCooldown : 0,
      tactics: { ...this.tactics },
      varState,
      goalReplayState: { ...this.goalReplayState },
      awards: this.awards,
      activeCamera: this.activeCamera,
      isPaused: this.isPaused,
      humanSlot: { ...this.humanSlot },
    });
  }

  /* ─────────────── v3 Rematch Feel, 3s Goal Replay, Jumbotron & P2P Sync ─────────────── */

  private isHostWithGuest(): boolean {
    const net = useGameStore.getState().network;
    return net.mode === 'host' && net.peerConnected;
  }

  private getActorRuntime(actor: HumanActor): EntityRuntime | null {
    if (actor === 'host') return this.getControlledRuntime();
    if (!this.guestControlledId) return null;
    return this.entities.find((e) => e.entity.id === this.guestControlledId) ?? null;
  }

  private getActorSlot(actor: HumanActor): HumanSlotConfig {
    return actor === 'host' ? this.humanSlot : this.guestSlot;
  }

  private getOtherActorControlledId(actor: HumanActor): string | null {
    if (actor === 'host') {
      return this.isHostWithGuest() ? this.guestControlledId : null;
    }
    return this.controlledPlayerId;
  }

  private triggerHitStop(duration = Math.max(HIT_STOP_DURATION_SEC, 0.08)): void {
    this.hitStopRemaining = Math.max(this.hitStopRemaining, duration);
  }

  private setJumbotronHeadline(text: string | null, duration = 2.6): void {
    this.jumbotronHeadline = text;
    this.jumbotronHeadlineTimer = text ? duration : 0;
  }

  private updateStadiumJumbotron(): void {
    if (!this.stadium.updateJumbotron) return;
    const varActive =
      this.phase === 'var_review' ||
      Boolean(this.varCtx) ||
      useGameStore.getState().varState.active;

    let headline: string | null = null;
    if (varActive) {
      headline = 'الفار بيحقق... 📺';
    } else if (this.phase === 'goal_celebration' || this.phase === 'goal_replay') {
      headline = 'جووووول عالمي! ⚽🔥';
    } else if (this.jumbotronHeadlineTimer > 0 && this.jumbotronHeadline) {
      headline = this.jumbotronHeadline;
    }

    this.stadium.updateJumbotron({
      redScore: this.score.red,
      blueScore: this.score.blue,
      clockSec: this.clockSec,
      headline,
      varActive,
    });
  }

  private triggerSpectatorReaction(kind: 'cheer' | 'boo' | 'fireworks'): void {
    if (kind === 'cheer') {
      this.sound.playCrowdReaction('cheer');
      this.crowdExcitement = 1.0;
      this.stadium.setCrowdExcitement(1.0);
      this.pushEvent('المدرجات ولعت تشجيع وهتافات! 🎉🔥', '🎉', 'crowd');
    } else if (kind === 'boo') {
      this.sound.playCrowdReaction('boo');
      this.crowdExcitement = 0.78;
      this.stadium.setCrowdExcitement(0.78);
      this.pushEvent('صافرات استهجان تهز أرجاء الاستاد! 📣😤', '📣', 'crowd');
    } else {
      this.sound.playFireworks();
      this.stadium.triggerCrowdFireworks();
      this.effects.spawnFireworks({ x: -12, y: 12, z: -18 }, 0xfbbf24);
      this.effects.spawnFireworks({ x: 12, y: 14, z: 18 }, 0x00c2ff);
      this.crowdExcitement = 1.0;
      this.stadium.setCrowdExcitement(1.0);
      this.pushEvent('ألعاب نارية وشماريخ في سماء الملعب! 🎆✨', '🎆', 'crowd');
    }
  }

  private enterGoalReplay(): void {
    this.replayRecorder.freeze();
    this.ball.setFrozen(true);
    this.ball.setTrajectoryVisible(false);
    this.hideAimingGuide();
    this.inputManager.exitPointerLock();

    this.phase = 'goal_replay';
    this.goalReplayState = {
      active: true,
      scoringTeam: this.goalReplayState.scoringTeam,
      scorerName: this.goalReplayState.scorerName,
      elapsed: 0,
      duration: GOAL_REPLAY_DURATION_SEC,
    };
    this.setJumbotronHeadline('جووووول عالمي! ⚽🔥', GOAL_REPLAY_DURATION_SEC + 0.5);
    this.cameraDirector.snapNextFrame();
    this.syncStoreImmediate();
    this.broadcastWorldSnapshot();
  }

  private stepGoalReplay(dt: number): void {
    this.goalReplayState.active = true;
    this.goalReplayState.elapsed = Math.min(
      this.goalReplayState.duration,
      this.goalReplayState.elapsed + dt
    );

    const replaySpeed = 0.55;
    const recDuration = this.replayRecorder.getDuration();
    const windowSec = Math.min(recDuration, this.goalReplayState.duration * replaySpeed);
    const startRecordedSec = Math.max(0, recDuration - windowSec - 0.02);
    const virtualElapsed = startRecordedSec / replaySpeed + this.goalReplayState.elapsed;

    const sampled = this.replayRecorder.sampleAt(virtualElapsed, replaySpeed);
    let focusPos = this.lastGoalFocusPos;

    if (sampled) {
      this.ball.setFrozen(true);
      this.ball.applyVisualTransform(sampled.ball.pos, sampled.ball.quat);
      focusPos = {
        x: sampled.ball.pos.x * 0.75,
        y: Math.max(0.9, sampled.ball.pos.y),
        z: sampled.ball.pos.z,
      };

      const frameById = new Map(sampled.players.map((p) => [p.id, p]));
      const replayPlayers: PlayerEntityState[] = this.entities.map((rt) => {
        const snap = frameById.get(rt.entity.id);
        if (!snap) return rt.entity;
        return {
          ...rt.entity,
          pos: { ...snap.pos },
          rotY: snap.rotY,
          animState: snap.animState,
        };
      });

      this.replayDisplayPlayers = replayPlayers;
      this.characters.syncPlayers(replayPlayers, dt * replaySpeed, this.elapsed);
      this.effects.update(dt * replaySpeed, sampled.ball.pos, sampled.ball.isSuperShot);
    } else {
      this.replayDisplayPlayers = null;
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt * replaySpeed,
        this.elapsed
      );
      this.effects.update(dt * replaySpeed, this.ball.state.pos, false);
    }

    const freeLook = this.inputManager.getFreeLook();
    this.hideAimingGuide();
    this.cameraDirector.update(dt, this.elapsed, {
      phase: 'goal_replay',
      cameraMode: 'var_replay_cam',
      config: this.stadium.config,
      ballPos: focusPos,
      ballVel: { x: 0, y: 0, z: 0 },
      controlledPlayer: this.getControlledRuntime()?.entity ?? null,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
      freeYaw: freeLook.yaw,
      freePitch: freeLook.pitch,
      isSprinting: false,
      gkDiveState: 'none',
      benchSeatPos: this.getHumanBenchSeatPos(),
      varFocusPos: focusPos,
    });
    this.characters.updateFPGloves(this.camera, false, 'none', dt);

    this.hudSyncAccum += dt;
    if (this.hudSyncAccum >= 0.05) {
      this.hudSyncAccum = 0;
      this.syncStoreImmediate();
    }

    if (this.goalReplayState.elapsed >= this.goalReplayState.duration) {
      this.finishGoalReplayToKickoff();
    }
  }

  private finishGoalReplayToKickoff(): void {
    if (this.phase !== 'goal_replay') return;

    this.goalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
    this.replayDisplayPlayers = null;
    this.setJumbotronHeadline(null, 0);
    this.replayRecorder.unfreeze();
    this.replayRecorder.clear();
    this.ball.setFrozen(false);

    this.positionForKickoff();
    this.ball.reset({ x: 0, y: 0.22, z: 0 });
    this.phase = 'kickoff';
    this.kickoffTimer = 1.0;
    this.cameraDirector.snapNextFrame();
    this.syncStoreImmediate();
    this.broadcastWorldSnapshot();
  }

  private resolveQuickChatSpeakerId(
    peer: 'local' | 'host' | 'guest',
    explicitPlayerId?: string | null
  ): { id: string | null; name: string } {
    const store = useGameStore.getState();
    const playersPool =
      store.network.mode === 'guest' && store.players.length > 0
        ? store.players
        : this.entities.map((e) => e.entity);

    if (explicitPlayerId) {
      const found = playersPool.find((p) => p.id === explicitPlayerId);
      if (found) return { id: found.id, name: found.name };
    }

    let candidateId: string | null = null;
    let fallbackTeam: TeamId = this.humanSlot.team;

    if (store.network.mode === 'guest') {
      if (peer === 'host') {
        candidateId = this.remoteHostControlledId;
        fallbackTeam = store.hostSlot.team;
      } else {
        candidateId = this.controlledPlayerId;
        fallbackTeam = this.humanSlot.team;
      }
    } else {
      if (peer === 'guest') {
        candidateId = this.guestControlledId;
        fallbackTeam = this.guestSlot.team;
      } else {
        candidateId = this.controlledPlayerId;
        fallbackTeam = this.humanSlot.team;
      }
    }

    if (candidateId) {
      const found = playersPool.find((p) => p.id === candidateId);
      if (found) return { id: found.id, name: found.name };
    }

    // Fallback for Spectator role so speech bubble still pops on touchline/pitch
    const fallback =
      playersPool.find((p) => p.team === fallbackTeam && !p.isBenched && !p.isSentOff) ??
      playersPool[0];
    return fallback
      ? { id: fallback.id, name: fallback.name }
      : { id: null, name: peer === 'guest' ? 'الضيف' : 'الكابتن' };
  }

  private applyQuickChatBubbleAndToast(
    phraseId: string,
    speakerId: string | null,
    speakerName: string
  ): string | null {
    const phrase = getQuickChatPhrase(phraseId);
    if (!phrase) return null;

    const bubbleText = `${phrase.text} ${phrase.emoji}`;
    if (speakerId) {
      const rt = this.entities.find((e) => e.entity.id === speakerId);
      if (rt) {
        rt.entity.speechBubble = bubbleText;
        rt.entity.speechTimer = 3.2;
      }
      this.localSpeechOverrides.set(speakerId, { text: bubbleText, remaining: 3.2 });
      this.characters.triggerSpeechBubble(speakerId, bubbleText, 3.2);
    }

    this.pushEvent(`${speakerName}: ${bubbleText}`, phrase.emoji, 'crowd', false);
    this.rawSound.playCrowdReaction('ooh');
    return phrase.id;
  }

  private handleQuickChatCommand(phraseId: string): void {
    const phrase = getQuickChatPhrase(phraseId);
    if (!phrase) return;

    const speaker = this.resolveQuickChatSpeakerId('local');
    this.applyQuickChatBubbleAndToast(phrase.id, speaker.id, speaker.name);
    this.networkManager?.sendQuickChat(phrase.id, speaker.id);
  }

  private handleNetworkQuickChat(event: QuickChatNetworkEvent): void {
    const store = useGameStore.getState();
    // Guard against any local echo
    if (store.network.mode === 'host' && event.sender === 'host') return;
    if (store.network.mode === 'guest' && event.sender === 'guest') return;

    const speaker = this.resolveQuickChatSpeakerId(event.sender, event.playerId);
    this.applyQuickChatBubbleAndToast(event.phraseId, speaker.id, speaker.name);
  }

  /* ─────────────── P2P Host Authority & Guest Interpolation ─────────────── */

  private reconcileNetworkTransitions(
    dt: number,
    store: ReturnType<typeof useGameStore.getState>
  ): void {
    const mode = store.network.mode;
    const peerConnected = store.network.peerConnected;

    // Detect Guest -> Offline/Host disconnect transition
    if (this.lastNetworkMode === 'guest' && mode !== 'guest') {
      this.guestSnapshotBuffer = [];
      this.lastReceivedSnapshotSeq = 0;
      this.guestTimelineInitialized = false;
      this.guestHitStopRemaining = 0;
      this.outgoingGuestCommands = [];
      this.seenSnapshotEventIds.clear();
      this.localSpeechOverrides.clear();
      this.remoteHostControlledId = null;
      this.ball.setFrozen(false);
      this.stadium.setVARActive(false);
      this.humanSlot = { ...store.hostSlot };
      this.activeCamera = store.hostSlot.cameraMode;
      this.spawnRoster(store.rules);
      this.positionForKickoff();
      this.ball.reset({ x: 0, y: 0.22, z: 0 });
      this.syncStoreImmediate();
    }

    // Detect Host/Offline -> Guest transition
    if (this.lastNetworkMode !== 'guest' && mode === 'guest') {
      this.guestSnapshotBuffer = [];
      this.lastReceivedSnapshotSeq = 0;
      this.guestTimelineInitialized = false;
      this.guestHitStopRemaining = 0;
      this.outgoingGuestCommands = [];
      this.seenSnapshotEventIds.clear();
      this.humanSlot = { ...store.humanSlot };
      this.activeCamera = store.humanSlot.cameraMode;
      this.ball.setFrozen(true);
    }

    this.lastNetworkMode = mode;

    // Host peer connect / disconnect handling
    if (mode === 'host') {
      if (peerConnected && !this.wasPeerConnected) {
        this.wasPeerConnected = true;
        this.lastGuestInputSeq = 0;
        const resolvedGuest = resolveDualHumanSlotConflict(
          this.humanSlot,
          store.network.guestSlot,
          store.rules
        );
        this.guestSlot = this.normalizeSlotAgainstRules(resolvedGuest, store.rules);
        store.setGuestSlot(this.guestSlot);
        if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
          this.assignGuestEntityLive();
        }
        this.syncStoreImmediate();
        this.broadcastLobbySync();
      } else if (!peerConnected && this.wasPeerConnected) {
        // Peer disconnected: cleanly revert Guest entity back to AI!
        this.wasPeerConnected = false;
        this.resetGuestRuntimeToAI();
        this.syncStoreImmediate();
      } else if (peerConnected && (this.phase === 'lobby' || this.phase === 'menu')) {
        // Auto-broadcast lobby sync if Host changed rules or hostSlot in store UI
        this.hostLobbyCheckAccum += dt;
        if (this.hostLobbyCheckAccum >= 0.1) {
          this.hostLobbyCheckAccum = 0;
          const sig = JSON.stringify({
            r: store.rules,
            h: store.hostSlot,
            g: store.network.guestSlot,
            p: this.phase,
          });
          if (sig !== this.lastSyncedLobbySig) {
            this.lastSyncedLobbySig = sig;
            this.humanSlot = { ...store.hostSlot };
            this.guestSlot = resolveDualHumanSlotConflict(
              this.humanSlot,
              store.network.guestSlot,
              store.rules
            );
            this.broadcastLobbySync();
          }
        }
      }
    } else if (this.wasPeerConnected) {
      this.wasPeerConnected = false;
      this.resetGuestRuntimeToAI();
    }
  }

  private resetGuestRuntimeToAI(): void {
    for (const rt of this.entities) {
      rt.entity.isRemoteHuman = false;
    }
    this.guestControlledId = null;
    this.guestMoveVec = { x: 0, y: 0, z: 0 };
    this.guestSprint = false;
    this.guestIsChargingShot = false;
    this.guestShotCharge = 0;
    this.guestAimCurl = 0;
    this.lastGuestInputSeq = 0;
    this.pendingSnapshotEvents = [];
    this.pendingSnapshotSfx = [];
  }

  private broadcastLobbySync(): void {
    const store = useGameStore.getState();
    if (store.network.mode !== 'host' || !store.network.peerConnected) return;
    const packet: LobbySyncPacket = {
      rules: { ...store.rules },
      hostSlot: { ...this.humanSlot },
      guestSlot: { ...this.guestSlot },
      phase: this.phase,
    };
    this.networkManager?.sendLobbySync(packet);
  }

  private handleNetworkGuestSlotUpdate(slot: HumanSlotConfig): void {
    const store = useGameStore.getState();
    if (store.network.mode !== 'host') return;

    const normalized = this.normalizeSlotAgainstRules(slot, store.rules);
    const resolved = resolveDualHumanSlotConflict(this.humanSlot, normalized, store.rules);
    this.guestSlot = this.normalizeSlotAgainstRules(resolved, store.rules);
    store.setGuestSlot(this.guestSlot);

    if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
      this.assignGuestEntityLive();
      this.syncStoreImmediate();
    }
    this.broadcastLobbySync();
  }

  private handleNetworkLobbySync(packet: LobbySyncPacket): void {
    const store = useGameStore.getState();
    if (store.network.mode !== 'guest') return;

    this.humanSlot = { ...packet.guestSlot };
    if (packet.phase === 'lobby' || packet.phase === 'menu') {
      this.isPaused = false;
      this.isChargingShot = false;
      this.shotCharge = 0;
      this.aimCurl = 0;
      this.guestSnapshotBuffer = [];
      this.guestTimelineInitialized = false;
      this.guestHitStopRemaining = 0;
      this.phase = packet.phase;
      this.goalReplayState = { ...INITIAL_GOAL_REPLAY_STATE };
      this.stadium.setVARActive(false);
      this.ball.setTrajectoryVisible(false);
      this.hideAimingGuide();
      this.inputManager.exitPointerLock();
      this.activeCamera = packet.guestSlot.cameraMode;
      this.spawnRoster(packet.rules);
      this.positionForKickoff();
      this.ball.reset({ x: 0, y: 0.22, z: 0 });
      this.updateStadiumJumbotron();
      this.syncStoreImmediate();
    }
  }

  private handleNetworkGuestInput(packet: GuestInputPacket): void {
    const store = useGameStore.getState();
    if (store.network.mode !== 'host' || !store.network.peerConnected) return;
    if (packet.seq <= this.lastGuestInputSeq && packet.commands.length === 0) return;
    this.lastGuestInputSeq = Math.max(this.lastGuestInputSeq, packet.seq);

    let mx = Number.isFinite(packet.moveDx) ? clamp(packet.moveDx, -1, 1) : 0;
    let mz = Number.isFinite(packet.moveDz) ? clamp(packet.moveDz, -1, 1) : 0;
    const mLen = Math.hypot(mx, mz);
    if (mLen > 1) {
      mx /= mLen;
      mz /= mLen;
    }
    this.guestMoveVec = { x: mx, y: 0, z: mz };
    this.guestSprint = Boolean(packet.sprint);

    if (Number.isFinite(packet.aimAngle)) {
      const prevAngle = this.guestAimAngle;
      this.guestAimAngle = packet.aimAngle;
      this.guestAimDir = {
        x: Math.sin(packet.aimAngle),
        y: 0,
        z: Math.cos(packet.aimAngle),
      };
      if (this.guestIsChargingShot) {
        let diff = ((packet.aimAngle - prevAngle + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (diff < -Math.PI) diff += Math.PI * 2;
        this.guestAimCurl = clamp(this.guestAimCurl - diff * 1.8, -1, 1);
      }
    }

    if (packet.slot) {
      this.guestSlot.controlMode = store.rules.allowTeamSwitch
        ? packet.slot.controlMode
        : 'locked_player';
    }

    const rules = store.rules;
    for (const cmd of packet.commands) {
      this.executeGuestCommandOnHost(cmd, rules);
    }
  }

  private executeGuestCommandOnHost(cmd: GameCommand, rules: AdminRules): void {
    switch (cmd.type) {
      case 'shootStart':
        if (
          !this.guestSlot.isBenched &&
          this.guestSlot.role === 'outfield' &&
          (this.phase === 'playing' || this.phase === 'penalty_setup')
        ) {
          this.guestIsChargingShot = true;
          this.guestShotCharge = 0.08;
          this.guestAimCurl = 0;
        }
        break;

      case 'shootRelease':
        if (this.guestIsChargingShot) {
          this.handleHumanShootRelease('guest');
          this.guestIsChargingShot = false;
          this.guestShotCharge = 0;
          this.guestAimCurl = 0;
        }
        break;

      case 'pass':
        this.handleHumanPassOrTackle('guest');
        break;

      case 'lobPass':
        this.handleHumanLobPass(cmd.holdRatio ?? 0.5, 'guest');
        break;

      case 'knockOn':
        this.handleHumanKnockOn('guest');
        break;

      case 'skillMove':
        this.handleHumanSkillMove('guest');
        break;

      case 'slideTackle':
        this.handleHumanSlideTackle('guest');
        break;

      case 'dive':
        this.handleHumanDive(rules, 'guest');
        break;

      case 'protest':
        this.handleHumanProtest(rules, 'guest');
        break;

      case 'switchPlayer':
        this.handleSwitchPlayer(rules, 'guest');
        break;

      case 'gkDive':
        this.handleHumanGKDive(cmd.dir, 'guest');
        break;

      case 'gkThrow':
        this.handleHumanGKThrow('guest');
        break;

      case 'refWhistle':
        if (this.guestSlot.role === 'referee') {
          this.handleRefWhistle();
        }
        break;

      case 'refYellowCard':
        if (this.guestSlot.role === 'referee') {
          this.handleRefCard('yellow', rules);
        }
        break;

      case 'refRedCard':
        if (this.guestSlot.role === 'referee') {
          this.handleRefCard('red', rules);
        }
        break;

      case 'refPenalty':
        if (this.guestSlot.role === 'referee') {
          this.handleRefPenalty(rules);
        }
        break;

      case 'refStartVAR':
        if (this.guestSlot.role === 'referee') {
          this.handleRefStartVAR(rules, cmd.reason);
        }
        break;

      case 'refVARVerdict':
        if (this.guestSlot.role === 'referee') {
          this.applyVARVerdict(cmd.verdict);
        }
        break;

      case 'coachSubToBench':
        if (this.guestSlot.role === 'coach') {
          this.handleCoachSubToBench(cmd.playerId, rules);
        }
        break;

      case 'coachTactic':
        if (this.guestSlot.role === 'coach') {
          this.applyTeamTactic(cmd.team, cmd.stance, true);
        }
        break;

      case 'benchEmote':
        this.handleBenchEmote(cmd.kind, 'guest');
        break;

      case 'benchRequestReturn':
        this.handleBenchRequestReturn('guest');
        break;

      case 'spectatorCheer':
        this.triggerSpectatorReaction('cheer');
        break;

      case 'spectatorBoo':
        this.triggerSpectatorReaction('boo');
        break;

      case 'spectatorFireworks':
        this.triggerSpectatorReaction('fireworks');
        break;

      case 'skipGoalReplay':
        if (this.phase === 'goal_replay') {
          this.finishGoalReplayToKickoff();
        }
        break;

      case 'sandboxSwitchRole':
        this.handleSandboxSwitchRole(cmd.role, cmd.team, cmd.benchSelf, rules, 'guest');
        break;

      default:
        break;
    }
  }

  private maybeTickHostSnapshotBroadcast(dt: number): void {
    if (!this.isHostWithGuest() || this.phase === 'menu' || this.phase === 'lobby') return;
    this.hostSnapshotAccum += dt;
    const interval = 1 / HOST_SNAPSHOT_HZ;
    if (this.hostSnapshotAccum >= interval) {
      this.hostSnapshotAccum %= interval;
      this.broadcastWorldSnapshot();
    }
  }

  private broadcastWorldSnapshot(): void {
    if (!this.isHostWithGuest() || !this.networkManager) return;

    this.snapshotSeq += 1;
    const guestRt = this.getActorRuntime('guest');
    const ballVis = this.ball.getVisualTransform();
    const sourcePlayers =
      this.replayDisplayPlayers ?? this.entities.map((rt) => rt.entity);

    const varState: VARState = this.varCtx
      ? {
          active: true,
          progress: this.replayRecorder.getLoopProgress(this.varCtx.replayElapsed, 0.35),
          reason: this.varCtx.reason,
          replayElapsed: this.varCtx.replayElapsed,
          replayDuration: Math.max(0.1, this.replayRecorder.getDuration()),
        }
      : {
          active: false,
          progress: 0,
          reason: '',
          replayElapsed: 0,
          replayDuration: 4,
        };

    const events =
      this.pendingSnapshotEvents.length > 0
        ? this.pendingSnapshotEvents.splice(0, this.pendingSnapshotEvents.length)
        : undefined;
    const sfx =
      this.pendingSnapshotSfx.length > 0
        ? this.pendingSnapshotSfx.splice(0, this.pendingSnapshotSfx.length)
        : undefined;

    const snapshot: WorldSnapshotPacket = {
      seq: this.snapshotSeq,
      hostTime: performance.now(),
      phase: this.phase,
      clockSec: this.clockSec,
      score: { ...this.score },
      players: sourcePlayers.map((p) => ({
        ...p,
        pos: { ...p.pos },
      })),
      hostControlledId: this.controlledPlayerId,
      guestControlledId: this.guestControlledId,
      ball: {
        pos: { ...ballVis.pos },
        vel: { ...this.ball.state.vel },
        spin: { ...this.ball.state.spin },
        isSuperShot: this.ball.state.isSuperShot,
        lastTouchPlayerId: this.ball.state.lastTouchPlayerId,
        lastTouchTeam: this.ball.state.lastTouchTeam,
        quat: [ballVis.quat[0], ballVis.quat[1], ballVis.quat[2], ballVis.quat[3]],
      },
      tactics: { ...this.tactics },
      varState,
      goalReplayState: { ...this.goalReplayState },
      hitStopRemaining: this.hitStopRemaining,
      guestStamina: guestRt ? guestRt.entity.stamina : 100,
      guestShotCharge: this.guestShotCharge,
      guestPrecisionZone: this.computePrecisionZone(
        this.guestShotCharge,
        this.guestIsChargingShot
      ),
      guestSkillCd: guestRt ? guestRt.skillCooldown : 0,
      guestDiveCd: guestRt ? guestRt.diveCooldown : 0,
      guestGkDiveCd: guestRt ? guestRt.gkDiveCooldown : 0,
      events,
      sfx,
    };

    this.networkManager.broadcastSnapshot(snapshot);
  }

  /* ─────────────── Guest Client: 30Hz Input + 70ms Snapshot Interpolation ─────────────── */

  private dispatchGuestLocalCommand(cmd: GameCommand, rules: AdminRules): void {
    switch (cmd.type) {
      case 'togglePause':
        if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
          this.setPaused(!this.isPaused);
        }
        return;

      case 'move':
        this.externalMoveVec =
          Math.abs(cmd.dx) > 0.01 || Math.abs(cmd.dz) > 0.01
            ? { dx: cmd.dx, dz: cmd.dz }
            : null;
        return;

      case 'sprint':
        this.externalSprint = cmd.active;
        return;

      case 'switchCamera':
        this.handleSwitchCamera(cmd.camera, rules);
        useGameStore.getState().setGuestSlot({ cameraMode: this.activeCamera });
        return;

      case 'shootStart':
        if (
          !this.humanSlot.isBenched &&
          this.humanSlot.role === 'outfield' &&
          (this.phase === 'playing' || this.phase === 'penalty_setup')
        ) {
          this.isChargingShot = true;
          this.shotCharge = 0.08;
          this.aimCurl = 0;
          this.queueGuestCommand(cmd);
        }
        return;

      case 'shootRelease':
        if (this.isChargingShot) {
          this.isChargingShot = false;
          this.shotCharge = 0;
          this.aimCurl = 0;
          this.queueGuestCommand(cmd);
        }
        return;

      case 'gkDive':
        this.guestLocalGKDiveState =
          cmd.dir === 'left' ? 'left' : cmd.dir === 'right' ? 'right' : 'catch';
        this.guestLocalGKDiveTimer = 0.5;
        this.queueGuestCommand(cmd);
        return;

      case 'sandboxSwitchRole': {
        const desiredTeam = cmd.team ?? this.humanSlot.team;
        const rawSlot: HumanSlotConfig = {
          ...this.humanSlot,
          team: desiredTeam,
          role: cmd.benchSelf ? 'outfield' : cmd.role,
          isBenched: Boolean(cmd.benchSelf),
        };
        const resolved = resolveDualHumanSlotConflict(
          useGameStore.getState().hostSlot,
          rawSlot,
          rules
        );
        const normalized = cmd.benchSelf
          ? { ...resolved, isBenched: true, cameraMode: 'bench_cam' as CameraMode }
          : this.normalizeSlotAgainstRules(resolved, rules);
        this.humanSlot = normalized;
        this.activeCamera = normalized.cameraMode;
        useGameStore.getState().setGuestSlot(normalized);
        this.networkManager?.sendGuestSlotUpdate(normalized);
        this.queueGuestCommand(cmd);
        return;
      }

      case 'pass':
      case 'lobPass':
      case 'knockOn':
      case 'skillMove':
      case 'slideTackle':
      case 'dive':
      case 'protest':
      case 'switchPlayer':
      case 'gkThrow':
      case 'refWhistle':
      case 'refYellowCard':
      case 'refRedCard':
      case 'refPenalty':
      case 'refStartVAR':
      case 'refVARVerdict':
      case 'coachSubToBench':
      case 'coachTactic':
      case 'benchEmote':
      case 'benchRequestReturn':
      case 'spectatorCheer':
      case 'spectatorBoo':
      case 'spectatorFireworks':
      case 'skipGoalReplay':
        this.queueGuestCommand(cmd);
        return;

      default:
        return;
    }
  }

  private queueGuestCommand(cmd: GameCommand): void {
    if (this.outgoingGuestCommands.length < 16) {
      this.outgoingGuestCommands.push(cmd);
    }
    // Flush discrete gameplay actions immediately so passes, shots, and GK dives have zero queueing lag!
    this.sendGuestInputPacketNow();
  }

  private sendGuestInputPacketNow(): void {
    if (!this.networkManager) return;
    const rawMove = this.getHumanMoveInput();
    const axes = this.cameraDirector.getHorizontalAxes();
    const worldX = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
    const worldZ = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
    const moveNorm = normalizeXZ(worldX, worldZ);

    const penAimOffset = this.phase === 'penalty_setup' ? -rawMove.dx * 0.35 : 0;
    const aimAngle = Math.atan2(this.humanAimDir.x, this.humanAimDir.z) + penAimOffset;
    const cmds = this.outgoingGuestCommands.splice(0, this.outgoingGuestCommands.length);

    this.guestInputSeq += 1;
    this.guestInputAccum = 0;

    this.networkManager.sendGuestInput({
      seq: this.guestInputSeq,
      clientTime: performance.now(),
      moveDx: moveNorm.x,
      moveDz: moveNorm.z,
      aimAngle,
      sprint: this.inputManager.isSprinting() || this.externalSprint,
      commands: cmds,
      slot: { ...this.humanSlot },
    });
  }

  private playRemoteSfxItem(item: { kind: string; power?: number }): void {
    switch (item.kind) {
      case 'kick':
        this.rawSound.playKick(item.power ?? 0.6);
        break;
      case 'whistle_short':
        this.rawSound.playWhistle('short');
        break;
      case 'whistle_long':
        this.rawSound.playWhistle('long');
        break;
      case 'whistle_double':
        this.rawSound.playWhistle('double');
        break;
      case 'post_clang':
        this.rawSound.playPostClang();
        this.cameraDirector.triggerShake(0.32, 0.25);
        this.effects.spawnBurst(this.ball.state.pos, 0xfbbf24, 18, 4.5);
        break;
      case 'goal_celebration':
        this.rawSound.playGoalCelebration();
        break;
      case 'crowd_cheer':
        this.rawSound.playCrowdReaction('cheer');
        break;
      case 'crowd_ooh':
        this.rawSound.playCrowdReaction('ooh');
        break;
      case 'crowd_boo':
        this.rawSound.playCrowdReaction('boo');
        break;
      case 'card_yellow':
        this.rawSound.playCard('yellow');
        break;
      case 'card_red':
        this.rawSound.playCard('red');
        break;
      case 'var_chime':
        this.rawSound.playVARChime();
        break;
      case 'bench_buzzer':
        this.rawSound.playBenchBuzzer();
        break;
      case 'dive_whoosh':
        this.rawSound.playDiveWhoosh();
        break;
      case 'fireworks':
        this.rawSound.playFireworks();
        this.stadium.triggerCrowdFireworks();
        this.effects.spawnFireworks({ x: -12, y: 12, z: -18 }, 0xfbbf24);
        this.effects.spawnFireworks({ x: 12, y: 14, z: 18 }, 0x00c2ff);
        break;
    }
  }

  private handleNetworkSnapshot(snapshot: WorldSnapshotPacket): void {
    const store = useGameStore.getState();
    if (store.network.mode !== 'guest') return;
    if (snapshot.seq <= this.lastReceivedSnapshotSeq) return;
    this.lastReceivedSnapshotSeq = snapshot.seq;

    // Lobby/Menu state is governed by LobbySyncPacket so role-picker selections are never clobbered
    if (snapshot.phase === 'lobby' || snapshot.phase === 'menu') return;

    // Detect fresh match start / restartMatch from Host -> flush stale snapshots cleanly
    const isFreshMatchStart =
      snapshot.phase === 'kickoff' &&
      (this.phase === 'lobby' ||
        this.phase === 'menu' ||
        this.phase === 'full_time' ||
        snapshot.clockSec > this.clockSec + 5);
    if (isFreshMatchStart) {
      this.guestSnapshotBuffer = [];
      this.guestTimelineInitialized = false;
      this.guestHitStopRemaining = 0;
      this.isPaused = false;
      this.isChargingShot = false;
      this.shotCharge = 0;
      this.aimCurl = 0;
      this.score = { ...snapshot.score };
      this.awards = [];
      store.resetMatchStats();
    }

    // 1. Trigger one-shot events
    if (snapshot.events) {
      for (const ev of snapshot.events) {
        if (!this.seenSnapshotEventIds.has(ev.id)) {
          this.seenSnapshotEventIds.add(ev.id);
          if (this.seenSnapshotEventIds.size > 120) {
            const oldest = this.seenSnapshotEventIds.values().next().value;
            if (oldest !== undefined) this.seenSnapshotEventIds.delete(oldest);
          }
          store.pushComedyEvent(ev);
        }
      }
    }

    // 2. Trigger one-shot procedural SFX
    if (snapshot.sfx) {
      for (const sfx of snapshot.sfx) {
        this.playRemoteSfxItem(sfx);
      }
    }

    // 3. Detect goal scored & trigger 3D net ripple + fireworks + shake on Guest
    if (snapshot.score.red > this.score.red || snapshot.score.blue > this.score.blue) {
      const scoringTeam: TeamId = snapshot.score.red > this.score.red ? 'red' : 'blue';
      const concedingTeam: TeamId = scoringTeam === 'red' ? 'blue' : 'red';
      this.stadium.triggerGoalNetRipple(concedingTeam, snapshot.ball.pos);
      this.stadium.triggerGoalCelebration(scoringTeam);
      this.effects.spawnFireworks(
        { x: snapshot.ball.pos.x, y: 5, z: snapshot.ball.pos.z },
        scoringTeam === 'red' ? 0xff2e4c : 0x00c2ff
      );
      this.cameraDirector.triggerShake(0.65, 0.55);
      this.crowdExcitement = 1.0;
      this.setJumbotronHeadline('جووووول عالمي! ⚽🔥', 5.0);
    }

    // 4. Sync Hit-Stop impact freeze + burst on Guest
    if (snapshot.hitStopRemaining > 0 && snapshot.hitStopRemaining > this.guestHitStopRemaining) {
      this.guestHitStopRemaining = snapshot.hitStopRemaining;
      this.cameraDirector.triggerShake(0.35, 0.22);
      this.effects.spawnBurst(snapshot.ball.pos, 0x34d399, 22, 5.0);
    }

    this.stadium.setVARActive(snapshot.varState.active);

    // 5. Append to interpolation buffer & keep render timeline anchored at hostTime - 70ms
    this.guestSnapshotBuffer.push(snapshot);
    while (this.guestSnapshotBuffer.length > 32) {
      this.guestSnapshotBuffer.shift();
    }

    const targetHostTime = snapshot.hostTime - GUEST_INTERP_DELAY_MS;
    if (
      !this.guestTimelineInitialized ||
      Math.abs(targetHostTime - this.guestRenderHostTime) > 350
    ) {
      this.guestRenderHostTime = targetHostTime;
      this.guestTimelineInitialized = true;
    } else {
      const drift = targetHostTime - this.guestRenderHostTime;
      this.guestRenderHostTime += drift * 0.08;
    }
  }

  private stepGuest(dt: number): void {
    const store = useGameStore.getState();

    // Sync menu/lobby phase when waiting for Host kickoff
    if (
      this.guestSnapshotBuffer.length === 0 &&
      (store.phase === 'menu' || store.phase === 'lobby')
    ) {
      this.phase = store.phase;
    }

    if (this.isPaused || store.isControlsOpen || store.isQuickChatOpen) {
      if (this.inputManager.isPointerLocked() && (this.isPaused || store.isControlsOpen)) {
        this.inputManager.exitPointerLock();
      }
    }

    this.elapsed += dt;
    this.crowdExcitement = Math.max(0.22, this.crowdExcitement - dt * 0.09);
    this.stadium.setCrowdExcitement(this.crowdExcitement);
    this.stadium.update(dt, this.elapsed);

    if (this.guestLocalGKDiveTimer > 0) {
      this.guestLocalGKDiveTimer = Math.max(0, this.guestLocalGKDiveTimer - dt);
      if (this.guestLocalGKDiveTimer <= 0) {
        this.guestLocalGKDiveState = 'none';
      }
    }

    for (const [pid, bubble] of this.localSpeechOverrides) {
      bubble.remaining -= dt;
      if (bubble.remaining <= 0) {
        this.localSpeechOverrides.delete(pid);
      }
    }

    // If no snapshots received yet (e.g. sitting in Lobby), render clean preview backdrop
    if (this.guestSnapshotBuffer.length === 0) {
      this.humanSlot = { ...store.humanSlot };
      this.activeCamera = store.activeCamera;
      this.ball.setTrajectoryVisible(false);
      this.hideAimingGuide();
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt,
        this.elapsed
      );
      this.effects.update(dt, this.ball.state.pos, false);
      this.updateStadiumJumbotron();
      this.updateCameraAndVisuals(dt);
      return;
    }

    // Advance Guest interpolation timeline unless paused by active Rematch Hit-Stop!
    const buf = this.guestSnapshotBuffer;
    const earliest = buf[0];
    const latest = buf[buf.length - 1];

    if (this.guestHitStopRemaining > 0) {
      this.guestHitStopRemaining = Math.max(0, this.guestHitStopRemaining - dt);
    } else {
      this.guestRenderHostTime = clamp(
        this.guestRenderHostTime + dt * 1000,
        earliest.hostTime,
        latest.hostTime
      );
    }

    // Locate bracketing snapshots s0 <= guestRenderHostTime <= s1
    let s0 = earliest;
    let s1 = latest;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].hostTime <= this.guestRenderHostTime && this.guestRenderHostTime <= buf[i + 1].hostTime) {
        s0 = buf[i];
        s1 = buf[i + 1];
        break;
      }
    }
    if (this.guestRenderHostTime >= latest.hostTime) {
      s0 = latest;
      s1 = latest;
    }

    const spanMs = s1.hostTime - s0.hostTime;
    const alpha = spanMs > 0.001 ? clamp((this.guestRenderHostTime - s0.hostTime) / spanMs, 0, 1) : 1;
    const phaseChanged = s0.phase !== s1.phase;
    const activeSnap = alpha < 0.5 && !phaseChanged ? s0 : s1;

    // 1. Interpolate (or snap > 6m) 3D Ball transform
    const ballDist = Math.hypot(
      s1.ball.pos.x - s0.ball.pos.x,
      s1.ball.pos.y - s0.ball.pos.y,
      s1.ball.pos.z - s0.ball.pos.z
    );
    let interpBallPos: Vec3;
    let interpBallQuat: [number, number, number, number];
    if (phaseChanged || ballDist > GUEST_SNAP_DISTANCE_M || s0 === s1) {
      interpBallPos = { ...s1.ball.pos };
      interpBallQuat = [s1.ball.quat[0], s1.ball.quat[1], s1.ball.quat[2], s1.ball.quat[3]];
    } else {
      interpBallPos = {
        x: s0.ball.pos.x + (s1.ball.pos.x - s0.ball.pos.x) * alpha,
        y: s0.ball.pos.y + (s1.ball.pos.y - s0.ball.pos.y) * alpha,
        z: s0.ball.pos.z + (s1.ball.pos.z - s0.ball.pos.z) * alpha,
      };
      this.tmpQuat0.set(s0.ball.quat[0], s0.ball.quat[1], s0.ball.quat[2], s0.ball.quat[3]);
      this.tmpQuat1.set(s1.ball.quat[0], s1.ball.quat[1], s1.ball.quat[2], s1.ball.quat[3]);
      this.tmpQuatOut.slerpQuaternions(this.tmpQuat0, this.tmpQuat1, alpha);
      interpBallQuat = [this.tmpQuatOut.x, this.tmpQuatOut.y, this.tmpQuatOut.z, this.tmpQuatOut.w];
    }

    this.ball.setFrozen(true);
    this.ball.applyVisualTransform(interpBallPos, interpBallQuat);
    this.ball.state.vel = { ...activeSnap.ball.vel };
    this.ball.state.spin = { ...activeSnap.ball.spin };
    this.ball.state.isSuperShot = activeSnap.ball.isSuperShot;
    this.ball.state.lastTouchPlayerId = activeSnap.ball.lastTouchPlayerId;
    this.ball.state.lastTouchTeam = activeSnap.ball.lastTouchTeam;

    // 2. Interpolate (or snap > 6m) Players & remap local/remote human flags for Guest!
    const p0ById = new Map(s0.players.map((p) => [p.id, p]));
    const renderedPlayers: PlayerEntityState[] = s1.players.map((p1) => {
      const p0 = p0ById.get(p1.id);
      const pDist = p0 ? distXZ(p0.pos, p1.pos) : 999;
      const snapEntity = !p0 || phaseChanged || pDist > GUEST_SNAP_DISTANCE_M || s0 === s1;
      const pos: Vec3 = snapEntity
        ? { ...p1.pos }
        : {
            x: p0.pos.x + (p1.pos.x - p0.pos.x) * alpha,
            y: p0.pos.y + (p1.pos.y - p0.pos.y) * alpha,
            z: p0.pos.z + (p1.pos.z - p0.pos.z) * alpha,
          };
      const rotY = snapEntity ? p1.rotY : lerpAngle(p0.rotY, p1.rotY, alpha);
      const localBubble = this.localSpeechOverrides.get(p1.id);

      return {
        ...p1,
        pos,
        rotY,
        animState: !snapEntity && alpha < 0.5 ? p0.animState : p1.animState,
        isHumanControlled: p1.id === activeSnap.guestControlledId,
        isRemoteHuman: p1.id === activeSnap.hostControlledId,
        speechBubble: localBubble ? localBubble.text : p1.speechBubble,
        speechTimer: localBubble ? localBubble.remaining : p1.speechTimer,
      };
    });

    // 3. Sync core Guest phase/score/clock/replay state & handle camera transitions
    const prevPhase = this.phase;
    this.phase = activeSnap.phase;
    this.score = { ...activeSnap.score };
    this.clockSec = activeSnap.clockSec;
    this.tactics = { ...activeSnap.tactics };
    this.goalReplayState = { ...activeSnap.goalReplayState };
    this.controlledPlayerId = activeSnap.guestControlledId;
    this.remoteHostControlledId = activeSnap.hostControlledId;

    const controlledEntity =
      renderedPlayers.find((p) => p.id === activeSnap.guestControlledId) ?? null;

    if (prevPhase !== this.phase) {
      if (
        this.phase === 'kickoff' &&
        (prevPhase === 'lobby' || prevPhase === 'menu' || prevPhase === 'full_time')
      ) {
        this.humanSlot = { ...store.humanSlot, isBenched: false };
        const normSlot = this.normalizeSlotAgainstRules(this.humanSlot, store.rules);
        this.humanSlot = normSlot;
        this.activeCamera = normSlot.cameraMode;
        this.inputManager.resetMouseLook();
        this.inputManager.setFreeYaw(normSlot.team === 'red' ? 0 : Math.PI);
        this.cameraDirector.snapNextFrame();
      } else if (this.phase === 'full_time') {
        this.isChargingShot = false;
        this.shotCharge = 0;
        this.inputManager.exitPointerLock();
        this.awards = this.computeGuestAwardsFromPlayers(renderedPlayers);
      } else if (this.phase === 'var_review' || this.phase === 'goal_replay') {
        this.inputManager.exitPointerLock();
        this.cameraDirector.snapNextFrame();
      } else if (prevPhase === 'var_review' || prevPhase === 'goal_replay') {
        this.activeCamera =
          this.humanSlot.role === 'goalkeeper' && !this.humanSlot.isBenched
            ? 'gk_first_person'
            : this.humanSlot.isBenched
              ? 'bench_cam'
              : this.humanSlot.cameraMode;
        this.cameraDirector.snapNextFrame();
      }
      this.hudSyncAccum = 1; // force immediate store sync on phase transition
    }

    // Detect Coach benching/unbenching Guest player dynamically
    if (controlledEntity && controlledEntity.role === 'outfield') {
      if (controlledEntity.isBenched && !this.humanSlot.isBenched) {
        this.humanSlot.isBenched = true;
        this.activeCamera = 'bench_cam';
        this.humanSlot.cameraMode = 'bench_cam';
        this.inputManager.exitPointerLock();
        this.cameraDirector.snapNextFrame();
      } else if (!controlledEntity.isBenched && this.humanSlot.isBenched) {
        this.humanSlot.isBenched = false;
        this.activeCamera = this.resolveAllowedOutfieldCamera(store.rules);
        this.humanSlot.cameraMode = this.activeCamera;
        this.cameraDirector.snapNextFrame();
      }
    }

    // 4. Update Guest local aim, shot charge & 30Hz GuestInputPacket sender
    this.updateGuestAimAndCurl(dt, controlledEntity);
    if (this.isChargingShot) {
      this.shotCharge = Math.min(1, this.shotCharge + dt * 1.05);
    }

    if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
      this.guestInputAccum += dt;
      if (this.guestInputAccum >= 1 / GUEST_INPUT_HZ) {
        this.sendGuestInputPacketNow();
      }
    }

    // 5. Render 3D Characters, Particles, GK Trajectory, AimingGuide3D, Camera + FP Gloves, Jumbotron
    const animScale =
      this.phase === 'var_review'
        ? 0.35
        : this.phase === 'goal_replay'
          ? 0.55
          : this.guestHitStopRemaining > 0
            ? 0.12
            : 1.0;

    this.characters.syncPlayers(renderedPlayers, dt * animScale, this.elapsed);
    this.effects.update(dt * animScale, interpBallPos, activeSnap.ball.isSuperShot);
    this.updateBallTrajectoryGuide();
    this.updateGuestAimingGuideVisual(controlledEntity, renderedPlayers, activeSnap);
    this.updateGuestCameraAndVisuals(dt, controlledEntity, interpBallPos);
    this.updateStadiumJumbotron();

    // 6. Compute Referee nearest target for Guest Referee HUD & sync Zustand store (~20Hz)
    const refEntity = renderedPlayers.find((p) => p.role === 'referee');
    let guestNearestRefTarget: string | null = null;
    if (refEntity) {
      let bestD = 11.5;
      for (const p of renderedPlayers) {
        if (p.role === 'referee' || p.role === 'coach' || p.isBenched || p.isSentOff) continue;
        const d = distXZ(refEntity.pos, p.pos);
        if (d < bestD) {
          bestD = d;
          guestNearestRefTarget = p.id;
        }
      }
    }
    this.nearestRefTargetId = guestNearestRefTarget;

    this.hudSyncAccum += dt;
    if (this.hudSyncAccum >= 0.05) {
      this.hudSyncAccum = 0;
      const effectiveCharge = this.isChargingShot
        ? Math.max(this.shotCharge, activeSnap.guestShotCharge)
        : activeSnap.guestShotCharge;
      const effectiveZone = this.isChargingShot
        ? this.computePrecisionZone(effectiveCharge, true)
        : activeSnap.guestPrecisionZone;

      store.updateMatchSnapshot({
        phase: this.phase,
        score: { ...this.score },
        clockSec: this.clockSec,
        players: renderedPlayers,
        controlledPlayerId: activeSnap.guestControlledId,
        nearestRefTargetId: guestNearestRefTarget,
        shotCharge: effectiveCharge,
        aimPrecisionZone: effectiveZone,
        aimCurl: this.aimCurl,
        pointerLocked: this.inputManager.isPointerLocked(),
        physicsBackend: this.ball.isRapierReady?.() ? 'rapier3d' : 'fallback',
        stamina: activeSnap.guestStamina,
        skillCooldown: activeSnap.guestSkillCd,
        diveCooldown: activeSnap.guestDiveCd,
        gkDiveCooldown: activeSnap.guestGkDiveCd,
        tactics: { ...this.tactics },
        varState: { ...activeSnap.varState },
        goalReplayState: { ...activeSnap.goalReplayState },
        awards: this.awards,
        activeCamera: this.activeCamera,
        isPaused: this.isPaused,
        humanSlot: { ...this.humanSlot },
      });
    }
  }

  private updateGuestAimAndCurl(dt: number, controlled: PlayerEntityState | null): void {
    if (controlled && this.activeCamera === 'broadcast_top') {
      const ndc = this.inputManager.getMouseNDC();
      const groundHit = this.cameraDirector.raycastGround(ndc.x, ndc.y);
      if (groundHit) {
        const dx = groundHit.x - controlled.pos.x;
        const dz = groundHit.z - controlled.pos.z;
        if (Math.hypot(dx, dz) > 0.35) {
          this.humanAimDir = normalizeXZ(dx, dz);
        }
      }
    } else {
      const { yaw } = this.inputManager.getFreeLook();
      this.humanAimDir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    }

    if (this.isChargingShot) {
      const curlDelta = this.inputManager.consumeCurlDelta();
      const rawMove = this.getHumanMoveInput();
      const kbSteer = this.activeCamera === 'player_third' ? rawMove.dx * dt * 1.15 : 0;
      this.aimCurl = clamp(this.aimCurl + curlDelta + kbSteer, -1, 1);
    } else {
      this.aimCurl = 0;
    }
  }

  private updateGuestAimingGuideVisual(
    controlled: PlayerEntityState | null,
    players: ReadonlyArray<PlayerEntityState>,
    snap: WorldSnapshotPacket
  ): void {
    if (!this.aimingGuide) return;
    const show =
      Boolean(controlled) &&
      this.humanSlot.role === 'outfield' &&
      !this.humanSlot.isBenched &&
      (this.phase === 'playing' || this.phase === 'penalty_setup' || this.phase === 'kickoff');

    if (!show || !controlled) {
      this.hideAimingGuide();
      return;
    }

    const aim = normalizeXZ(this.humanAimDir.x, this.humanAimDir.z);
    const hasBallNearby = distXZ(controlled.pos, snap.ball.pos) < 2.8;
    let passTargetPos: Vec3 | null = null;
    if (hasBallNearby) {
      const minConeCos = Math.cos((24 * Math.PI) / 180);
      let bestScore = -Infinity;
      for (const tm of players) {
        if (
          tm.id === controlled.id ||
          tm.team !== controlled.team ||
          tm.role !== 'outfield' ||
          tm.isBenched ||
          tm.isSentOff
        ) {
          continue;
        }
        const toTm = normalizeXZ(tm.pos.x - controlled.pos.x, tm.pos.z - controlled.pos.z);
        const dot = toTm.x * aim.x + toTm.z * aim.z;
        if (dot < minConeCos) continue;
        const dist = distXZ(controlled.pos, tm.pos);
        const s = dot * 18 - dist * 0.16;
        if (s > bestScore) {
          bestScore = s;
          passTargetPos = tm.pos;
        }
      }
    }

    const teamColor =
      controlled.team === 'blue'
        ? this.stadium.config.colors.blueTeam
        : this.stadium.config.colors.redTeam;
    const effectiveCharge = this.isChargingShot
      ? Math.max(this.shotCharge, snap.guestShotCharge)
      : snap.guestShotCharge;

    this.aimingGuide.update({
      visible: true,
      playerPos: controlled.pos,
      aimDir: aim,
      charge: effectiveCharge,
      curl: this.aimCurl,
      isCharging: this.isChargingShot || snap.guestShotCharge > 0.05,
      ballPos: snap.ball.pos,
      passTargetPos,
      teamColor,
      elapsed: this.elapsed,
    });
  }

  private updateGuestCameraAndVisuals(
    dt: number,
    controlled: PlayerEntityState | null,
    ballPos: Vec3
  ): void {
    let gkDiveState: GKDiveVisualState = 'none';
    if (controlled && controlled.role === 'goalkeeper') {
      if (this.guestLocalGKDiveState !== 'none') {
        gkDiveState = this.guestLocalGKDiveState;
      } else if (controlled.animState === 'gk_dive_left') {
        gkDiveState = 'left';
      } else if (controlled.animState === 'gk_dive_right') {
        gkDiveState = 'right';
      } else if (controlled.animState === 'gk_catch') {
        gkDiveState = 'catch';
      }
    }

    const effectiveCamMode: CameraMode =
      this.phase === 'var_review' || this.phase === 'goal_replay'
        ? 'var_replay_cam'
        : this.activeCamera;

    const freeLook = this.inputManager.getFreeLook();
    const sprinting =
      (this.inputManager.isSprinting() || this.externalSprint) &&
      (controlled ? controlled.stamina > 4 : false);

    const camOut = this.cameraDirector.update(dt, this.elapsed, {
      phase: this.phase,
      cameraMode: effectiveCamMode,
      config: this.stadium.config,
      ballPos,
      ballVel: this.ball.state.vel,
      controlledPlayer: controlled,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
      freeYaw: freeLook.yaw,
      freePitch: freeLook.pitch,
      isSprinting: sprinting,
      gkDiveState,
      benchSeatPos: this.stadium.getBenchSeatPosition(this.humanSlot.team, 0),
      varFocusPos: {
        x: ballPos.x * 0.75,
        y: Math.max(0.9, ballPos.y),
        z: ballPos.z,
      },
    });

    this.characters.updateFPGloves(
      this.camera,
      camOut.isFirstPersonGK,
      camOut.gkDiveState,
      dt
    );
  }

  private computeGuestAwardsFromPlayers(players: ReadonlyArray<PlayerEntityState>): MatchAward[] {
    const winningTeam: TeamId = this.score.blue > this.score.red ? 'blue' : 'red';
    const topScorer =
      players.find((p) => p.team === winningTeam && p.role === 'outfield' && !p.isBenched) ??
      players.find((p) => p.role === 'outfield');
    const diver =
      players.find((p) => p.role === 'outfield' && p.id !== topScorer?.id) ?? topScorer;
    const carded =
      [...players]
        .filter((p) => p.role === 'outfield')
        .sort((a, b) => (b.isSentOff ? 5 : 0) + b.yellowCards - ((a.isSentOff ? 5 : 0) + a.yellowCards))[0];
    const gk =
      players.find((p) => p.role === 'goalkeeper' && p.team === winningTeam) ??
      players.find((p) => p.role === 'goalkeeper');

    return [
      {
        title: 'هدّاف الليلة',
        playerName: topScorer ? topScorer.name : 'النسور الحمر',
        reason: 'ولّع الشباك وهز المدرجات في سهرة الأونلاين!',
        emoji: '⚽',
      },
      {
        title: 'أوسكار أحسن غطاس',
        playerName: diver ? diver.name : 'شيكابالا الساحر',
        reason: 'أداء درامي وتمثيل عالي قدام الحكم!',
        emoji: '🎭',
      },
      {
        title: 'زبون الطرد والكروت',
        playerName: carded ? carded.name : 'وائل صخرة',
        reason:
          carded && (carded.yellowCards > 0 || carded.isSentOff)
            ? `جمع ${carded.yellowCards} كروت صفراء في ملحمة الليلة!`
            : 'زحلقات نارية في نص الملعب بلا رحمة!',
        emoji: '🟥',
      },
      {
        title: 'سد منيع',
        playerName: gk ? gk.name : 'الشناوي جونيور',
        reason: 'واقف زي الأخطبوط في المرمى طول الماتش!',
        emoji: '🧤',
      },
    ];
  }
}
