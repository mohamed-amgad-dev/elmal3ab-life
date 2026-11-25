import { create } from 'zustand';
import { commandBus } from '../engine/CommandBus';
import {
  DEFAULT_CHAOS_RULES,
  DEFAULT_CLASSIC_RULES,
  DEFAULT_HUMAN_SLOT,
  DEFAULT_MOUSE_SENSITIVITY,
  DEFAULT_NETWORK_STATE,
  INITIAL_GOAL_REPLAY_STATE,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  resolveDualHumanSlotConflict,
  type AdminRules,
  type CameraMode,
  type ComedyEvent,
  type GameCommand,
  type GoalReplayState,
  type GraphicsQuality,
  type HumanSlotConfig,
  type MatchAward,
  type MatchPhase,
  type NetworkState,
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

export function clampMouseSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MOUSE_SENSITIVITY;
  return Math.min(MAX_MOUSE_SENSITIVITY, Math.max(MIN_MOUSE_SENSITIVITY, value));
}

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
  goalReplayState: GoalReplayState;
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
  isQuickChatOpen: boolean;
  mouseSensitivity: number;
  graphicsQuality: GraphicsQuality;
  hostSlot: HumanSlotConfig;
  network: NetworkState;

  setRules: (partial: Partial<AdminRules>) => void;
  applyPreset: (preset: 'chaos' | 'classic') => void;
  setHumanSlot: (partial: Partial<HumanSlotConfig>) => void;
  setHostSlot: (partial: Partial<HumanSlotConfig>) => void;
  setGuestSlot: (partial: Partial<HumanSlotConfig>) => void;
  setNetworkState: (partial: Partial<NetworkState>) => void;
  setMouseSensitivity: (value: number) => void;
  setGraphicsQuality: (quality: GraphicsQuality) => void;
  setQuickChatOpen: (open: boolean) => void;
  setGoalReplayState: (partial: Partial<GoalReplayState>) => void;
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
  hostSlot: { ...DEFAULT_HUMAN_SLOT },
  network: {
    ...DEFAULT_NETWORK_STATE,
    guestSlot: { ...DEFAULT_NETWORK_STATE.guestSlot },
  },
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
  goalReplayState: { ...INITIAL_GOAL_REPLAY_STATE },
  events: [],
  awards: [],
  muted: false,
  activeCamera: DEFAULT_HUMAN_SLOT.cameraMode,
  isPaused: false,
  isControlsOpen: false,
  isQuickChatOpen: false,
  mouseSensitivity: DEFAULT_MOUSE_SENSITIVITY,
  graphicsQuality: 'high',

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
      const nextGuestSlot =
        state.network.mode !== 'offline'
          ? resolveDualHumanSlotConflict(state.hostSlot, state.network.guestSlot, nextRules)
          : state.network.guestSlot;
      return {
        rules: nextRules,
        clockSec: shouldSyncClock ? nextRules.matchDurationSec : state.clockSec,
        network:
          nextGuestSlot !== state.network.guestSlot
            ? { ...state.network, guestSlot: nextGuestSlot }
            : state.network,
      };
    }),

  applyPreset: (preset) =>
    set((state) => {
      const nextRules =
        preset === 'chaos'
          ? { ...DEFAULT_CHAOS_RULES }
          : { ...DEFAULT_CLASSIC_RULES };
      const shouldSyncClock = state.phase === 'menu' || state.phase === 'lobby';
      const nextGuestSlot =
        state.network.mode !== 'offline'
          ? resolveDualHumanSlotConflict(state.hostSlot, state.network.guestSlot, nextRules)
          : state.network.guestSlot;
      return {
        rules: nextRules,
        clockSec: shouldSyncClock ? nextRules.matchDurationSec : state.clockSec,
        network:
          nextGuestSlot !== state.network.guestSlot
            ? { ...state.network, guestSlot: nextGuestSlot }
            : state.network,
      };
    }),

  setHumanSlot: (partial) =>
    set((state) => {
      if (state.network.mode === 'guest') {
        const rawGuest: HumanSlotConfig = {
          ...state.humanSlot,
          ...partial,
        };
        const resolvedGuest = resolveDualHumanSlotConflict(
          state.hostSlot,
          rawGuest,
          state.rules,
        );
        return {
          humanSlot: resolvedGuest,
          activeCamera:
            partial.cameraMode !== undefined
              ? resolvedGuest.cameraMode
              : state.activeCamera,
          network: {
            ...state.network,
            guestSlot: resolvedGuest,
          },
        };
      }

      const nextHostSlot: HumanSlotConfig = {
        ...state.humanSlot,
        ...partial,
      };
      const nextGuestSlot =
        state.network.mode === 'host'
          ? resolveDualHumanSlotConflict(nextHostSlot, state.network.guestSlot, state.rules)
          : state.network.guestSlot;

      return {
        humanSlot: nextHostSlot,
        hostSlot: nextHostSlot,
        activeCamera: partial.cameraMode ?? state.activeCamera,
        network:
          nextGuestSlot !== state.network.guestSlot
            ? { ...state.network, guestSlot: nextGuestSlot }
            : state.network,
      };
    }),

  setHostSlot: (partial) =>
    set((state) => {
      const nextHostSlot: HumanSlotConfig = {
        ...state.hostSlot,
        ...partial,
      };
      if (state.network.mode === 'guest') {
        const resolvedGuest = resolveDualHumanSlotConflict(
          nextHostSlot,
          state.network.guestSlot,
          state.rules,
        );
        return {
          hostSlot: nextHostSlot,
          humanSlot: resolvedGuest,
          network: {
            ...state.network,
            guestSlot: resolvedGuest,
          },
        };
      }

      const nextGuestSlot =
        state.network.mode === 'host'
          ? resolveDualHumanSlotConflict(nextHostSlot, state.network.guestSlot, state.rules)
          : state.network.guestSlot;

      return {
        hostSlot: nextHostSlot,
        humanSlot: nextHostSlot,
        activeCamera: partial.cameraMode ?? state.activeCamera,
        network:
          nextGuestSlot !== state.network.guestSlot
            ? { ...state.network, guestSlot: nextGuestSlot }
            : state.network,
      };
    }),

  setGuestSlot: (partial) =>
    set((state) => {
      const rawGuest: HumanSlotConfig = {
        ...state.network.guestSlot,
        ...partial,
      };
      const resolvedGuest =
        state.network.mode !== 'offline'
          ? resolveDualHumanSlotConflict(state.hostSlot, rawGuest, state.rules)
          : rawGuest;

      if (state.network.mode === 'guest') {
        return {
          humanSlot: resolvedGuest,
          activeCamera:
            partial.cameraMode !== undefined
              ? resolvedGuest.cameraMode
              : state.activeCamera,
          network: {
            ...state.network,
            guestSlot: resolvedGuest,
          },
        };
      }

      return {
        network: {
          ...state.network,
          guestSlot: resolvedGuest,
        },
      };
    }),

  setNetworkState: (partial) =>
    set((state) => {
      const prevMode = state.network.mode;
      const nextMode = partial.mode ?? prevMode;
      const nextGuestSlot = partial.guestSlot
        ? { ...state.network.guestSlot, ...partial.guestSlot }
        : state.network.guestSlot;
      const nextNetwork: NetworkState = {
        ...state.network,
        ...partial,
        guestSlot: nextGuestSlot,
      };

      if (prevMode !== 'guest' && nextMode === 'guest') {
        const resolvedGuest = resolveDualHumanSlotConflict(
          state.hostSlot,
          nextGuestSlot,
          state.rules,
        );
        nextNetwork.guestSlot = resolvedGuest;
        return {
          network: nextNetwork,
          humanSlot: resolvedGuest,
          activeCamera: resolvedGuest.cameraMode,
        };
      }

      if (prevMode === 'guest' && nextMode !== 'guest') {
        return {
          network: nextNetwork,
          humanSlot: { ...state.hostSlot },
          activeCamera: state.hostSlot.cameraMode,
        };
      }

      return { network: nextNetwork };
    }),

  setMouseSensitivity: (value) =>
    set({ mouseSensitivity: clampMouseSensitivity(value) }),

  setGraphicsQuality: (graphicsQuality) => set({ graphicsQuality }),

  setQuickChatOpen: (isQuickChatOpen) => set({ isQuickChatOpen }),

  setGoalReplayState: (partial) =>
    set((state) => ({
      goalReplayState: { ...state.goalReplayState, ...partial },
    })),

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

  updateMatchSnapshot: (snapshot) =>
    set((state) => {
      const nextHostSlot =
        snapshot.humanSlot && state.network.mode !== 'guest'
          ? snapshot.humanSlot
          : state.hostSlot;
      const nextGuestSlot =
        snapshot.humanSlot && state.network.mode === 'guest'
          ? snapshot.humanSlot
          : state.network.guestSlot;
      return {
        ...state,
        ...snapshot,
        hostSlot: nextHostSlot,
        network:
          nextGuestSlot !== state.network.guestSlot
            ? { ...state.network, guestSlot: nextGuestSlot }
            : state.network,
      };
    }),

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
      goalReplayState: { ...INITIAL_GOAL_REPLAY_STATE },
      events: [],
      awards: [],
      activeCamera: humanSlot.cameraMode,
      isPaused: false,
      isQuickChatOpen: false,
    });
  },

  dispatchCommand: (cmd) => {
    commandBus.emit(cmd);
  },
}));
