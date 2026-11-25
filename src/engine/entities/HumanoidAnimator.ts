import * as THREE from 'three';
import type { CharacterAnimState } from '../../types/game';
import type { ClonedHumanoidInstance } from './HumanoidModelLoader';

export interface HumanoidAnimFrameOutput {
  showYellowCard: boolean;
  showRedCard: boolean;
  showWhistle: boolean;
  airHeight: number;
}

interface ProceduralBoneOverride {
  euler: THREE.Euler;
  weight: number;
  /** If true, rotation is relative to bind-pose `restQuat`; otherwise multiplied onto mixer pose. */
  fromRest: boolean;
}

const CROSSFADE_SEC = 0.16;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Drives a rigged Mixamo humanoid (`player_humanoid.glb`) using `THREE.AnimationMixer`
 * for base locomotion (`idle`, `walk`, `run`, `headShake`, `sad_pose`, `sneak_pose`, `agree`)
 * with smooth `0.16s` crossfades, layered with post-`mixer.update(dt)` procedural bone
 * rotations and body transforms covering all 19 `CharacterAnimState`s.
 */
export class HumanoidAnimator {
  private readonly instance: ClonedHumanoidInstance;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly phaseOffset: number;

  private activeClipKey: string | null = null;
  private secondaryClipKey: string | null = null;
  private currentState: CharacterAnimState = 'idle';
  private stateTime = 0;

  // Smoothed whole-body offsets applied to `instance.root` (allows flips, dives, slides, jumps)
  private bodyPos = new THREE.Vector3();
  private bodyRot = new THREE.Euler(0, 0, 0, 'YXZ');
  private targetBodyPos = new THREE.Vector3();
  private targetBodyRot = new THREE.Euler(0, 0, 0, 'YXZ');

  // Reusable scratch math objects (zero per-frame GC allocations)
  private readonly tempQuat = new THREE.Quaternion();
  private readonly targetQuat = new THREE.Quaternion();
  private readonly smoothedBoneQuats = new Map<string, THREE.Quaternion>();
  private readonly boneOverrides = new Map<string, ProceduralBoneOverride>();

  // Pooled Euler instances per bone to avoid allocating every frame
  private readonly eulerPool = new Map<string, THREE.Euler>();

  constructor(instance: ClonedHumanoidInstance, seed = 0) {
    this.instance = instance;
    this.phaseOffset = (seed % 100) * 0.19;
    this.mixer = new THREE.AnimationMixer(instance.root);

    for (const clip of instance.animations) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(clip.name.toLowerCase(), action);
    }

    // Start immediately in idle clip with staggered phase so teams don't breathe in unison
    const idleAction = this.getAction('idle');
    if (idleAction) {
      idleAction.reset();
      idleAction.time = this.phaseOffset % Math.max(0.5, idleAction.getClip().duration || 1);
      idleAction.setEffectiveWeight(1);
      idleAction.play();
      this.activeClipKey = 'idle';
    }
  }

  private getAction(clipName: string): THREE.AnimationAction | undefined {
    return this.actions.get(clipName.toLowerCase());
  }

  private getOrCreateEuler(boneKey: string): THREE.Euler {
    let e = this.eulerPool.get(boneKey);
    if (!e) {
      e = new THREE.Euler(0, 0, 0, 'XYZ');
      this.eulerPool.set(boneKey, e);
    }
    return e;
  }

  private setBoneOverride(
    boneKey: string,
    x: number,
    y: number,
    z: number,
    weight = 1,
    fromRest = true
  ): void {
    const euler = this.getOrCreateEuler(boneKey);
    euler.set(x, y, z, 'XYZ');
    const existing = this.boneOverrides.get(boneKey);
    if (existing) {
      existing.euler = euler;
      existing.weight = weight;
      existing.fromRest = fromRest;
    } else {
      this.boneOverrides.set(boneKey, { euler, weight, fromRest });
    }
  }

  /**
   * Smoothly crossfades to a primary base clip (with optional blended secondary clip,
   * e.g. `'walk'` + `'run'` blend for athletic `run`).
   */
  private transitionBaseClip(
    primaryName: string,
    timeScale = 1,
    secondaryName?: string,
    secondaryWeight = 0
  ): void {
    const primaryKey = primaryName.toLowerCase();
    const secondaryKey = secondaryName ? secondaryName.toLowerCase() : null;

    const primaryAction = this.actions.get(primaryKey);
    if (!primaryAction) return;

    if (this.activeClipKey !== primaryKey) {
      const prevPrimary = this.activeClipKey ? this.actions.get(this.activeClipKey) : undefined;
      primaryAction.reset();
      primaryAction.enabled = true;
      primaryAction.setEffectiveTimeScale(timeScale);
      primaryAction.setEffectiveWeight(secondaryKey ? 1 - secondaryWeight : 1);
      primaryAction.play();

      if (prevPrimary && prevPrimary !== primaryAction) {
        primaryAction.crossFadeFrom(prevPrimary, CROSSFADE_SEC, true);
      } else {
        primaryAction.fadeIn(CROSSFADE_SEC);
      }
      this.activeClipKey = primaryKey;
    } else {
      primaryAction.setEffectiveTimeScale(timeScale);
      primaryAction.setEffectiveWeight(secondaryKey ? 1 - secondaryWeight : 1);
    }

    // Manage optional secondary blended clip (e.g. walk/run blend)
    if (this.secondaryClipKey && this.secondaryClipKey !== secondaryKey) {
      const prevSecondary = this.actions.get(this.secondaryClipKey);
      if (prevSecondary && this.secondaryClipKey !== this.activeClipKey) {
        prevSecondary.fadeOut(CROSSFADE_SEC);
      }
      this.secondaryClipKey = null;
    }

    if (secondaryKey && secondaryKey !== primaryKey && secondaryWeight > 0.01) {
      const secAction = this.actions.get(secondaryKey);
      if (secAction) {
        if (this.secondaryClipKey !== secondaryKey) {
          secAction.reset();
          secAction.enabled = true;
          secAction.play();
          this.secondaryClipKey = secondaryKey;
        }
        secAction.setEffectiveTimeScale(timeScale);
        secAction.setEffectiveWeight(secondaryWeight);
      }
    }
  }

  public update(
    animState: CharacterAnimState,
    dt: number,
    elapsed: number,
    hasClipboard: boolean
  ): HumanoidAnimFrameOutput {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    if (animState !== this.currentState) {
      this.currentState = animState;
      this.stateTime = 0;
    } else {
      this.stateTime += safeDt;
    }

    const t = this.stateTime;
    const g = elapsed + this.phaseOffset;

    // 1. Select base GLB clip(s) and crossfade smoothly
    switch (animState) {
      case 'idle':
        this.transitionBaseClip('idle', 1.0);
        break;
      case 'run':
        // Smooth athletic run/walk blend distinct from full sprint
        this.transitionBaseClip('run', 1.02, 'walk', 0.32);
        break;
      case 'sprint':
        this.transitionBaseClip('run', 1.42);
        break;
      case 'protest':
        this.transitionBaseClip('headShake', 1.35);
        break;
      case 'dive_flop':
        if (t >= 0.62) {
          this.transitionBaseClip('sad_pose', 1.0);
        } else {
          this.transitionBaseClip('idle', 1.0);
        }
        break;
      case 'gk_catch':
        this.transitionBaseClip('sneak_pose', 1.0);
        break;
      case 'celebrate':
        this.transitionBaseClip(t % 2.0 < 0.72 ? 'idle' : 'run', 1.15);
        break;
      case 'coach_shout':
        this.transitionBaseClip('agree', 1.25);
        break;
      default:
        this.transitionBaseClip('idle', 1.0);
        break;
    }

    // 2. Step the AnimationMixer first
    if (safeDt > 0) {
      this.mixer.update(safeDt);
    }

    // 3. Build post-mixer procedural bone overrides & body offsets for ALL 19 states
    this.boneOverrides.clear();
    this.targetBodyPos.set(0, 0, 0);
    this.targetBodyRot.set(0, 0, 0);

    let blendSpeed = 16;
    let showYellowCard = false;
    let showRedCard = false;
    let showWhistle = false;

    switch (animState) {
      case 'idle': {
        if (hasClipboard) {
          // Coach holds tactical clipboard comfortably in left hand
          this.setBoneOverride('LeftArm', 0.15, -0.58, -0.92, 0.95, true);
          this.setBoneOverride('LeftForeArm', 0, -1.15, 0.25, 0.95, true);
        }
        break;
      }

      case 'run': {
        // Subtle athletic forward lean onto the walk/run mixer blend
        this.setBoneOverride('Spine1', 0.1, 0, 0, 0.7, false);
        if (hasClipboard) {
          this.setBoneOverride('LeftArm', 0.15, -0.62, -0.88, 0.85, true);
          this.setBoneOverride('LeftForeArm', 0, -1.1, 0.2, 0.85, true);
        }
        break;
      }

      case 'sprint': {
        // Aggressive sprint torso lean + head lift so player looks forward
        this.setBoneOverride('Spine', 0.14, 0, 0, 0.85, false);
        this.setBoneOverride('Spine1', 0.14, 0, 0, 0.85, false);
        this.setBoneOverride('Head', -0.22, 0, 0, 0.85, false);
        break;
      }

      case 'kick': {
        blendSpeed = 28;
        const kickPhase = Math.min(t / 0.34, 1);
        const swing =
          kickPhase < 0.28
            ? lerp(0, 0.95, kickPhase / 0.28)
            : lerp(0.95, -1.35, Math.min(1, (kickPhase - 0.28) / 0.42));

        this.targetBodyPos.y = kickPhase > 0.28 && kickPhase < 0.72 ? 0.08 : 0;
        // Torso twists dynamically into the strike
        this.setBoneOverride('Spine', swing < 0 ? -0.14 : 0.12, swing < 0 ? 0.36 : -0.28, 0, 0.92, true);
        this.setBoneOverride('Spine2', 0.06, swing < 0 ? 0.2 : -0.15, 0, 0.85, true);
        // Right kicking leg winds back (+X) then whips forward (-X)
        this.setBoneOverride('RightUpLeg', swing, 0, -0.06, 1.0, true);
        this.setBoneOverride('RightLeg', swing > 0 ? 1.15 : 0.14, 0, 0, 1.0, true);
        // Planted left leg slightly bent for stability
        this.setBoneOverride('LeftUpLeg', -0.18, 0, 0.08, 0.9, true);
        this.setBoneOverride('LeftLeg', 0.32, 0, 0, 0.9, true);
        // Counter-balance arms flung out
        this.setBoneOverride('LeftArm', 0, -0.55, -0.42, 0.92, true);
        this.setBoneOverride('LeftForeArm', 0, -0.5, 0, 0.85, true);
        this.setBoneOverride('RightArm', 0, 0.25, 0.52, 0.92, true);
        this.setBoneOverride('RightForeArm', 0, 0.45, 0, 0.85, true);
        break;
      }

      case 'skill_spin': {
        blendSpeed = 26;
        const spinDur = 0.55;
        const u = Math.min(t / spinDur, 1);
        const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        this.targetBodyRot.y = eased * Math.PI * 2;
        this.targetBodyPos.y = Math.sin(u * Math.PI) * 0.22;

        const step = Math.sin(t * 28);
        this.setBoneOverride('Spine1', 0.16, 0, 0, 0.85, true);
        this.setBoneOverride('LeftUpLeg', step * 0.55 - 0.24, 0, 0.1, 0.92, true);
        this.setBoneOverride('RightUpLeg', -step * 0.55 - 0.24, 0, -0.1, 0.92, true);
        this.setBoneOverride('LeftLeg', 0.58, 0, 0, 0.92, true);
        this.setBoneOverride('RightLeg', 0.58, 0, 0, 0.92, true);
        // Arms wide for dramatic roulette balance
        this.setBoneOverride('LeftArm', 0, -0.18, -0.22, 0.92, true);
        this.setBoneOverride('RightArm', 0, 0.18, 0.22, 0.92, true);
        this.setBoneOverride('LeftForeArm', 0, -0.42, 0, 0.85, true);
        this.setBoneOverride('RightForeArm', 0, 0.42, 0, 0.85, true);
        break;
      }

      case 'slide_tackle': {
        blendSpeed = 24;
        this.targetBodyPos.set(0, 0.26, 0.18);
        this.targetBodyRot.set(-1.26, 0, 0.18);
        // Head looks forward toward the ball
        this.setBoneOverride('Neck', 0.42, 0, 0, 0.95, true);
        this.setBoneOverride('Head', 0.45, 0, 0, 0.95, true);
        // Right leg lunges straight forward (-X), left leg tucks sharply underneath
        this.setBoneOverride('RightUpLeg', -0.28, 0, -0.08, 1.0, true);
        this.setBoneOverride('RightLeg', 0.06, 0, 0, 1.0, true);
        this.setBoneOverride('LeftUpLeg', -0.58, 0, 0.28, 1.0, true);
        this.setBoneOverride('LeftLeg', 1.52, 0, 0, 1.0, true);
        // Left arm braces near turf, right arm lifts for balance
        this.setBoneOverride('LeftArm', 0.2, 0.35, -0.45, 0.95, true);
        this.setBoneOverride('RightArm', 0, 0.55, -0.35, 0.95, true);
        break;
      }

      case 'dive_flop': {
        // 3-phase Egyptian theatrical dive -> turf slam -> sad_pose knee-clutch writhing!
        blendSpeed = 22;
        if (t < 0.34) {
          // Phase 1: Dramatic dolphin leap upward & forward, arms thrown skyward
          const u = t / 0.34;
          this.targetBodyPos.set(0, Math.sin(u * Math.PI * 0.75) * 0.88, u * 0.42);
          this.targetBodyRot.set(lerp(0, 1.38, u), 0, 0);
          this.setBoneOverride('Spine1', -0.32, 0, 0, 0.95, true);
          this.setBoneOverride('Head', -0.52, 0, 0, 0.95, true);
          // Both arms flung dramatically skyward
          this.setBoneOverride('LeftArm', 0, -0.35, 1.15, 1.0, true);
          this.setBoneOverride('RightArm', 0, 0.35, -1.15, 1.0, true);
          this.setBoneOverride('LeftUpLeg', 0.45, 0, 0.08, 0.95, true);
          this.setBoneOverride('RightUpLeg', 0.25, 0, -0.08, 0.95, true);
          this.setBoneOverride('LeftLeg', 0.85, 0, 0, 0.95, true);
          this.setBoneOverride('RightLeg', 0.65, 0, 0, 0.95, true);
        } else if (t < 0.62) {
          // Phase 2: Belly slam & comical turf bounce onto back
          const u = (t - 0.34) / 0.28;
          const bounce = Math.abs(Math.sin(u * Math.PI)) * 0.24 * (1 - u * 0.5);
          this.targetBodyPos.set(0, 0.22 + bounce, 0.44);
          this.targetBodyRot.set(lerp(1.38, -1.5, u), 0, Math.sin(u * Math.PI) * 0.82);
          this.setBoneOverride('LeftArm', 0, -0.75, 0.45, 0.95, true);
          this.setBoneOverride('RightArm', 0, 0.75, -0.45, 0.95, true);
        } else {
          // Phase 3: Soap-opera writhing on back (layered onto `sad_pose` clip), clutching knee!
          const w = t - 0.62;
          const roll = Math.sin(w * 9.5) * 0.45;
          this.targetBodyPos.set(0, 0.22, 0.42);
          this.targetBodyRot.set(-1.5, 0, roll);
          this.setBoneOverride('Head', 0.55 + Math.sin(w * 14) * 0.16, Math.sin(w * 11) * 0.36, 0, 0.92, true);
          // Clutching right knee while left leg kicks dramatically in the air
          this.setBoneOverride('RightUpLeg', -1.45, 0, -0.05, 1.0, true);
          this.setBoneOverride('RightLeg', 1.55, 0, 0, 1.0, true);
          this.setBoneOverride('LeftUpLeg', -0.45 + Math.sin(w * 16) * 0.42, 0, 0.12, 1.0, true);
          this.setBoneOverride('LeftLeg', 0.45 + Math.cos(w * 16) * 0.35, 0, 0, 1.0, true);
          // Both arms reaching toward clutched knee
          this.setBoneOverride('LeftArm', 0.25, -1.15, -0.35, 0.95, true);
          this.setBoneOverride('RightArm', 0.25, 1.15, 0.35, 0.95, true);
          this.setBoneOverride('LeftForeArm', 0, -0.58, 0, 0.95, true);
          this.setBoneOverride('RightForeArm', 0, 0.58, 0, 0.95, true);
        }
        break;
      }

      case 'protest': {
        // Angry hopping + flailing arms layered over GLB `headShake` clip!
        blendSpeed = 24;
        const hop = Math.abs(Math.sin(t * 11));
        const flail = Math.sin(t * 20);
        this.targetBodyPos.y = hop * 0.24;
        this.setBoneOverride('Spine1', 0.14, 0, flail * 0.14, 0.85, false);
        // Arms raised and flailing incredulously at referee
        this.setBoneOverride('LeftArm', 0, -0.75 + flail * 0.3, 0.55 + Math.abs(flail) * 0.35, 0.95, true);
        this.setBoneOverride('RightArm', 0, 0.75 + flail * 0.3, -0.55 - Math.abs(flail) * 0.35, 0.95, true);
        this.setBoneOverride('LeftForeArm', 0, -0.65, 0.35, 0.9, true);
        this.setBoneOverride('RightForeArm', 0, 0.65, -0.35, 0.9, true);
        this.setBoneOverride('LeftLeg', hop * 0.48, 0, 0, 0.7, false);
        this.setBoneOverride('RightLeg', hop * 0.48, 0, 0, 0.7, false);
        break;
      }

      case 'celebrate': {
        // Joyful airborne backflip -> arms-wide airplane banking run!
        blendSpeed = 20;
        const cycle = t % 2.0;
        if (cycle < 0.72) {
          const u = cycle / 0.72;
          const flipAngle = -u * Math.PI * 2;
          // Compensate foot-pivot height while inverted so the backflip rotates around mid-torso above the turf
          const invertLift = (1 - Math.cos(flipAngle)) * 0.55;
          this.targetBodyPos.y = Math.sin(u * Math.PI) * 0.95 + invertLift;
          this.targetBodyRot.x = flipAngle;
          this.setBoneOverride('LeftArm', 0, -0.3, 1.25, 0.98, true);
          this.setBoneOverride('RightArm', 0, 0.3, -1.25, 0.98, true);
          this.setBoneOverride('LeftUpLeg', -0.68, 0, 0.08, 0.95, true);
          this.setBoneOverride('RightUpLeg', -0.68, 0, -0.08, 0.95, true);
          this.setBoneOverride('LeftLeg', 1.25, 0, 0, 0.95, true);
          this.setBoneOverride('RightLeg', 1.25, 0, 0, 0.95, true);
        } else {
          // Airplane arms-wide banking layered over `run` clip!
          const u = cycle - 0.72;
          const bank = Math.sin(u * 8) * 0.28;
          this.targetBodyPos.y = Math.abs(Math.sin(u * 12)) * 0.16;
          this.setBoneOverride('Spine1', 0.2, 0, bank, 0.9, true);
          // Outstretched airplane wings
          this.setBoneOverride('LeftArm', 0, -0.1, 0.08, 0.98, true);
          this.setBoneOverride('RightArm', 0, 0.1, -0.08, 0.98, true);
          this.setBoneOverride('LeftForeArm', 0, -0.06, 0, 0.98, true);
          this.setBoneOverride('RightForeArm', 0, 0.06, 0, 0.98, true);
        }
        break;
      }

      case 'gk_dive_left': {
        // Full horizontal lateral dive to character's LEFT (+X -> negative bodyRotZ)
        blendSpeed = 26;
        const airArc = Math.sin(Math.min(t / 0.65, 1) * Math.PI);
        this.targetBodyPos.set(0.35, 0.44 + airArc * 0.55, 0);
        this.targetBodyRot.set(0, 0, -1.46);
        this.setBoneOverride('Head', 0, 0, 0.45, 0.95, true);
        // Both gloved hands fully extended overhead toward ball
        this.setBoneOverride('LeftArm', 0, -0.18, 1.48, 1.0, true);
        this.setBoneOverride('RightArm', 0, 0.18, -1.42, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -0.08, 0, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.08, 0, 1.0, true);
        this.setBoneOverride('LeftUpLeg', 0.14, 0, 0.12, 0.95, true);
        this.setBoneOverride('RightUpLeg', -0.18, 0, -0.08, 0.95, true);
        this.setBoneOverride('RightLeg', 0.38, 0, 0, 0.95, true);
        break;
      }

      case 'gk_dive_right': {
        // Full horizontal lateral dive to character's RIGHT (-X -> positive bodyRotZ)
        blendSpeed = 26;
        const airArc = Math.sin(Math.min(t / 0.65, 1) * Math.PI);
        this.targetBodyPos.set(-0.35, 0.44 + airArc * 0.55, 0);
        this.targetBodyRot.set(0, 0, 1.46);
        this.setBoneOverride('Head', 0, 0, -0.45, 0.95, true);
        this.setBoneOverride('LeftArm', 0, -0.18, 1.42, 1.0, true);
        this.setBoneOverride('RightArm', 0, 0.18, -1.48, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -0.08, 0, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.08, 0, 1.0, true);
        this.setBoneOverride('LeftUpLeg', -0.18, 0, 0.08, 0.95, true);
        this.setBoneOverride('RightUpLeg', 0.14, 0, -0.12, 0.95, true);
        this.setBoneOverride('LeftLeg', 0.38, 0, 0, 0.95, true);
        break;
      }

      case 'gk_catch': {
        // Athletic crouch clutching ball securely against chest
        blendSpeed = 24;
        this.targetBodyPos.y = -0.16;
        this.setBoneOverride('Spine', 0.24, 0, 0, 0.95, true);
        this.setBoneOverride('LeftUpLeg', -0.52, 0, 0.18, 0.95, true);
        this.setBoneOverride('RightUpLeg', -0.52, 0, -0.18, 0.95, true);
        this.setBoneOverride('LeftLeg', 0.92, 0, 0, 0.95, true);
        this.setBoneOverride('RightLeg', 0.92, 0, 0, 0.95, true);
        // Arms scooping inward in front of chest
        this.setBoneOverride('LeftArm', 0.1, -1.15, -0.52, 1.0, true);
        this.setBoneOverride('RightArm', 0.1, 1.15, 0.52, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -1.05, 0, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 1.05, 0, 1.0, true);
        break;
      }

      case 'ref_whistle': {
        // Right hand bringing whistle to mouth, left arm pointing authoritatively!
        blendSpeed = 22;
        const puff = Math.sin(t * 28) * 0.04;
        showWhistle = true;
        this.setBoneOverride('Spine1', -0.06 + puff, 0, 0, 0.9, true);
        this.setBoneOverride('Head', -0.08, 0, 0, 0.9, true);
        // Right arm bent sharply up to mouth
        this.setBoneOverride('RightArm', 0, 1.05, 0.18, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 1.65, -0.55, 1.0, true);
        // Left arm extended forward pointing foul direction
        this.setBoneOverride('LeftArm', 0, -1.25, -0.1, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -0.1, 0, 1.0, true);
        break;
      }

      case 'ref_yellow_card': {
        // Authoritative skyward Yellow Card raise in RightHand!
        blendSpeed = 24;
        const thrust = Math.min(t / 0.18, 1);
        const shake = Math.sin(t * 16) * 0.05;
        showYellowCard = true;
        this.setBoneOverride('Spine1', -0.08, -0.2, 0, 0.92, true);
        // Right arm punches straight skyward (-Z raises RightArm up!)
        this.setBoneOverride('RightArm', 0, 0.25, lerp(0.5, -1.42, thrust) + shake, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.08, -0.05, 1.0, true);
        // Left arm points sternly at offending player
        this.setBoneOverride('LeftArm', 0, -1.25, -0.22, 0.95, true);
        this.setBoneOverride('LeftForeArm', 0, -0.12, 0, 0.95, true);
        break;
      }

      case 'ref_red_card': {
        // Dramatic skyward Red Card raise + left arm pointing decisively off pitch!
        blendSpeed = 26;
        const thrust = Math.min(t / 0.16, 1);
        const tremor = Math.sin(t * 22) * 0.07;
        showRedCard = true;
        this.targetBodyPos.y = Math.sin(Math.min(t / 0.22, 1) * Math.PI) * 0.12;
        this.setBoneOverride('Spine1', -0.12, -0.28, 0, 0.95, true);
        // Right arm punches straight skyward holding glowing red card
        this.setBoneOverride('RightArm', 0, 0.22, lerp(0.45, -1.48, thrust) + tremor, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.06, -0.04, 1.0, true);
        // Left arm points straight out toward the tunnel!
        this.setBoneOverride('LeftArm', 0, -0.45, 0.12, 0.98, true);
        this.setBoneOverride('LeftForeArm', 0, -0.06, 0, 0.98, true);
        break;
      }

      case 'ref_var_signal': {
        // Iconic VAR TV-rectangle traced in the air with both hands!
        blendSpeed = 20;
        const phase = (t * 1.65) % 4;
        let rectX = 0;
        let rectY = 0;
        if (phase < 1) {
          rectX = lerp(0.08, 0.65, phase);
          rectY = 0.42;
        } else if (phase < 2) {
          rectX = 0.65;
          rectY = lerp(0.42, -0.25, phase - 1);
        } else if (phase < 3) {
          rectX = lerp(0.65, 0.08, phase - 2);
          rectY = -0.25;
        } else {
          rectX = 0.08;
          rectY = lerp(-0.25, 0.42, phase - 3);
        }
        // Arms forward (~±1.35 Y), separating horizontally and moving vertically
        this.setBoneOverride('LeftArm', 0, -1.45 + rectX, rectY, 1.0, true);
        this.setBoneOverride('RightArm', 0, 1.45 - rectX, -rectY, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -0.42, 0, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.42, 0, 1.0, true);
        this.setBoneOverride('Head', Math.sin(t * 5) * 0.1, 0, 0, 0.8, true);
        break;
      }

      case 'coach_shout': {
        // Animated touchline tactical shouting & pointing while holding clipboard!
        blendSpeed = 22;
        const pulse = Math.sin(t * 13);
        this.targetBodyPos.y = Math.abs(Math.sin(t * 7)) * 0.08;
        this.setBoneOverride('Spine1', 0.18, Math.sin(t * 5) * 0.22, 0, 0.92, true);
        this.setBoneOverride('Head', -0.08, Math.sin(t * 8) * 0.2, 0, 0.85, true);
        // Right arm chopping & pointing frantically toward pitch
        this.setBoneOverride('RightArm', 0, 1.25 + pulse * 0.18, -0.15 + pulse * 0.35, 1.0, true);
        this.setBoneOverride('RightForeArm', 0, 0.35, 0, 1.0, true);
        // Left arm holds clipboard up
        this.setBoneOverride('LeftArm', 0.15, -0.78, -0.68 + Math.sin(t * 6.5) * 0.12, 0.98, true);
        this.setBoneOverride('LeftForeArm', 0, -1.05, 0.2, 0.98, true);
        break;
      }

      case 'sitting_bench': {
        // Seated cleanly on dugout bench: hips lowered, thighs forward (-X), shins vertical (+X)
        blendSpeed = 14;
        this.targetBodyPos.y = -0.38;
        this.setBoneOverride('Spine1', 0.08 + Math.sin(g * 2.2) * 0.03, 0, 0, 0.9, true);
        this.setBoneOverride('Head', 0.04, Math.sin(g * 1.4) * 0.32, 0, 0.88, true);
        this.setBoneOverride('LeftUpLeg', -1.48, 0, 0.1, 1.0, true);
        this.setBoneOverride('RightUpLeg', -1.48, 0, -0.1, 1.0, true);
        this.setBoneOverride('LeftLeg', 1.48, 0, 0, 1.0, true);
        this.setBoneOverride('RightLeg', 1.48, 0, 0, 1.0, true);
        // Hands resting relaxed on knees
        this.setBoneOverride('LeftArm', 0.12, -0.65, -0.95, 0.95, true);
        this.setBoneOverride('RightArm', 0.12, 0.65, 0.95, 0.95, true);
        this.setBoneOverride('LeftForeArm', 0, -0.58, 0, 0.95, true);
        this.setBoneOverride('RightForeArm', 0, 0.58, 0, 0.95, true);
        break;
      }

      case 'bench_rage': {
        // Jumping furiously on bench waving both arms in the air!
        blendSpeed = 26;
        const hop = Math.abs(Math.sin(t * 13));
        const wave = Math.sin(t * 22);
        this.targetBodyPos.y = -0.1 + hop * 0.44;
        this.setBoneOverride('Spine1', 0.12, 0, wave * 0.18, 0.95, true);
        this.setBoneOverride('Head', -0.1, Math.sin(t * 16) * 0.34, 0, 0.9, true);
        this.setBoneOverride('LeftArm', 0, -0.35 + wave * 0.25, 1.15 + Math.abs(wave) * 0.25, 1.0, true);
        this.setBoneOverride('RightArm', 0, 0.35 + wave * 0.25, -1.15 - Math.abs(wave) * 0.25, 1.0, true);
        this.setBoneOverride('LeftForeArm', 0, -0.32, 0, 0.95, true);
        this.setBoneOverride('RightForeArm', 0, 0.32, 0, 0.95, true);
        this.setBoneOverride('LeftUpLeg', -0.35 + hop * 0.35, 0, 0.08, 0.9, true);
        this.setBoneOverride('RightUpLeg', -0.35 + hop * 0.35, 0, -0.08, 0.9, true);
        this.setBoneOverride('LeftLeg', 0.55, 0, 0, 0.9, true);
        this.setBoneOverride('RightLeg', 0.55, 0, 0, 0.9, true);
        break;
      }

      default: {
        const _exhaustive: never = animState;
        void _exhaustive;
        break;
      }
    }

    // 4. Smoothly blend whole-body root offsets (snap when dt === 0 for VAR scrub)
    const alpha = safeDt <= 0.0001 ? 1 : 1 - Math.exp(-blendSpeed * safeDt);
    this.bodyPos.lerp(this.targetBodyPos, alpha);
    this.bodyRot.x = lerp(this.bodyRot.x, this.targetBodyRot.x, alpha);
    this.bodyRot.y = lerp(this.bodyRot.y, this.targetBodyRot.y, alpha);
    this.bodyRot.z = lerp(this.bodyRot.z, this.targetBodyRot.z, alpha);

    this.instance.root.position.copy(this.bodyPos);
    this.instance.root.rotation.copy(this.bodyRot);

    // 5. Apply post-mixer procedural bone overrides with smooth slerp transitions
    for (const [boneKey, override] of this.boneOverrides.entries()) {
      const bone = this.instance.bones.get(boneKey);
      if (!bone) continue;

      this.tempQuat.setFromEuler(override.euler);

      if (override.fromRest) {
        const rest = this.instance.restQuats.get(boneKey);
        if (rest) {
          this.targetQuat.copy(rest).multiply(this.tempQuat);
        } else {
          this.targetQuat.copy(this.tempQuat);
        }
      } else {
        this.targetQuat.copy(bone.quaternion).multiply(this.tempQuat);
      }

      let smoothed = this.smoothedBoneQuats.get(boneKey);
      if (!smoothed) {
        smoothed = bone.quaternion.clone();
        this.smoothedBoneQuats.set(boneKey, smoothed);
      }
      smoothed.slerp(this.targetQuat, alpha);

      if (override.weight >= 0.999) {
        bone.quaternion.copy(smoothed);
      } else {
        bone.quaternion.slerp(smoothed, override.weight);
      }
    }

    // Decay smoothed bone cache gently toward current mixer pose for bones no longer overridden
    for (const [boneKey, smoothed] of this.smoothedBoneQuats.entries()) {
      if (!this.boneOverrides.has(boneKey)) {
        const bone = this.instance.bones.get(boneKey);
        if (bone) {
          smoothed.slerp(bone.quaternion, alpha);
        }
      }
    }

    return {
      showYellowCard,
      showRedCard,
      showWhistle,
      airHeight: Math.max(0, this.bodyPos.y),
    };
  }

  public dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.instance.root);
    this.actions.clear();
    this.boneOverrides.clear();
    this.smoothedBoneQuats.clear();
    this.eulerPool.clear();
  }
}
