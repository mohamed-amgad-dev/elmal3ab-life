import { commandBus } from '../CommandBus';
import { useGameStore } from '../../store/useGameStore';

export interface InputManagerOptions {
  domElement?: HTMLElement | null;
  onUserGesture?: () => void;
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

/**
 * Keyboard + mouse controller emitting typed GameCommands via `commandBus`
 * while providing smooth 60fps continuous movement and mouse-look state.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly onUserGesture?: () => void;
  private readonly domElement: HTMLElement | null;

  private sprintActive = false;
  private isChargingShot = false;
  private mouseYaw = 0;
  private mousePitch = 0;
  private mouseNormX = 0;
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

  getMouseLook(): { yaw: number; pitch: number } {
    return { yaw: this.mouseYaw, pitch: this.mousePitch };
  }

  getMouseNormX(): number {
    return this.mouseNormX;
  }

  resetMouseLook(): void {
    this.mouseYaw = 0;
    this.mousePitch = 0;
    this.mouseNormX = 0;
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
    if (this.mouseNormX < -0.18) return 'left';
    if (this.mouseNormX > 0.18) return 'right';
    return 'center';
  }

  private triggerPrimaryAction(): void {
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
        commandBus.emit({ type: 'gkDive', dir: this.computeGKDiveDir() });
        break;
      case 'referee':
        commandBus.emit({ type: 'refWhistle' });
        break;
      case 'spectator':
        commandBus.emit({ type: 'spectatorCheer' });
        break;
      case 'coach':
        break;
    }
  }

  private triggerSecondaryStart(): void {
    const { humanSlot } = useGameStore.getState();
    if (humanSlot.isBenched) return;

    if (humanSlot.role === 'outfield') {
      if (!this.isChargingShot) {
        this.isChargingShot = true;
        commandBus.emit({ type: 'shootStart' });
      }
    } else if (humanSlot.role === 'goalkeeper') {
      commandBus.emit({ type: 'gkThrow' });
    } else if (humanSlot.role === 'spectator') {
      commandBus.emit({ type: 'spectatorFireworks' });
    }
  }

  private triggerSecondaryEnd(): void {
    if (this.isChargingShot) {
      this.isChargingShot = false;
      commandBus.emit({ type: 'shootRelease' });
    }
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    this.onUserGesture?.();

    if (isEditableElement(e.target)) return;

    const store = useGameStore.getState();

    // Escape / P closes Controls modal or toggles Pause during a match
    if (e.code === 'Escape' || (e.code === 'KeyP' && !e.repeat)) {
      if (store.isControlsOpen) {
        store.setControlsOpen(false);
        return;
      }
      if (this.isGameplayPhase()) {
        commandBus.emit({ type: 'togglePause' });
      }
      return;
    }

    if (!this.isGameplayPhase()) return;

    // Prevent browser scroll/focus steal on gameplay keys
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

    const isRepeat = this.keysDown.has(e.code);
    this.keysDown.add(e.code);

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (!this.sprintActive) {
        this.sprintActive = true;
        commandBus.emit({ type: 'sprint', active: true });
      }
      return;
    }

    if (isRepeat || store.isPaused) return;

    const { humanSlot } = store;

    switch (e.code) {
      case 'Space':
        this.triggerPrimaryAction();
        break;

      case 'KeyE':
        this.triggerSecondaryStart();
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
        // Handled by QuickRoleSwitcher UI panel toggle so pressing M opens/closes the role drawer cleanly
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

    if (e.code === 'KeyE') {
      this.triggerSecondaryEnd();
    }
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    if (this.disposed) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);

    const nx = (e.clientX / width) * 2 - 1; // -1 left .. +1 right
    const ny = (e.clientY / height) * 2 - 1; // -1 top .. +1 bottom

    this.mouseNormX = nx;
    // Negative yaw looks right in Three.js (+Y up), positive yaw looks left
    this.mouseYaw = -nx * 0.82;
    this.mousePitch = -ny * 0.45;
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    if (this.disposed) return;
    this.onUserGesture?.();

    if (!this.isGameplayPhase()) return;
    if (useGameStore.getState().isPaused) return;
    if (isInteractiveUIElement(e.target)) return;
    if (this.domElement && e.target instanceof Node && !this.domElement.contains(e.target)) {
      // Allow clicking anywhere on the viewport canvas if not hitting an interactive UI button
      if (!(e.target instanceof HTMLCanvasElement)) return;
    }

    if (e.button === 0) {
      this.triggerPrimaryAction();
    } else if (e.button === 2) {
      this.triggerSecondaryStart();
    }
  };

  private readonly handleMouseUp = (e: MouseEvent): void => {
    if (this.disposed) return;
    if (e.button === 2) {
      this.triggerSecondaryEnd();
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
    if (this.sprintActive) {
      this.sprintActive = false;
      commandBus.emit({ type: 'sprint', active: false });
    }
    this.triggerSecondaryEnd();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('blur', this.handleBlur);
    this.keysDown.clear();
  }
}
