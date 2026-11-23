import { create } from 'zustand';
import { commandBus } from '../engine/CommandBus';
import {
  DEFAULT_CHAOS_RULES,
  DEFAULT_CLASSIC_RULES,
  DEFAULT_HUMAN_SLOT,
  type AdminRules,
  type CameraMode,
  type ComedyEvent,
  type GameCommand,
  type HumanSlotConfig,
  type MatchAward,
  type MatchPhase,
  type PlayerEntityState,
  type ShotPrecisionZone,
  type TacticalStance,
  type TeamId,
  type VARState,
} from '../types/game';

const MAX_COMEDY_EVENTS = 30;

const INITIAL_VAR_STATE: VARState = {
  active: false,
  progress: 0,
  reason: '',
  replayElapsed: 0,
  replayDuration: 4,
};

export interface MatchSnapshot {
  phase: MatchPhase;
  score: Record<TeamId, number>;
  clockSec: number;
  players: PlayerEntityState[];
  controlledPlayerId: string | null;
  nearestRefTargetId: string | null;
  shotCharge: number;
  aimPrecisionZone: ShotPrecisionZone;
  aimCurl: number;
  pointerLocked: boolean;
  physicsBackend: 'rapier3d' | 'fallback';
  stamina: number;
  skillCooldown: number;
  diveCooldown: number;
  gkDiveCooldown: number;
  tactics: Record<TeamId, TacticalStance>;
  varState: VARState;
  awards: MatchAward[];
  activeCamera: CameraMode;
  isPaused: boolean;
  humanSlot: HumanSlotConfig;
}

export type ComedyEventInput = Omit<ComedyEvent, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
};

export interface GameStoreState extends MatchSnapshot {
  rules: AdminRules;
  events: ComedyEvent[];
  muted: boolean;
  isControlsOpen: boolean;

  setRules: (partial: Partial<AdminRules>) => void;
  applyPreset: (preset: 'chaos' | 'classic') => void;
  setHumanSlot: (partial: Partial<HumanSlotConfig>) => void;
  pushComedyEvent: (event: ComedyEventInput) => void;
  updateMatchSnapshot: (snapshot: Partial<MatchSnapshot>) => void;
  setPhase: (phase: MatchPhase) => void;
  setMuted: (muted: boolean) => void;
  setControlsOpen: (open: boolean) => void;
  resetMatchStats: () => void;
  dispatchCommand: (cmd: GameCommand) => void;
}

let eventCounter = 0;

export const useGameStore = create<GameStoreState>((set, get) => ({
  phase: 'menu',
  rules: { ...DEFAULT_CHAOS_RULES },
  humanSlot: { ...DEFAULT_HUMAN_SLOT },
  score: { red: 0, blue: 0 },
  clockSec: DEFAULT_CHAOS_RULES.matchDurationSec,
  players: [],
  controlledPlayerId: null,
  nearestRefTargetId: null,
  shotCharge: 0,
  aimPrecisionZone: 'none',
  aimCurl: 0,
  pointerLocked: false,
  physicsBackend: 'fallback',
  stamina: 100,
  skillCooldown: 0,
  diveCooldown: 0,
  gkDiveCooldown: 0,
  tactics: { red: 'balanced', blue: 'balanced' },
  varState: { ...INITIAL_VAR_STATE },
  events: [],
  awards: [],
  muted: false,
  activeCamera: DEFAULT_HUMAN_SLOT.cameraMode,
  isPaused: false,
  isControlsOpen: false,

  setRules: (partial) =>
    set((state) => {
      const nextRules: AdminRules = {
        ...state.rules,
        ...partial,
        preset: partial.preset ?? 'custom',
      };
      const shouldSyncClock =
        partial.matchDurationSec !== undefined &&
        (state.phase === 'menu' || state.phase === 'lobby');
      return {
        rules: nextRules,
        clockSec: shouldSyncClock ? nextRules.matchDurationSec : state.clockSec,
      };
    }),

  applyPreset: (preset) =>
    set((state) => {
      const nextRules =
        preset === 'chaos'
          ? { ...DEFAULT_CHAOS_RULES }
          : { ...DEFAULT_CLASSIC_RULES };
      const shouldSyncClock = state.phase === 'menu' || state.phase === 'lobby';
      return {
        rules: nextRules,
        clockSec: shouldSyncClock ? nextRules.matchDurationSec : state.clockSec,
      };
    }),

  setHumanSlot: (partial) =>
    set((state) => {
      const nextSlot: HumanSlotConfig = {
        ...state.humanSlot,
        ...partial,
      };
      return {
        humanSlot: nextSlot,
        activeCamera: partial.cameraMode ?? state.activeCamera,
      };
    }),

  pushComedyEvent: (input) =>
    set((state) => {
      eventCounter += 1;
      const nextEvent: ComedyEvent = {
        id: input.id ?? `evt-${Date.now()}-${eventCounter}`,
        timestamp: input.timestamp ?? Date.now(),
        text: input.text,
        icon: input.icon,
        tone: input.tone,
      };
      const nextEvents = [nextEvent, ...state.events].slice(0, MAX_COMEDY_EVENTS);
      return { events: nextEvents };
    }),

  updateMatchSnapshot: (snapshot) => set((state) => ({ ...state, ...snapshot })),

  setPhase: (phase) => set({ phase }),

  setMuted: (muted) => set({ muted }),

  setControlsOpen: (isControlsOpen) => set({ isControlsOpen }),

  resetMatchStats: () => {
    const { rules, humanSlot } = get();
    set({
      score: { red: 0, blue: 0 },
      clockSec: rules.matchDurationSec,
      players: [],
      controlledPlayerId: null,
      nearestRefTargetId: null,
      shotCharge: 0,
      aimPrecisionZone: 'none',
      aimCurl: 0,
      stamina: 100,
      skillCooldown: 0,
      diveCooldown: 0,
      gkDiveCooldown: 0,
      tactics: { red: 'balanced', blue: 'balanced' },
      varState: { ...INITIAL_VAR_STATE },
      events: [],
      awards: [],
      activeCamera: humanSlot.cameraMode,
      isPaused: false,
    });
  },

  dispatchCommand: (cmd) => {
    commandBus.emit(cmd);
  },
}));
