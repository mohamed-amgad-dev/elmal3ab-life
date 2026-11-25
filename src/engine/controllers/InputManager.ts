import { commandBus } from '../CommandBus';
import { useGameStore } from '../../store/useGameStore';
import {
  DEFAULT_MOUSE_SENSITIVITY,
  LOB_HOLD_THRESHOLD_MS,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  QUICK_CHAT_PHRASES,
} from '../../types/game';

export interface InputManagerOptions {
  domElement?: HTMLElement | null;
  onUserGesture?: () => void;
}

const LOB_AUTO_RELEASE_MS = 500;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

function isInteractiveUIElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));
}

function getQuickChatDigitIndex(code: string): number {
  if (code.startsWith('Digit')) {
    const n = Number(code.slice(5));
    if (n >= 1 && n <= 8) return n - 1;
  }
  if (code.startsWith('Numpad')) {
    const n = Number(code.slice(6));
    if (n >= 1 && n <= 8) return n - 1;
  }
  return -1;
}

/**
 * Keyboard + mouse controller emitting typed GameCommands via `commandBus`
 * with Rematch-style Pointer Lock 360° camera look (scaled by mouseSensitivity),
 * LMB Shoot / RMB Pass, Space tap-pass vs hold-lobPass, Shift knock-on burst,
 * KeyB Quick-Chat wheel, goal-replay skip, and seamless unlocked mouse fallback.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly onUserGesture?: () => void;
  private readonly domElement: HTMLElement | null;

  private sprintActive = false;
  private isChargingShot = false;

  // Space hold tracking for outfield Rematch tap-pass (<180ms) vs curved lobPass (>=180ms..500ms)
  private spaceHoldStartMs: number | null = null;
  private spaceHoldAutoTimer: ReturnType<typeof setTimeout> | null = null;

  // Unbounded free-mouse 360 yaw & clamped pitch for player_third & referee_cam
  private freeYaw = 0;
  private freePitch = 0.12;

  // Goalkeeper FP look offsets
  private mouseYaw = 0;
  private mousePitch = 0;
  private mouseNormX = 0;

  // Normalized Device Coordinates for Three.js Raycaster (-1..+1, +Y up)
  private mouseNDC = { x: 0, y: 0 };

  // Live horizontal mouse curl steering bias while charging shot
  private curlDeltaAccum = 0;

  // Pointer Lock tracking + Escape debounce
  private pointerLocked = false;
  private lastPointerUnlockMs = -1000;
  private hasLastClient = false;
  private lastClientX = 0;
  private lastClientY = 0;

  private disposed = false;

  constructor(options: InputManagerOptions = {}) {
    this.domElement = options.domElement ?? null;
    this.onUserGesture = options.onUserGesture;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  getMoveVector(): { dx: number; dz: number } {
    let dx = 0;
    let dz = 0;

    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) dx -= 1;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) dx += 1;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) dz += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) dz -= 1;

    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    return { dx, dz };
  }

  isSprinting(): boolean {
    return this.sprintActive;
  }

  getFreeLook(): { yaw: number; pitch: number } {
    return { yaw: this.freeYaw, pitch: this.freePitch };
  }

  setFreeYaw(yaw: number, pitch = 0.12): void {
    this.freeYaw = yaw;
    this.freePitch = clamp(pitch, -0.22, 0.52);
  }

  getMouseLook(): { yaw: number; pitch: number } {
    return { yaw: this.mouseYaw, pitch: this.mousePitch };
  }

  getMouseNormX(): number {
    return this.mouseNormX;
  }

  getMouseNDC(): { x: number; y: number } {
    return this.mouseNDC;
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  consumeCurlDelta(): number {
    const val = this.curlDeltaAccum;
    this.curlDeltaAccum = 0;
    return val;
  }

  resetMouseLook(): void {
    this.mouseYaw = 0;
    this.mousePitch = 0;
    this.mouseNormX = 0;
    this.curlDeltaAccum = 0;
  }

  exitPointerLock(): void {
    try {
      if (document.pointerLockElement) {
        document.exitPointerLock?.();
      }
    } catch {
      // Ignore environments without pointer lock support
    }
  }

  private cancelSpaceHold(): void {
    this.spaceHoldStartMs = null;
    if (this.spaceHoldAutoTimer !== null) {
      clearTimeout(this.spaceHoldAutoTimer);
      this.spaceHoldAutoTimer = null;
    }
  }

  private finishSpaceHold(autoReleased: boolean): void {
    if (this.spaceHoldStartMs === null) return;
    const heldMs = autoReleased
      ? LOB_AUTO_RELEASE_MS
      : Math.max(0, performance.now() - this.spaceHoldStartMs);
    this.cancelSpaceHold();

    if (this.disposed) return;
    const store = useGameStore.getState();
    if (store.isPaused || !this.isGameplayPhase() || store.phase === 'goal_replay') {
      return;
    }

    const { humanSlot } = store;
    if (humanSlot.isBenched || humanSlot.role !== 'outfield') {
      return;
    }

    if (heldMs < LOB_HOLD_THRESHOLD_MS) {
      commandBus.emit({ type: 'pass' });
    } else {
      const denom = Math.max(1, LOB_AUTO_RELEASE_MS - LOB_HOLD_THRESHOLD_MS);
      const holdRatio = clamp((heldMs - LOB_HOLD_THRESHOLD_MS) / denom, 0, 1);
      commandBus.emit({ type: 'lobPass', holdRatio });
    }
  }

  private tryRequestPointerLock(target: EventTarget | null): void {
    const store = useGameStore.getState();
    const cam = store.activeCamera;
    const lockEligible =
      cam === 'player_third' || cam === 'gk_first_person' || cam === 'referee_cam';
    if (!lockEligible || store.isPaused || store.isControlsOpen || store.isQuickChatOpen) {
      return;
    }
    if (store.phase !== 'playing' && store.phase !== 'kickoff' && store.phase !== 'penalty_setup') {
      return;
    }
    if (this.pointerLocked) return;

    const el =
      this.domElement ??
      (target instanceof HTMLCanvasElement ? target : null);
    if (!el || typeof el.requestPointerLock !== 'function') return;

    try {
      const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === 'function') {
        res.catch(() => {
          // Silently ignore browser pointer-lock rejections
        });
      }
    } catch {
      // Ignore environments blocking pointer lock
    }
  }

  private isGameplayPhase(): boolean {
    const { phase } = useGameStore.getState();
    return phase !== 'menu' && phase !== 'lobby' && phase !== 'full_time';
  }

  private computeGKDiveDir(): 'left' | 'right' | 'center' {
    const leftHeld = this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft');
    const rightHeld = this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight');
    if (leftHeld && !rightHeld) return 'left';
    if (rightHeld && !leftHeld) return 'right';
    const look = this.pointerLocked ? -this.mouseYaw : this.mouseNormX;
    if (look < -0.18) return 'left';
    if (look > 0.18) return 'right';
    return 'center';
  }

  /**
   * Primary action (Right Click / instant non-outfield Space):
   * - Outfield: Crisp instant Pass / Tackle (RMB)
   * - Goalkeeper: Space = Directional Dive Save (zero delay), RMB = Throw / Punt
   * - Referee: Whistle
   * - Spectator: Space = Cheer, RMB = Fireworks
   * - Bench: Rage emote
   */
  private triggerPassOrPrimary(fromRightMouse = false): void {
    const { humanSlot } = useGameStore.getState();

    if (humanSlot.isBenched) {
      commandBus.emit({ type: 'benchEmote', kind: 'rage' });
      return;
    }

    switch (humanSlot.role) {
      case 'outfield':
        commandBus.emit({ type: 'pass' });
        break;
      case 'goalkeeper':
        if (fromRightMouse) {
          commandBus.emit({ type: 'gkThrow' });
        } else {
          commandBus.emit({ type: 'gkDive', dir: this.computeGKDiveDir() });
        }
        break;
      case 'referee':
        commandBus.emit({ type: 'refWhistle' });
        break;
      case 'spectator':
        commandBus.emit({
          type: fromRightMouse ? 'spectatorFireworks' : 'spectatorCheer',
        });
        break;
      case 'coach':
        break;
    }
  }

  /**
   * Shoot / Secondary start (Left Click / E):
   * - Outfield: Start charging precision shot
   * - Goalkeeper (E): Throw / Punt
   * - Goalkeeper (LMB): Dive save
   * - Spectator: Cheer / Fireworks
   */
  private triggerShootStart(fromLeftMouse: boolean): void {
    const { humanSlot } = useGameStore.getState();
    if (humanSlot.isBenched) return;

    if (humanSlot.role === 'outfield') {
      if (!this.isChargingShot) {
        this.isChargingShot = true;
        this.curlDeltaAccum = 0;
        commandBus.emit({ type: 'shootStart' });
      }
    } else if (humanSlot.role === 'goalkeeper') {
      if (fromLeftMouse) {
        commandBus.emit({ type: 'gkDive', dir: this.computeGKDiveDir() });
      } else {
        commandBus.emit({ type: 'gkThrow' });
      }
    } else if (humanSlot.role === 'referee' && fromLeftMouse) {
      commandBus.emit({ type: 'refWhistle' });
    } else if (humanSlot.role === 'spectator') {
      commandBus.emit({
        type: fromLeftMouse ? 'spectatorCheer' : 'spectatorFireworks',
      });
    }
  }

  private triggerShootEnd(): void {
    if (this.isChargingShot) {
      this.isChargingShot = false;
      commandBus.emit({ type: 'shootRelease' });
    }
  }

  private readonly handlePointerLockChange = (): void => {
    const wasLocked = this.pointerLocked;
    this.pointerLocked = Boolean(document.pointerLockElement);
    if (wasLocked && !this.pointerLocked) {
      this.lastPointerUnlockMs = performance.now();
    }
    useGameStore.getState().updateMatchSnapshot({
      pointerLocked: this.pointerLocked,
    });
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    this.onUserGesture?.();

    if (isEditableElement(e.target)) return;

    const store = useGameStore.getState();

    // Escape closes Quick-Chat first, then Controls modal, or toggles Pause during a match.
    // Guard against double-triggering Pause on the same Escape press that exited Pointer Lock.
    if (e.code === 'Escape' || (e.code === 'KeyP' && !e.repeat)) {
      if (e.code === 'Escape' && store.isQuickChatOpen) {
        store.setQuickChatOpen(false);
        return;
      }
      if (e.code === 'Escape' && performance.now() - this.lastPointerUnlockMs < 260) {
        return;
      }
      if (store.isControlsOpen) {
        store.setControlsOpen(false);
        return;
      }
      if (this.isGameplayPhase()) {
        this.cancelSpaceHold();
        this.exitPointerLock();
        commandBus.emit({ type: 'togglePause' });
      }
      return;
    }

    if (!this.isGameplayPhase()) return;

    if (
      e.code === 'Space' ||
      e.code === 'Tab' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    const isRepeat = this.keysDown.has(e.code) || e.repeat;
    this.keysDown.add(e.code);

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (!this.sprintActive) {
        this.sprintActive = true;
        commandBus.emit({ type: 'sprint', active: true });
      }
      if (!isRepeat && !store.isPaused) {
        const { humanSlot } = store;
        const move = this.getMoveVector();
        if (
          !humanSlot.isBenched &&
          humanSlot.role === 'outfield' &&
          Math.hypot(move.dx, move.dz) > 0.05
        ) {
          commandBus.emit({ type: 'knockOn' });
        }
      }
      return;
    }

    if (isRepeat || store.isPaused) return;

    // Quick-Chat wheel toggle (`KeyB`)
    if (e.code === 'KeyB') {
      store.setQuickChatOpen(!store.isQuickChatOpen);
      return;
    }

    // When Quick-Chat wheel is open, Digit1..Digit8 emit the selected phrase and close the wheel
    if (store.isQuickChatOpen) {
      const phraseIdx = getQuickChatDigitIndex(e.code);
      if (phraseIdx >= 0 && phraseIdx < QUICK_CHAT_PHRASES.length) {
        store.setQuickChatOpen(false);
        commandBus.emit({
          type: 'quickChat',
          phraseId: QUICK_CHAT_PHRASES[phraseIdx].id,
        });
        return;
      }
    }

    const { humanSlot } = store;

    switch (e.code) {
      case 'Space':
        if (store.phase === 'goal_replay') {
          this.cancelSpaceHold();
          commandBus.emit({ type: 'skipGoalReplay' });
          break;
        }
        if (!humanSlot.isBenched && humanSlot.role === 'outfield') {
          this.cancelSpaceHold();
          this.spaceHoldStartMs = performance.now();
          this.spaceHoldAutoTimer = setTimeout(() => {
            this.finishSpaceHold(true);
          }, LOB_AUTO_RELEASE_MS);
        } else {
          // Instant zero-delay reflex trigger for GK dive, Referee whistle, Spectator cheer, Bench emote
          this.triggerPassOrPrimary(false);
        }
        break;

      case 'KeyE':
        this.triggerShootStart(false);
        break;

      case 'KeyC':
        if (!humanSlot.isBenched && humanSlot.role === 'outfield') {
          commandBus.emit({ type: 'skillMove' });
        }
        break;

      case 'KeyF':
        if (!humanSlot.isBenched && humanSlot.role === 'outfield') {
          commandBus.emit({ type: 'slideTackle' });
        }
        break;

      case 'KeyV':
        if (!humanSlot.isBenched && humanSlot.role === 'outfield') {
          commandBus.emit({ type: 'dive' });
        }
        break;

      case 'KeyR':
        if (humanSlot.isBenched) {
          commandBus.emit({ type: 'benchRequestReturn' });
        } else if (humanSlot.role === 'outfield') {
          commandBus.emit({ type: 'protest' });
        }
        break;

      case 'KeyQ':
      case 'Tab':
        if (!humanSlot.isBenched && humanSlot.role === 'outfield') {
          commandBus.emit({ type: 'switchPlayer' });
        }
        break;

      case 'KeyT':
        commandBus.emit({ type: 'switchCamera' });
        break;

      case 'KeyM':
        // Handled by QuickRoleSwitcher UI panel
        break;

      case 'Digit1':
        if (humanSlot.isBenched) {
          commandBus.emit({ type: 'benchEmote', kind: 'rage' });
        } else if (humanSlot.role === 'referee') {
          commandBus.emit({ type: 'refYellowCard' });
        } else if (humanSlot.role === 'spectator') {
          commandBus.emit({ type: 'spectatorCheer' });
        }
        break;

      case 'Digit2':
        if (humanSlot.isBenched) {
          commandBus.emit({ type: 'benchEmote', kind: 'water' });
        } else if (humanSlot.role === 'referee') {
          commandBus.emit({ type: 'refRedCard' });
        } else if (humanSlot.role === 'spectator') {
          commandBus.emit({ type: 'spectatorBoo' });
        }
        break;

      case 'Digit3':
        if (humanSlot.isBenched) {
          commandBus.emit({ type: 'benchEmote', kind: 'shout' });
        } else if (humanSlot.role === 'referee') {
          commandBus.emit({ type: 'refPenalty' });
        } else if (humanSlot.role === 'spectator') {
          commandBus.emit({ type: 'spectatorFireworks' });
        }
        break;

      case 'Digit4':
        if (humanSlot.role === 'referee') {
          commandBus.emit({ type: 'refStartVAR' });
        }
        break;

      default:
        break;
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    this.keysDown.delete(e.code);

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      const stillShift =
        this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
      if (!stillShift && this.sprintActive) {
        this.sprintActive = false;
        commandBus.emit({ type: 'sprint', active: false });
      }
    }

    if (e.code === 'Space') {
      this.finishSpaceHold(false);
    }

    if (e.code === 'KeyE') {
      this.triggerShootEnd();
    }
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    if (this.disposed) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);

    const nx = (e.clientX / width) * 2 - 1;
    const nyScreen = (e.clientY / height) * 2 - 1;
    this.mouseNormX = nx;
    this.mouseNDC = { x: nx, y: -nyScreen };

    let dxMove = e.movementX || 0;
    let dyMove = e.movementY || 0;
    if (!this.pointerLocked && dxMove === 0 && dyMove === 0 && this.hasLastClient) {
      dxMove = e.clientX - this.lastClientX;
      dyMove = e.clientY - this.lastClientY;
    }
    this.hasLastClient = true;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const store = useGameStore.getState();
    const cam = store.activeCamera;
    const sens = clamp(
      store.mouseSensitivity ?? DEFAULT_MOUSE_SENSITIVITY,
      MIN_MOUSE_SENSITIVITY,
      MAX_MOUSE_SENSITIVITY,
    );

    if (this.pointerLocked) {
      const yawSens = 0.0036 * sens;
      const pitchSens = 0.0026 * sens;
      this.freeYaw -= dxMove * yawSens;
      this.freePitch = clamp(this.freePitch - dyMove * pitchSens, -0.22, 0.52);

      this.mouseYaw = clamp(this.mouseYaw - dxMove * yawSens, -0.95, 0.95);
      this.mousePitch = clamp(this.mousePitch - dyMove * pitchSens, -0.45, 0.45);

      if (this.isChargingShot) {
        this.curlDeltaAccum = clamp(this.curlDeltaAccum + dxMove * 0.012 * sens, -1, 1);
      }
    } else {
      // Unlocked fallback:
      // - GK FP maps cursor position naturally
      this.mouseYaw = -nx * 0.85;
      this.mousePitch = -nyScreen * 0.45;

      // - Free-look cameras respond smoothly when moving mouse directly over the canvas
      if (
        (cam === 'player_third' || cam === 'referee_cam') &&
        this.isGameplayPhase() &&
        !store.isPaused &&
        !isInteractiveUIElement(e.target) &&
        Math.abs(dxMove) < 120 &&
        Math.abs(dyMove) < 120
      ) {
        this.freeYaw -= dxMove * 0.0028 * sens;
        this.freePitch = clamp(this.freePitch - dyMove * 0.0020 * sens, -0.22, 0.52);
        if (this.isChargingShot) {
          this.curlDeltaAccum = clamp(this.curlDeltaAccum + dxMove * 0.012 * sens, -1, 1);
        }
      }
    }
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    if (this.disposed) return;
    this.onUserGesture?.();

    if (!this.isGameplayPhase()) return;
    const store = useGameStore.getState();
    if (store.isPaused) return;
    if (isInteractiveUIElement(e.target)) return;
    if (this.domElement && e.target instanceof Node && !this.domElement.contains(e.target)) {
      if (!(e.target instanceof HTMLCanvasElement)) return;
    }

    if (store.phase === 'goal_replay') {
      if (e.button === 0 || e.button === 2) {
        commandBus.emit({ type: 'skipGoalReplay' });
      }
      return;
    }

    // Engage Rematch-style fast Pointer Lock on canvas click
    this.tryRequestPointerLock(e.target);

    if (e.button === 0) {
      // Left Click = Shoot (start charge & release on mouseup)
      this.triggerShootStart(true);
    } else if (e.button === 2) {
      // Right Click = crisp instant Pass / Tackle (or GK throw)
      this.triggerPassOrPrimary(true);
    }
  };

  private readonly handleMouseUp = (e: MouseEvent): void => {
    if (this.disposed) return;
    if (e.button === 0) {
      this.triggerShootEnd();
    }
  };

  private readonly handleContextMenu = (e: MouseEvent): void => {
    if (this.disposed) return;
    if (this.isGameplayPhase() && !isInteractiveUIElement(e.target)) {
      e.preventDefault();
    }
  };

  private readonly handleBlur = (): void => {
    this.keysDown.clear();
    this.cancelSpaceHold();
    if (this.sprintActive) {
      this.sprintActive = false;
      commandBus.emit({ type: 'sprint', active: false });
    }
    this.triggerShootEnd();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSpaceHold();
    this.exitPointerLock();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.keysDown.clear();
  }
}
