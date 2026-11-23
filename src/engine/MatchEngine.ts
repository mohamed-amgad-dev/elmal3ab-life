import type * as THREE from 'three';
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
  IBallPhysics,
  ICharacterSystem,
  IEffectsManager,
  IMatchEngine,
  ISoundEngine,
  IStadiumScene,
} from '../types/engine';
import type {
  AdminRules,
  CameraMode,
  CharacterAnimState,
  ComedyEventTone,
  GameCommand,
  HumanSlotConfig,
  MatchAward,
  MatchPhase,
  OutfieldPosition,
  PlayerEntityState,
  RoleType,
  TacticalStance,
  TeamId,
  VARState,
  VARVerdict,
  Vec3,
} from '../types/game';

export interface MatchEngineDeps {
  stadium: IStadiumScene;
  characters: ICharacterSystem;
  ball: IBallPhysics;
  effects: IEffectsManager;
  sound: ISoundEngine;
  camera: THREE.PerspectiveCamera;
  onRender?: () => void;
}

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
  gkDiveState: GKDiveVisualState;
  gkDiveDirVec: Vec3;
  slideDirVec: Vec3;
  slideTimer: number;
  jukeImmuneTimer: number;
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
  private readonly sound: ISoundEngine;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly onRender?: () => void;

  private readonly cameraDirector: CameraDirector;
  private readonly replayRecorder = new ReplayRecorder();
  private readonly inputManager: InputManager;
  private readonly outfieldAI = new OutfieldAI();
  private readonly gkAI = new GoalkeeperAI();
  private readonly refAI = new RefereeAI();
  private readonly coachAI = new CoachAI();

  private readonly unsubCommandBus: () => void;

  private rafId: number | null = null;
  private lastFrameMs = 0;
  private elapsed = 0;
  private hudSyncAccum = 0;
  private running = false;
  private disposed = false;

  // Match simulation state
  private phase: MatchPhase = 'menu';
  private isPaused = false;
  private score: Record<TeamId, number> = { red: 0, blue: 0 };
  private clockSec = 180;
  private tactics: Record<TeamId, TacticalStance> = {
    red: 'balanced',
    blue: 'balanced',
  };
  private humanSlot: HumanSlotConfig = { ...useGameStore.getState().humanSlot };
  private activeCamera: CameraMode = useGameStore.getState().activeCamera;

  private entities: EntityRuntime[] = [];
  private controlledPlayerId: string | null = null;
  private nearestRefTargetId: string | null = null;
  private possessorId: string | null = null;
  private gkCaughtById: string | null = null;
  private gkCatchHoldTimer = 0;
  private gkSaveGraceTimer = 0;

  // Human shot charge & direct move override
  private isChargingShot = false;
  private shotCharge = 0;
  private externalMoveVec: { dx: number; dz: number } | null = null;
  private externalSprint = false;

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
    this.sound = deps.sound;
    this.camera = deps.camera;
    this.onRender = deps.onRender;

    this.cameraDirector = new CameraDirector(this.camera);
    this.inputManager = new InputManager({
      onUserGesture: () => this.sound.unlock(),
    });

    this.unsubCommandBus = commandBus.subscribe((cmd) => {
      this.dispatchCommand(cmd);
    });

    // Spawn preview players on the pitch for the cinematic menu/lobby backdrop
    this.spawnRoster(useGameStore.getState().rules);
    this.positionForKickoff();
    this.ball.reset({ x: 0, y: 0.22, z: 0 });
    this.syncStoreImmediate();
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
    }
    this.syncStoreImmediate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unsubCommandBus();
    this.inputManager.dispose();
    this.ball.setTrajectoryVisible(false);
    this.stadium.setVARActive(false);
  }

  dispatchCommand(cmd: GameCommand): void {
    if (this.disposed) return;
    this.sound.unlock();

    const store = useGameStore.getState();
    const rules = store.rules;

    switch (cmd.type) {
      case 'startMatch':
      case 'restartMatch':
        this.startNewMatch();
        break;

      case 'returnToLobby':
        this.isPaused = false;
        this.varCtx = null;
        this.penaltyCtx = null;
        this.replayRecorder.unfreeze();
        this.stadium.setVARActive(false);
        this.ball.setFrozen(false);
        this.ball.setTrajectoryVisible(false);
        this.phase = 'lobby';
        this.positionForKickoff();
        this.ball.reset({ x: 0, y: 0.22, z: 0 });
        this.syncStoreImmediate();
        break;

      case 'togglePause':
        if (this.phase !== 'menu' && this.phase !== 'lobby' && this.phase !== 'full_time') {
          this.setPaused(!this.isPaused);
        }
        break;

      case 'toggleMute': {
        const nextMuted = !this.sound.isMuted();
        this.sound.setMuted(nextMuted);
        store.setMuted(nextMuted);
        break;
      }

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
        this.handleSwitchPlayer(rules);
        break;

      case 'pass':
        this.handleHumanPassOrTackle();
        break;

      case 'shootStart':
        if (
          !this.humanSlot.isBenched &&
          this.humanSlot.role === 'outfield' &&
          (this.phase === 'playing' || this.phase === 'penalty_setup')
        ) {
          this.isChargingShot = true;
          this.shotCharge = 0.08;
        }
        break;

      case 'shootRelease':
        if (this.isChargingShot) {
          this.handleHumanShootRelease();
          this.isChargingShot = false;
          this.shotCharge = 0;
        }
        break;

      case 'skillMove':
        this.handleHumanSkillMove();
        break;

      case 'slideTackle':
        this.handleHumanSlideTackle();
        break;

      case 'dive':
        this.handleHumanDive(rules);
        break;

      case 'protest':
        this.handleHumanProtest(rules);
        break;

      case 'gkDive':
        this.handleHumanGKDive(cmd.dir);
        break;

      case 'gkThrow':
        this.handleHumanGKThrow();
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
        this.handleBenchEmote(cmd.kind);
        break;

      case 'benchRequestReturn':
        this.handleBenchRequestReturn();
        break;

      case 'spectatorCheer':
        this.sound.playCrowdReaction('cheer');
        this.crowdExcitement = 1.0;
        this.stadium.setCrowdExcitement(1.0);
        this.pushEvent('المدرجات ولعت تشجيع وهتافات! 🎉🔥', '🎉', 'crowd');
        break;

      case 'spectatorBoo':
        this.sound.playCrowdReaction('boo');
        this.crowdExcitement = 0.78;
        this.stadium.setCrowdExcitement(0.78);
        this.pushEvent('صافرات استهجان تهز أرجاء الاستاد! 📣😤', '📣', 'crowd');
        break;

      case 'spectatorFireworks':
        this.sound.playFireworks();
        this.stadium.triggerCrowdFireworks();
        this.effects.spawnFireworks({ x: -12, y: 12, z: -18 }, 0xfbbf24);
        this.effects.spawnFireworks({ x: 12, y: 14, z: 18 }, 0x00c2ff);
        this.crowdExcitement = 1.0;
        this.stadium.setCrowdExcitement(1.0);
        this.pushEvent('ألعاب نارية وشماريخ في سماء الملعب! 🎆✨', '🎆', 'crowd');
        break;

      case 'sandboxSwitchRole':
        this.handleSandboxSwitchRole(cmd.role, cmd.team, cmd.benchSelf, rules);
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

    // Sync menu/lobby phase driven externally by UI (e.g. MainMenu -> Lobby)
    if (
      (store.phase === 'menu' || store.phase === 'lobby') &&
      (this.phase === 'menu' || this.phase === 'lobby')
    ) {
      this.phase = store.phase;
    }

    if (this.isPaused) {
      // Keep stadium lights/camera alive gently without advancing match clock or physics
      this.stadium.update(dt * 0.25, this.elapsed);
      this.updateCameraAndVisuals(dt);
      return;
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
      this.ball.setTrajectoryVisible(false);
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt,
        this.elapsed
      );
      this.effects.update(dt, this.ball.state.pos, false);
      this.updateCameraAndVisuals(dt);
      return;
    }

    if (this.phase === 'var_review') {
      this.stepVARReview(dt);
      return;
    }

    // Active match phases: kickoff, playing, paused_whistle, penalty_setup, goal_celebration
    this.stepActiveMatch(dt, store.rules);
  }

  private stepActiveMatch(dt: number, rules: AdminRules): void {
    const config = this.stadium.config;

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
      this.celebrationTimer -= dt;
      if (this.celebrationTimer <= 0) {
        this.positionForKickoff();
        this.ball.reset({ x: 0, y: 0.22, z: 0 });
        this.phase = 'kickoff';
        this.kickoffTimer = 1.0;
        this.syncStoreImmediate();
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

    // 2. Charge human shot if holding E/RMB
    if (this.isChargingShot) {
      this.shotCharge = Math.min(1, this.shotCharge + dt * 1.25);
    }

    // 3. Cooldowns on every entity
    for (const rt of this.entities) {
      rt.animLockTimer = Math.max(0, rt.animLockTimer - dt);
      rt.kickCooldown = Math.max(0, rt.kickCooldown - dt);
      rt.skillCooldown = Math.max(0, rt.skillCooldown - dt);
      rt.slideCooldown = Math.max(0, rt.slideCooldown - dt);
      rt.diveCooldown = Math.max(0, rt.diveCooldown - dt);
      rt.gkDiveCooldown = Math.max(0, rt.gkDiveCooldown - dt);
      rt.jukeImmuneTimer = Math.max(0, rt.jukeImmuneTimer - dt);

      if (rt.slideTimer > 0) {
        rt.slideTimer = Math.max(0, rt.slideTimer - dt);
      }
      if (rt.animLockTimer <= 0 && rt.gkDiveState !== 'none' && rt.gkDiveState !== 'catch') {
        rt.gkDiveState = 'none';
      }
    }

    // 4. Update all entities (Human + AI)
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

    // 5. Update ball physics + possession + GK catches/saves + goal detection
    this.stepBallAndInteractions(dt);

    // 6. Compute nearest target for Referee HUD
    this.updateNearestRefTarget();

    // 7. Record replay frame for VAR slow-motion playback
    if (this.phase === 'playing' || this.phase === 'goal_celebration' || this.phase === 'penalty_setup') {
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

    // 8. Sync 3D characters, particles, trajectory line, and camera
    this.updateBallTrajectoryGuide();
    this.characters.syncPlayers(
      this.entities.map((e) => e.entity),
      dt,
      this.elapsed
    );
    this.effects.update(dt, this.ball.state.pos, this.ball.state.isSuperShot);
    this.updateCameraAndVisuals(dt);

    // 9. Throttled HUD store sync (~20Hz)
    this.hudSyncAccum += dt;
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

      this.characters.syncPlayers(replayPlayers, dt * 0.35, this.elapsed);
      this.effects.update(dt * 0.35, sampled.ball.pos, sampled.ball.isSuperShot);
    } else {
      this.characters.syncPlayers(
        this.entities.map((e) => e.entity),
        dt * 0.35,
        this.elapsed
      );
      this.effects.update(dt * 0.35, this.ball.state.pos, false);
    }

    // Let AI Referee deliberate and issue a verdict if human isn't referee
    const refRt = this.entities.find((e) => e.entity.role === 'referee');
    if (refRt) {
      const refDecision = this.refAI.evaluate({
        ref: refRt.entity,
        ballPos: focusPos,
        config: this.stadium.config,
        rules: useGameStore.getState().rules,
        isHumanRef: this.humanSlot.role === 'referee' && !this.humanSlot.isBenched,
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
    this.cameraDirector.update(dt, this.elapsed, {
      phase: 'var_review',
      cameraMode: 'var_replay_cam',
      config: this.stadium.config,
      ballPos: focusPos,
      ballVel: { x: 0, y: 0, z: 0 },
      controlledPlayer: this.getControlledRuntime()?.entity ?? null,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
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
      if (this.penaltyCtx?.shooterId === p.id && p.isHumanControlled) {
        // Human penalty taker can subtly aim with A/D
        const move = this.getHumanMoveInput();
        const aimAngle = p.team === 'red' ? 0 : Math.PI;
        p.rotY = aimAngle - move.dx * 0.35;
      }
      if (rt.animLockTimer <= 0) p.animState = 'idle';
      return;
    }

    if (!canMove) {
      if (rt.animLockTimer <= 0) p.animState = 'idle';
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
      const sprinting = (this.inputManager.isSprinting() || this.externalSprint) && p.stamina > 4;
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
      const speed = moving ? baseSpeed + sprintBonus + skillBonus : 0;

      p.pos.x += worldX * speed * dt;
      p.pos.z += worldZ * speed * dt;
      rt.vx = worldX * speed;
      rt.vz = worldZ * speed;

      if (moving) {
        const targetYaw = Math.atan2(worldX, worldZ);
        p.rotY = lerpAngle(p.rotY, targetYaw, 1 - Math.exp(-14 * dt));
      }

      // Stamina drain/regen
      if (moving && sprinting) {
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

    if (gk.isHumanControlled) {
      const rawMove = this.getHumanMoveInput();
      const axes = this.cameraDirector.getHorizontalAxes();
      const wx = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
      const wz = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
      const dir = normalizeXZ(wx, wz);
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

    if (ref.isHumanControlled) {
      const rawMove = this.getHumanMoveInput();
      const axes = this.cameraDirector.getHorizontalAxes();
      const wx = axes.right.x * rawMove.dx + axes.forward.x * rawMove.dz;
      const wz = axes.right.z * rawMove.dx + axes.forward.z * rawMove.dz;
      const dir = normalizeXZ(wx, wz);
      const moving = Math.hypot(dir.x, dir.z) > 0.05;
      const sprinting = this.inputManager.isSprinting() || this.externalSprint;
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
      this.humanSlot.role === 'coach' &&
      this.humanSlot.team === team &&
      !this.humanSlot.isBenched;

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

    // If AI is taking the penalty, count down tension beat then fire!
    if (!shooter.entity.isHumanControlled) {
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
        // Auto-release after 3.5s for human GK so play never stalls
        if (gkRt.entity.isHumanControlled && this.gkCatchHoldTimer >= 3.5) {
          this.releaseGKCatch(gkRt, { x: 0, y: 0, z: forwardZ });
        }
        return;
      } else {
        this.gkCaughtById = null;
      }
    }

    // 2. Step ball physics
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
        // Generous arcade save radius, especially rewarding for human FP GK!
        const reachXZ = isDiving
          ? gk.isHumanControlled
            ? 3.1
            : 2.35
          : gk.isHumanControlled
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
      const dribbleAnchor: Vec3 = {
        x: p.pos.x + Math.sin(p.rotY) * 0.88,
        y: 0.22,
        z: p.pos.z + Math.cos(p.rotY) * 0.88,
      };
      const toAnchorX = dribbleAnchor.x - ballPos.x;
      const toAnchorZ = dribbleAnchor.z - ballPos.z;
      const toAnchorDist = Math.hypot(toAnchorX, toAnchorZ);
      const playerSpeed = Math.hypot(closestCarrier.vx, closestCarrier.vz);

      if (toAnchorDist > 0.14 || playerSpeed > 0.5) {
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

    gkRt.saves += 1;
    this.possessorId = null;
    this.gkSaveGraceTimer = 0.55;

    if (incomingSpeed > 11) {
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
        rt.animLockTimer = 3.0;
      } else {
        rt.entity.animState = 'protest';
        rt.animLockTimer = 2.0;
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

    this.possessorId = null;
    this.gkCaughtById = null;
    this.phase = 'goal_celebration';
    this.celebrationTimer = 3.0;
    this.syncStoreImmediate();
  }

  private handleHumanPassOrTackle(): void {
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield' || rt.entity.isBenched || rt.entity.isSentOff) return;

    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const dBall = distXZ(p.pos, this.ball.state.pos);

    if (this.phase === 'penalty_setup' && this.penaltyCtx?.shooterId === p.id) {
      const dir = { x: Math.sin(p.rotY), y: 0, z: Math.cos(p.rotY) };
      this.performKick(rt, dir, 24, 0.18, false);
      this.phase = 'playing';
      this.penaltyCtx = null;
      this.syncStoreImmediate();
      return;
    }

    // If close to ball -> Pass to best teammate!
    if (dBall < 2.55 && this.ball.state.pos.y < 1.8) {
      const facing = { x: Math.sin(p.rotY), y: 0, z: Math.cos(p.rotY) };
      const teammates = this.entities.filter(
        (e) =>
          e.entity.id !== p.id &&
          e.entity.team === team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff
      );

      let bestTarget: EntityRuntime | null = null;
      let bestScore = -Infinity;
      for (const tm of teammates) {
        const toTm = normalizeXZ(tm.entity.pos.x - p.pos.x, tm.entity.pos.z - p.pos.z);
        const alignment = toTm.x * facing.x + toTm.z * facing.z;
        const dist = distXZ(p.pos, tm.entity.pos);
        const score = alignment * 12 - dist * 0.2;
        if (score > bestScore) {
          bestScore = score;
          bestTarget = tm;
        }
      }

      const passDir = bestTarget
        ? normalizeXZ(bestTarget.entity.pos.x - p.pos.x, bestTarget.entity.pos.z - p.pos.z)
        : facing;
      const dist = bestTarget ? distXZ(p.pos, bestTarget.entity.pos) : 12;
      const power = clamp(13 + dist * 0.52, 15, 23);

      this.performKick(rt, passDir, power, 0.06, false);

      // PES auto-switch to pass receiver when team_switch is active!
      const rules = useGameStore.getState().rules;
      if (
        bestTarget &&
        rules.allowTeamSwitch &&
        this.humanSlot.controlMode === 'team_switch'
      ) {
        this.assignHumanControlTo(bestTarget.entity.id);
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
      this.ball.kick(toBall, 11, 0.05, false, p.id, team);
      this.sound.playKick(0.45);
      rt.tackles += 1;
    }
  }

  private handleHumanShootRelease(): void {
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield' || rt.entity.isBenched || rt.entity.isSentOff) return;
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;

    const p = rt.entity;
    const team: TeamId = p.team === 'blue' ? 'blue' : 'red';
    const dBall = distXZ(p.pos, this.ball.state.pos);
    if (dBall > 2.85 && this.phase !== 'penalty_setup') return;

    const targetGoalZ =
      team === 'red' ? this.stadium.config.halfLength : -this.stadium.config.halfLength;
    const facing = { x: Math.sin(p.rotY), y: 0, z: Math.cos(p.rotY) };
    const toGoal = normalizeXZ(0 - p.pos.x, targetGoalZ - p.pos.z);

    // Subtle arcade goal assist when generally facing opponent goal
    const alignmentWithGoal = facing.x * toGoal.x + facing.z * toGoal.z;
    const blend = alignmentWithGoal > 0.25 ? 0.36 : 0;
    const dir = normalizeXZ(
      facing.x * (1 - blend) + toGoal.x * blend,
      facing.z * (1 - blend) + toGoal.z * blend
    );

    const power = 18 + this.shotCharge * 18;
    const lift = 0.14 + this.shotCharge * 0.34;
    const isSuperShot = this.shotCharge >= 0.78;

    this.performKick(rt, dir, power, lift, isSuperShot);

    if (this.phase === 'penalty_setup') {
      this.phase = 'playing';
      this.penaltyCtx = null;
      this.syncStoreImmediate();
    }
  }

  private handleHumanSkillMove(): void {
    if (this.phase !== 'playing') return;
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield' || rt.skillCooldown > 0) return;
    this.performSkillMove(rt);
  }

  private handleHumanSlideTackle(): void {
    if (this.phase !== 'playing') return;
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield' || rt.slideCooldown > 0) return;
    const dir = { x: Math.sin(rt.entity.rotY), y: 0, z: Math.cos(rt.entity.rotY) };
    this.performSlideTackle(rt, dir);
  }

  private handleHumanDive(rules: AdminRules): void {
    if (this.phase !== 'playing') return;
    if (!rules.enableDivingAndProtests) {
      this.pushEvent('التمثيل والغطس مقفولين بقرار الأدمن 🚫', '🚫', 'dive');
      return;
    }
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield' || rt.diveCooldown > 0) return;
    this.performDive(rt);
  }

  private handleHumanProtest(rules: AdminRules): void {
    if (!rules.enableDivingAndProtests) {
      this.pushEvent('الاعتراض والشغب مقفولين في النظام الكلاسيك 🚫', '🚫', 'dive');
      return;
    }
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'outfield') return;
    this.performProtest(rt);
  }

  private handleHumanGKDive(dir: 'left' | 'right' | 'center'): void {
    if (this.phase !== 'playing' && this.phase !== 'penalty_setup') return;
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'goalkeeper' || rt.gkDiveCooldown > 0) return;
    this.performGKDive(rt, dir);
  }

  private handleHumanGKThrow(): void {
    const rt = this.getControlledRuntime();
    if (!rt || rt.entity.role !== 'goalkeeper') return;
    if (this.gkCaughtById !== rt.entity.id) {
      // Allow quick punt if loose ball is right at GK's feet
      if (distXZ(rt.entity.pos, this.ball.state.pos) < 2.2) {
        const forwardZ = rt.entity.team === 'red' ? 1 : -1;
        this.performKick(rt, { x: 0, y: 0, z: forwardZ }, 24, 0.34, false);
      }
      return;
    }
    const axes = this.cameraDirector.getHorizontalAxes();
    this.releaseGKCatch(rt, axes.forward);
  }

  private handleSwitchPlayer(rules: AdminRules): void {
    if (!rules.allowTeamSwitch || this.humanSlot.controlMode === 'locked_player') {
      this.pushEvent('تبديل اللعيبة مقفول — أنت مقفول على لاعب واحد 🔒', '🔒', 'tactic');
      return;
    }
    if (this.humanSlot.role !== 'outfield' || this.humanSlot.isBenched) return;

    const candidates = this.entities
      .filter(
        (e) =>
          e.entity.team === this.humanSlot.team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff
      )
      .sort(
        (a, b) =>
          distXZ(a.entity.pos, this.ball.state.pos) -
          distXZ(b.entity.pos, this.ball.state.pos)
      );

    if (candidates.length <= 1) return;
    const next =
      candidates[0].entity.id !== this.controlledPlayerId
        ? candidates[0]
        : candidates[1];
    this.assignHumanControlTo(next.entity.id);
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

    this.activeCamera = nextCam;
    this.humanSlot.cameraMode = nextCam;
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

    // Award penalty to whichever team's opponent goal the ball is closer to (or nearest player's team)
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

    // If the benched player was human-controlled -> switch into 3D Bench Cam!
    if (targetRt.entity.isHumanControlled) {
      this.humanSlot.isBenched = true;
      this.activeCamera = 'bench_cam';
      this.humanSlot.cameraMode = 'bench_cam';
      this.cameraDirector.snapNextFrame();
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

  private handleBenchEmote(kind: 'rage' | 'water' | 'shout'): void {
    const rt = this.getControlledRuntime();
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

  private handleBenchRequestReturn(): void {
    if (!this.humanSlot.isBenched) return;
    const benchedHuman = this.getControlledRuntime();
    if (!benchedHuman) return;

    const team: TeamId = this.humanSlot.team;
    const swapOut = this.entities.find(
      (e) =>
        e.entity.team === team &&
        e.entity.role === 'outfield' &&
        !e.entity.isBenched &&
        !e.entity.isSentOff &&
        e.entity.id !== benchedHuman.entity.id
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

    this.humanSlot.isBenched = false;
    this.humanSlot.role = 'outfield';
    this.activeCamera = this.resolveAllowedOutfieldCamera(useGameStore.getState().rules);
    this.humanSlot.cameraMode = this.activeCamera;

    this.sound.playBenchBuzzer();
    this.pushEvent(`المدرب رضي عنك! ${benchedHuman.entity.name} رجع للملعب! 🏃🔥`, '🏃', 'bench');
    this.syncStoreImmediate();
  }

  private handleSandboxSwitchRole(
    role: RoleType,
    teamOverride: TeamId | undefined,
    benchSelf: boolean | undefined,
    rules: AdminRules
  ): void {
    const team: TeamId = teamOverride ?? this.humanSlot.team;

    // Clear previous human flags
    for (const rt of this.entities) {
      rt.entity.isHumanControlled = false;
    }

    // Special Sandbox Bench View toggle!
    if (benchSelf) {
      let target = this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'outfield' && e.entity.isBenched && !e.entity.isSentOff
      );
      if (!target) {
        // Bench an active outfielder onto seat 0
        target = this.entities.find(
          (e) => e.entity.team === team && e.entity.role === 'outfield' && !e.entity.isSentOff
        );
        if (target) {
          target.entity.isBenched = true;
          target.benchSlotIndex = 0;
          target.entity.pos = { ...this.stadium.getBenchSeatPosition(team, 0) };
          target.entity.rotY = -Math.PI / 2;
          target.entity.animState = 'sitting_bench';
        }
      }

      this.humanSlot = {
        ...this.humanSlot,
        team,
        role: 'outfield',
        isBenched: true,
        cameraMode: 'bench_cam',
      };
      this.activeCamera = 'bench_cam';
      if (target) {
        target.entity.isHumanControlled = true;
        this.controlledPlayerId = target.entity.id;
      }
      this.cameraDirector.snapNextFrame();
      this.pushEvent('اتنقلت لدكة البدلاء! شوّح للمدرب 🪑😂', '🪑', 'bench');
      this.syncStoreImmediate();
      return;
    }

    // Normal role switch
    this.humanSlot = {
      ...this.humanSlot,
      team,
      role,
      isBenched: false,
    };

    if (role === 'outfield') {
      const target =
        this.entities.find(
          (e) =>
            e.entity.team === team &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            !e.entity.isSentOff
        ) ?? null;
      if (target) {
        target.entity.isHumanControlled = true;
        this.controlledPlayerId = target.entity.id;
      }
      this.activeCamera = this.resolveAllowedOutfieldCamera(rules);
      this.pushEvent('بدّلت لدور لاعب الملعب! ورّينا المهارة ⚽🔥', '⚽', 'tactic');
    } else if (role === 'goalkeeper') {
      const gk = this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'goalkeeper'
      );
      if (gk) {
        gk.entity.isHumanControlled = true;
        this.controlledPlayerId = gk.entity.id;
      }
      // Strictly lock goalkeeper to FP!
      this.activeCamera = 'gk_first_person';
      this.cameraDirector.snapNextFrame();
      this.inputManager.resetMouseLook();
      this.pushEvent('لبست الجوانتي! حارس مرمى منظور شخصي 🧤🔥', '🧤', 'tactic');
    } else if (role === 'referee') {
      const ref = this.entities.find((e) => e.entity.role === 'referee');
      if (ref) {
        ref.entity.isHumanControlled = true;
        this.controlledPlayerId = ref.entity.id;
      }
      this.activeCamera = 'referee_cam';
      this.sound.playWhistle('short');
      this.pushEvent('الصفّارة في إيدك! احكم بمزاجك 🟨🟥', '🟨', 'card_yellow');
    } else if (role === 'coach') {
      const coach = this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'coach'
      );
      if (coach) {
        coach.entity.isHumanControlled = true;
        this.controlledPlayerId = coach.entity.id;
      }
      this.activeCamera = 'coach_touchline';
      this.pushEvent('بقيت المدير الفني! ظبط التكتيك والدكة 🧥📢', '🧥', 'tactic');
    } else {
      this.controlledPlayerId = null;
      this.activeCamera = 'stands_cam';
      this.pushEvent('طلعت المدرجات تتفرج وتشجع! 🏟️🎉', '🏟️', 'crowd');
    }

    this.humanSlot.cameraMode = this.activeCamera;
    this.syncStoreImmediate();
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

    // If human's controlled outfield player got sent off, transfer to an active teammate if available
    if (targetRt.entity.isHumanControlled && targetRt.entity.role === 'outfield') {
      const nextTeammate = this.entities.find(
        (e) =>
          e.entity.team === targetRt.entity.team &&
          e.entity.role === 'outfield' &&
          !e.entity.isBenched &&
          !e.entity.isSentOff &&
          e.entity.id !== targetRt.entity.id
      );
      if (nextTeammate) {
        this.assignHumanControlTo(nextTeammate.entity.id);
      }
    }
    this.syncStoreImmediate();
  }

  private startPenaltyKick(attackingTeam: TeamId, reason: string): void {
    const defendingTeam: TeamId = attackingTeam === 'red' ? 'blue' : 'red';
    const attackDir = attackingTeam === 'red' ? 1 : -1;
    const spotZ = attackDir * this.stadium.config.penaltySpotZ;
    const goalLineZ = attackDir * (this.stadium.config.halfLength - 0.8);

    // Pick shooter (prefer human if on attacking team outfield)
    const shooter =
      this.entities.find(
        (e) =>
          e.entity.team === attackingTeam &&
          e.entity.role === 'outfield' &&
          e.entity.isHumanControlled &&
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
    this.sound.playVARChime();

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
  }

  private applyVARVerdict(verdict: VARVerdict): void {
    const ctx = this.varCtx;
    if (!ctx) return;

    // Restore live poses & unfreeze replay buffer and ball
    this.replayRecorder.unfreeze();
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
        this.pushEvent('قرار الفار: الهدف صحيح 100%! احتفل يا معلم 📺⚽🔥', '⚽', 'var');
        this.handleGoalScored(ctx.attackingTeam);
        return;

      case 'penalty_awarded':
        this.startPenaltyKick(
          ctx.attackingTeam,
          'قرار الفار: ركلة جزاء مستحقة! 📺🎯🔥'
        );
        return;

      case 'play_on':
        this.phase = 'playing';
        this.pushEvent('قرار الفار: العب مفيش أي حاجة! ✅😂', '✅', 'var');
        break;

      case 'yellow_for_dive': {
        this.phase = 'playing';
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

  private startNewMatch(): void {
    const store = useGameStore.getState();
    const rules = store.rules;

    this.isPaused = false;
    this.varCtx = null;
    this.penaltyCtx = null;
    this.pendingIncident = null;
    this.possessorId = null;
    this.gkCaughtById = null;
    this.isChargingShot = false;
    this.shotCharge = 0;
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

    // Normalize human slot against AdminRules!
    const incomingSlot = { ...store.humanSlot, isBenched: false };
    if (!rules.allowTeamSwitch) {
      incomingSlot.controlMode = 'locked_player';
    }
    if (incomingSlot.role === 'referee' && !rules.enableHumanRef) {
      incomingSlot.role = 'outfield';
    }
    if (incomingSlot.role === 'coach' && !rules.enableCoachBench) {
      incomingSlot.role = 'outfield';
    }

    // Resolve starting camera cleanly (GK ALWAYS locked to gk_first_person!)
    if (incomingSlot.role === 'goalkeeper') {
      incomingSlot.cameraMode = 'gk_first_person';
    } else if (incomingSlot.role === 'referee') {
      incomingSlot.cameraMode = 'referee_cam';
    } else if (incomingSlot.role === 'coach') {
      incomingSlot.cameraMode = 'coach_touchline';
    } else if (incomingSlot.role === 'spectator') {
      incomingSlot.cameraMode = 'stands_cam';
    } else {
      incomingSlot.cameraMode = this.resolveAllowedOutfieldCamera(rules, incomingSlot.cameraMode);
    }

    this.humanSlot = incomingSlot;
    this.activeCamera = incomingSlot.cameraMode;
    this.cameraDirector.snapNextFrame();
    this.inputManager.resetMouseLook();

    store.resetMatchStats();
    this.spawnRoster(rules);
    this.assignInitialHumanEntity();
    this.positionForKickoff();
    this.ball.reset({ x: 0, y: 0.22, z: 0 });

    this.phase = 'kickoff';
    this.kickoffTimer = 1.1;
    this.sound.playWhistle('short');
    this.pushEvent('صفّارة البداية! ولّع يا ملعب الليلة ⚽🌙🔥', '⚽', 'crowd');
    this.syncStoreImmediate();
  }

  private finishMatch(): void {
    this.phase = 'full_time';
    this.isChargingShot = false;
    this.shotCharge = 0;
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
    this.syncStoreImmediate();
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
      entity,
      vx: 0,
      vz: 0,
      animLockTimer: 0,
      kickCooldown: 0,
      skillCooldown: 0,
      slideCooldown: 0,
      diveCooldown: 0,
      gkDiveCooldown: 0,
      gkDiveState: 'none',
      gkDiveDirVec: { x: 0, y: 0, z: 0 },
      slideDirVec: { x: 0, y: 0, z: 1 },
      slideTimer: 0,
      jukeImmuneTimer: 0,
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

  private assignInitialHumanEntity(): void {
    for (const rt of this.entities) {
      rt.entity.isHumanControlled = false;
    }

    const { role, team, positionRole } = this.humanSlot;
    let chosen: EntityRuntime | undefined;

    if (role === 'outfield') {
      chosen =
        this.entities.find(
          (e) =>
            e.entity.team === team &&
            e.entity.role === 'outfield' &&
            !e.entity.isBenched &&
            e.entity.positionRole === positionRole
        ) ??
        this.entities.find(
          (e) => e.entity.team === team && e.entity.role === 'outfield' && !e.entity.isBenched
        );
    } else if (role === 'goalkeeper') {
      chosen = this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'goalkeeper'
      );
    } else if (role === 'referee') {
      chosen = this.entities.find((e) => e.entity.role === 'referee');
    } else if (role === 'coach') {
      chosen = this.entities.find(
        (e) => e.entity.team === team && e.entity.role === 'coach'
      );
    }

    if (chosen) {
      chosen.entity.isHumanControlled = true;
      this.controlledPlayerId = chosen.entity.id;
    } else {
      this.controlledPlayerId = null;
    }
  }

  private assignHumanControlTo(entityId: string): void {
    for (const rt of this.entities) {
      rt.entity.isHumanControlled = rt.entity.id === entityId;
    }
    this.controlledPlayerId = entityId;
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

    const camOut = this.cameraDirector.update(dt, this.elapsed, {
      phase: this.phase,
      cameraMode: this.activeCamera,
      config: this.stadium.config,
      ballPos: this.ball.state.pos,
      ballVel: this.ball.state.vel,
      controlledPlayer: controlledRt?.entity ?? null,
      humanTeam: this.humanSlot.team,
      mouseLook: this.inputManager.getMouseLook(),
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
    return 'broadcast_top';
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

  private pushEvent(text: string, icon: string, tone: ComedyEventTone): void {
    useGameStore.getState().pushComedyEvent({ text, icon, tone });
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
      stamina: controlledRt ? controlledRt.entity.stamina : 100,
      skillCooldown: controlledRt ? controlledRt.skillCooldown : 0,
      diveCooldown: controlledRt ? controlledRt.diveCooldown : 0,
      gkDiveCooldown: controlledRt ? controlledRt.gkDiveCooldown : 0,
      tactics: { ...this.tactics },
      varState,
      awards: this.awards,
      activeCamera: this.activeCamera,
      isPaused: this.isPaused,
      humanSlot: { ...this.humanSlot },
    });
  }
}
