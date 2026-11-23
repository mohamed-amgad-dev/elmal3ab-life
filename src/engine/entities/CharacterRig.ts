import type { CharacterAnimState } from '../../types/game';
import type { CharacterVisualParts } from './CharacterMesh';

interface PoseTargets {
  bodyPosX: number;
  bodyPosY: number;
  bodyPosZ: number;
  bodyRotX: number;
  bodyRotY: number;
  bodyRotZ: number;
  torsoRotX: number;
  torsoRotY: number;
  torsoRotZ: number;
  headRotX: number;
  headRotY: number;
  headRotZ: number;
  lArmX: number;
  lArmY: number;
  lArmZ: number;
  lForearmX: number;
  rArmX: number;
  rArmY: number;
  rArmZ: number;
  rForearmX: number;
  lLegX: number;
  lLegZ: number;
  lKneeX: number;
  rLegX: number;
  rLegZ: number;
  rKneeX: number;
  browTilt: number; // + angry inward, - raised shocked
  browLift: number;
  mouthScaleY: number;
  mouthScaleX: number;
  showYellowCard: boolean;
  showRedCard: boolean;
  showWhistle: boolean;
}

function createNeutralPose(): PoseTargets {
  return {
    bodyPosX: 0,
    bodyPosY: 0,
    bodyPosZ: 0,
    bodyRotX: 0,
    bodyRotY: 0,
    bodyRotZ: 0,
    torsoRotX: 0,
    torsoRotY: 0,
    torsoRotZ: 0,
    headRotX: 0,
    headRotY: 0,
    headRotZ: 0,
    lArmX: 0,
    lArmY: 0,
    lArmZ: 0.14,
    lForearmX: -0.22,
    rArmX: 0,
    rArmY: 0,
    rArmZ: -0.14,
    rForearmX: -0.22,
    lLegX: 0,
    lLegZ: 0.04,
    lKneeX: 0.06,
    rLegX: 0,
    rLegZ: -0.04,
    rKneeX: 0.06,
    browTilt: 0,
    browLift: 0,
    mouthScaleY: 1,
    mouthScaleX: 1,
    showYellowCard: false,
    showRedCard: false,
    showWhistle: false,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Expressive procedural arcade animation state machine handling all 19
 * `CharacterAnimState` values with smooth pose blending, comedic physics
 * exaggeration, facial expressions, and role prop visibility.
 */
export class CharacterRig {
  private currentState: CharacterAnimState = 'idle';
  private stateTime = 0;
  private readonly phaseOffset: number;
  private readonly pose: PoseTargets = createNeutralPose();

  constructor(seed = 0) {
    this.phaseOffset = (seed % 100) * 0.17;
  }

  public update(
    parts: CharacterVisualParts,
    animState: CharacterAnimState,
    dt: number,
    elapsed: number,
    hasClipboard: boolean
  ): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    if (animState !== this.currentState) {
      this.currentState = animState;
      this.stateTime = 0;
    } else {
      this.stateTime += safeDt;
    }

    const t = this.stateTime;
    const g = elapsed + this.phaseOffset;
    const p = this.pose;

    // Reset target pose to neutral baseline
    p.bodyPosX = 0;
    p.bodyPosY = 0;
    p.bodyPosZ = 0;
    p.bodyRotX = 0;
    p.bodyRotY = 0;
    p.bodyRotZ = 0;
    p.torsoRotX = 0;
    p.torsoRotY = 0;
    p.torsoRotZ = 0;
    p.headRotX = 0;
    p.headRotY = 0;
    p.headRotZ = 0;
    p.lArmX = 0;
    p.lArmY = 0;
    p.lArmZ = 0.14;
    p.lForearmX = -0.22;
    p.rArmX = 0;
    p.rArmY = 0;
    p.rArmZ = -0.14;
    p.rForearmX = -0.22;
    p.lLegX = 0;
    p.lLegZ = 0.04;
    p.lKneeX = 0.06;
    p.rLegX = 0;
    p.rLegZ = -0.04;
    p.rKneeX = 0.06;
    p.browTilt = 0;
    p.browLift = 0;
    p.mouthScaleY = 1;
    p.mouthScaleX = 1;
    p.showYellowCard = false;
    p.showRedCard = false;
    p.showWhistle = false;

    let blendSpeed = 16;

    switch (animState) {
      case 'idle': {
        const bounce = Math.sin(g * 3.4);
        p.bodyPosY = bounce * 0.032;
        p.torsoRotX = 0.04 + bounce * 0.025;
        p.lArmZ = 0.18 + bounce * 0.04;
        p.rArmZ = -0.18 - bounce * 0.04;
        p.lArmX = -0.1 + Math.sin(g * 1.7) * 0.06;
        p.rArmX = -0.1 - Math.sin(g * 1.7) * 0.06;
        p.headRotY = Math.sin(g * 1.15) * 0.16;
        if (hasClipboard) {
          p.lArmX = -0.78;
          p.lForearmX = -0.75;
          p.lArmZ = 0.12;
        }
        break;
      }

      case 'run': {
        const freq = 10.5;
        const c = Math.sin(g * freq);
        const absC = Math.abs(Math.cos(g * freq));
        p.bodyPosY = absC * 0.11;
        p.torsoRotX = 0.18;
        p.torsoRotY = -c * 0.14;
        p.lLegX = c * 0.85;
        p.rLegX = -c * 0.85;
        p.lKneeX = Math.max(0.08, -c * 0.95);
        p.rKneeX = Math.max(0.08, c * 0.95);
        p.lArmX = -c * 0.82;
        p.rArmX = c * 0.82;
        p.lForearmX = -0.85;
        p.rForearmX = -0.85;
        p.lArmZ = 0.22;
        p.rArmZ = -0.22;
        break;
      }

      case 'sprint': {
        const freq = 15.5;
        const c = Math.sin(g * freq);
        const absC = Math.abs(Math.cos(g * freq));
        p.bodyPosY = absC * 0.16;
        p.torsoRotX = 0.34;
        p.torsoRotY = -c * 0.22;
        p.headRotX = -0.22;
        p.lLegX = c * 1.18;
        p.rLegX = -c * 1.18;
        p.lKneeX = Math.max(0.12, -c * 1.35);
        p.rKneeX = Math.max(0.12, c * 1.35);
        p.lArmX = -c * 1.25;
        p.rArmX = c * 1.25;
        p.lForearmX = -1.25;
        p.rForearmX = -1.25;
        p.lArmZ = 0.26;
        p.rArmZ = -0.26;
        p.browTilt = 0.28;
        p.mouthScaleX = 1.2;
        p.mouthScaleY = 1.4;
        break;
      }

      case 'kick': {
        blendSpeed = 26;
        const kickPhase = Math.min(t / 0.34, 1);
        // Quick wind-up (0..0.3) then explosive follow-through (0.3..1)
        const swing =
          kickPhase < 0.28
            ? lerp(0, 0.95, kickPhase / 0.28)
            : lerp(0.95, -1.35, Math.min(1, (kickPhase - 0.28) / 0.42));
        p.bodyPosY = kickPhase > 0.28 && kickPhase < 0.72 ? 0.09 : 0;
        p.torsoRotX = swing < 0 ? -0.18 : 0.16;
        p.torsoRotY = swing < 0 ? 0.38 : -0.3;
        p.rLegX = swing;
        p.rKneeX = swing > 0 ? 1.05 : 0.12;
        p.lLegX = 0.16;
        p.lKneeX = 0.28;
        p.lArmX = -0.65;
        p.lArmZ = 0.72;
        p.rArmX = 0.45;
        p.rArmZ = -0.58;
        p.browTilt = 0.32;
        p.mouthScaleY = 1.8;
        break;
      }

      case 'skill_spin': {
        blendSpeed = 24;
        const spinDur = 0.55;
        const u = Math.min(t / spinDur, 1);
        // Smooth eased full 360-degree step-over spin!
        const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        p.bodyRotY = eased * Math.PI * 2;
        p.bodyPosY = Math.sin(u * Math.PI) * 0.22;
        p.torsoRotX = 0.16;
        const step = Math.sin(t * 28);
        p.lLegX = step * 0.55 - 0.2;
        p.rLegX = -step * 0.55 - 0.2;
        p.lKneeX = 0.55;
        p.rKneeX = 0.55;
        p.lArmZ = 0.95;
        p.rArmZ = -0.95;
        p.lForearmX = -0.45;
        p.rForearmX = -0.45;
        break;
      }

      case 'slide_tackle': {
        blendSpeed = 24;
        p.bodyPosY = 0.26;
        p.bodyPosZ = 0.15;
        p.bodyRotX = -1.24; // Leaning far back horizontally along turf
        p.bodyRotZ = 0.18;
        p.headRotX = 0.78; // Looking forward at ball
        // Right leg extended straight forward toward ball, left leg tucked
        p.rLegX = -0.25;
        p.rKneeX = 0.05;
        p.lLegX = -0.55;
        p.lKneeX = 1.45;
        p.lArmX = 0.4;
        p.lArmZ = 0.85;
        p.rArmX = -0.6;
        p.rArmZ = -0.7;
        p.browTilt = 0.4;
        p.mouthScaleY = 1.9;
        break;
      }

      case 'dive_flop': {
        // HILARIOUS 3-phase Egyptian theatrical dive!
        blendSpeed = 22;
        if (t < 0.34) {
          // Phase 1: Dramatic dolphin leap upward & forward, arms thrown skyward!
          const u = t / 0.34;
          p.bodyPosY = Math.sin(u * Math.PI * 0.75) * 0.92;
          p.bodyPosZ = u * 0.45;
          p.bodyRotX = lerp(0, 1.38, u);
          p.torsoRotX = -0.35; // Arched theatrical back
          p.headRotX = -0.55;
          p.lArmX = -2.4;
          p.rArmX = -2.4;
          p.lArmZ = 0.75;
          p.rArmZ = -0.75;
          p.lLegX = 0.45;
          p.rLegX = 0.25;
          p.lKneeX = 0.85;
          p.rKneeX = 0.65;
          p.browTilt = -0.35;
          p.browLift = 0.045;
          p.mouthScaleX = 1.35;
          p.mouthScaleY = 2.8;
        } else if (t < 0.62) {
          // Phase 2: Belly slam & comical turf bounce into roll!
          const u = (t - 0.34) / 0.28;
          const bounce = Math.abs(Math.sin(u * Math.PI)) * 0.24 * (1 - u * 0.5);
          p.bodyPosY = 0.22 + bounce;
          p.bodyPosZ = 0.45;
          p.bodyRotX = lerp(1.38, -1.52, u); // Flops onto back!
          p.bodyRotZ = Math.sin(u * Math.PI) * 0.85;
          p.lArmX = -1.6;
          p.rArmX = -1.6;
          p.lArmZ = 0.9;
          p.rArmZ = -0.9;
          p.browTilt = -0.3;
          p.mouthScaleY = 2.6;
        } else {
          // Phase 3: Soap-opera writhing on back, clutching knee with both hands!
          const w = t - 0.62;
          const roll = Math.sin(w * 9.5) * 0.48;
          p.bodyPosY = 0.22;
          p.bodyPosZ = 0.42;
          p.bodyRotX = -1.52;
          p.bodyRotZ = roll;
          p.headRotX = 0.55 + Math.sin(w * 14) * 0.18;
          p.headRotY = Math.sin(w * 11) * 0.38;
          // Clutching right knee while left leg kicks dramatically in the air!
          p.rLegX = -1.45;
          p.rKneeX = 1.55;
          p.lLegX = -0.45 + Math.sin(w * 16) * 0.42;
          p.lKneeX = 0.45 + Math.cos(w * 16) * 0.35;
          p.lArmX = -1.15;
          p.rArmX = -1.15;
          p.lArmZ = -0.22;
          p.rArmZ = 0.22;
          p.lForearmX = -0.55;
          p.rForearmX = -0.55;
          p.browTilt = 0.45;
          p.browLift = 0.03;
          p.mouthScaleX = 1.4;
          p.mouthScaleY = 2.5 + Math.sin(w * 18) * 0.5;
        }
        break;
      }

      case 'protest': {
        // Jumping angrily & flailing arms at referee!
        blendSpeed = 24;
        const hop = Math.abs(Math.sin(t * 11));
        const flail = Math.sin(t * 20);
        p.bodyPosY = hop * 0.26;
        p.torsoRotX = 0.16;
        p.torsoRotZ = flail * 0.14;
        p.headRotY = Math.sin(t * 17) * 0.35;
        p.lArmX = -1.85 + flail * 0.55;
        p.rArmX = -1.85 - flail * 0.55;
        p.lArmZ = 0.65 + Math.abs(flail) * 0.35;
        p.rArmZ = -0.65 - Math.abs(flail) * 0.35;
        p.lForearmX = -0.55;
        p.rForearmX = -0.55;
        p.lLegX = hop * 0.25;
        p.rLegX = hop * 0.25;
        p.lKneeX = hop * 0.5;
        p.rKneeX = hop * 0.5;
        p.browTilt = 0.52;
        p.mouthScaleX = 1.35;
        p.mouthScaleY = 2.4 + Math.sin(t * 24) * 0.4;
        break;
      }

      case 'celebrate': {
        // Joyful backflip leap -> arms-wide airplane banking!
        blendSpeed = 20;
        const cycle = t % 2.0;
        if (cycle < 0.72) {
          // Celebratory airborne backflip!
          const u = cycle / 0.72;
          p.bodyPosY = Math.sin(u * Math.PI) * 1.15;
          p.bodyRotX = -u * Math.PI * 2;
          p.lArmX = -2.4;
          p.rArmX = -2.4;
          p.lArmZ = 0.65;
          p.rArmZ = -0.65;
          p.lLegX = -0.65;
          p.rLegX = -0.65;
          p.lKneeX = 1.25;
          p.rKneeX = 1.25;
        } else {
          // Joyful airplane arms-wide sprint bounce!
          const u = cycle - 0.72;
          const bank = Math.sin(u * 8) * 0.26;
          p.bodyPosY = Math.abs(Math.sin(u * 12)) * 0.22;
          p.torsoRotX = 0.24;
          p.torsoRotZ = bank;
          p.lArmZ = 1.48;
          p.rArmZ = -1.48;
          p.lArmX = -0.15;
          p.rArmX = -0.15;
          p.lForearmX = -0.05;
          p.rForearmX = -0.05;
          const leg = Math.sin(u * 14);
          p.lLegX = leg * 0.7;
          p.rLegX = -leg * 0.7;
          p.lKneeX = Math.max(0.1, -leg * 0.8);
          p.rKneeX = Math.max(0.1, leg * 0.8);
        }
        p.browLift = 0.035;
        p.mouthScaleX = 1.45;
        p.mouthScaleY = 2.2;
        break;
      }

      case 'gk_dive_left': {
        // Full horizontal lateral dive to character's LEFT (+X -> negative bodyRotZ)
        blendSpeed = 24;
        const airArc = Math.sin(Math.min(t / 0.65, 1) * Math.PI);
        p.bodyPosX = 0.35;
        p.bodyPosY = 0.42 + airArc * 0.55;
        p.bodyRotZ = -1.46;
        p.headRotZ = 0.45;
        p.lArmX = -2.95;
        p.rArmX = -2.85;
        p.lArmZ = 0.22;
        p.rArmZ = -0.1;
        p.lForearmX = -0.1;
        p.rForearmX = -0.1;
        p.lLegX = 0.15;
        p.rLegX = -0.18;
        p.rKneeX = 0.35;
        p.browTilt = 0.3;
        p.mouthScaleY = 2.0;
        break;
      }

      case 'gk_dive_right': {
        // Full horizontal lateral dive to character's RIGHT (-X -> positive bodyRotZ)
        blendSpeed = 24;
        const airArc = Math.sin(Math.min(t / 0.65, 1) * Math.PI);
        p.bodyPosX = -0.35;
        p.bodyPosY = 0.42 + airArc * 0.55;
        p.bodyRotZ = 1.46;
        p.headRotZ = -0.45;
        p.lArmX = -2.85;
        p.rArmX = -2.95;
        p.lArmZ = 0.1;
        p.rArmZ = -0.22;
        p.lForearmX = -0.1;
        p.rForearmX = -0.1;
        p.lLegX = -0.18;
        p.rLegX = 0.15;
        p.lKneeX = 0.35;
        p.browTilt = 0.3;
        p.mouthScaleY = 2.0;
        break;
      }

      case 'gk_catch': {
        // Athletic scoop-and-clutch catch crouch!
        blendSpeed = 24;
        p.bodyPosY = -0.18;
        p.torsoRotX = 0.32;
        p.lLegX = -0.52;
        p.rLegX = -0.52;
        p.lLegZ = 0.22;
        p.rLegZ = -0.22;
        p.lKneeX = 0.92;
        p.rKneeX = 0.92;
        p.lArmX = -1.15;
        p.rArmX = -1.15;
        p.lArmZ = -0.28;
        p.rArmZ = 0.28;
        p.lForearmX = -1.05;
        p.rForearmX = -1.05;
        p.browTilt = 0.25;
        break;
      }

      case 'ref_whistle': {
        // Blowing whistle firmly with right hand to mouth, left arm pointing!
        blendSpeed = 22;
        const puff = Math.sin(t * 28) * 0.04;
        p.showWhistle = true;
        p.torsoRotX = -0.06 + puff;
        p.headRotX = -0.08;
        p.rArmX = -1.45;
        p.rArmZ = 0.32;
        p.rForearmX = -1.45;
        p.lArmX = -1.45;
        p.lArmZ = 0.38;
        p.lForearmX = -0.12;
        p.browTilt = 0.38;
        p.mouthScaleX = 0.55;
        p.mouthScaleY = 1.4;
        break;
      }

      case 'ref_yellow_card': {
        // Authoritative skyward Yellow Card raise!
        blendSpeed = 24;
        const thrust = Math.min(t / 0.18, 1);
        const shake = Math.sin(t * 16) * 0.05;
        p.showYellowCard = true;
        p.torsoRotX = -0.08;
        p.torsoRotY = -0.2;
        p.rArmX = lerp(-0.6, -3.05, thrust) + shake;
        p.rArmZ = -0.12;
        p.rForearmX = -0.05;
        p.lArmX = -1.35;
        p.lArmZ = 0.25;
        p.lForearmX = -0.1;
        p.browTilt = 0.45;
        p.mouthScaleY = 1.7;
        break;
      }

      case 'ref_red_card': {
        // Dramatic skyward Red Card raise + pointing off pitch!
        blendSpeed = 26;
        const thrust = Math.min(t / 0.16, 1);
        const tremor = Math.sin(t * 22) * 0.07;
        p.showRedCard = true;
        p.bodyPosY = Math.sin(Math.min(t / 0.22, 1) * Math.PI) * 0.12;
        p.torsoRotX = -0.12;
        p.torsoRotY = -0.28;
        p.rArmX = lerp(-0.5, -3.08, thrust) + tremor;
        p.rArmZ = -0.15;
        p.rForearmX = -0.04;
        p.lArmX = -1.48;
        p.lArmZ = 0.85; // Pointing decisively toward the tunnel!
        p.lForearmX = -0.06;
        p.browTilt = 0.58;
        p.mouthScaleX = 1.3;
        p.mouthScaleY = 2.3;
        break;
      }

      case 'ref_var_signal': {
        // Iconic VAR TV-rectangle traced in the air with both hands!
        blendSpeed = 20;
        const phase = (t * 1.65) % 4;
        let rectX = 0; // horizontal separation width
        let rectY = 0; // vertical height offset
        if (phase < 1) {
          // Top edge: hands move apart at high level
          rectX = lerp(0.05, 0.55, phase);
          rectY = 0.42;
        } else if (phase < 2) {
          // Side edges: hands drop down vertically
          rectX = 0.55;
          rectY = lerp(0.42, -0.12, phase - 1);
        } else if (phase < 3) {
          // Bottom edge: hands meet together at bottom
          rectX = lerp(0.55, 0.05, phase - 2);
          rectY = -0.12;
        } else {
          // Return upward to center top
          rectX = 0.05;
          rectY = lerp(-0.12, 0.42, phase - 3);
        }
        p.lArmX = -1.55 - rectY;
        p.rArmX = -1.55 - rectY;
        p.lArmZ = -0.25 + rectX;
        p.rArmZ = 0.25 - rectX;
        p.lForearmX = -0.42;
        p.rForearmX = -0.42;
        p.headRotX = Math.sin(t * 5) * 0.1;
        p.browTilt = 0.2;
        break;
      }

      case 'coach_shout': {
        // Animated touchline tactical shouting & pointing!
        blendSpeed = 22;
        const pulse = Math.sin(t * 13);
        p.bodyPosY = Math.abs(Math.sin(t * 7)) * 0.08;
        p.torsoRotX = 0.18;
        p.torsoRotY = Math.sin(t * 5) * 0.22;
        p.headRotY = Math.sin(t * 8) * 0.2;
        // Right arm pointing & chopping frantically toward pitch
        p.rArmX = -1.65 + pulse * 0.38;
        p.rArmZ = -0.35 + pulse * 0.18;
        p.rForearmX = -0.35;
        // Left arm holds clipboard up
        p.lArmX = -0.95 + Math.sin(t * 6.5) * 0.16;
        p.lArmZ = 0.24;
        p.lForearmX = -0.85;
        p.browTilt = 0.45;
        p.mouthScaleX = 1.35;
        p.mouthScaleY = 2.2 + Math.abs(pulse) * 0.6;
        break;
      }

      case 'sitting_bench': {
        // Seated cleanly on bench chair: hips lowered, thighs forward, shins vertical
        blendSpeed = 14;
        p.bodyPosY = -0.34;
        p.torsoRotX = 0.08 + Math.sin(g * 2.2) * 0.03;
        p.headRotY = Math.sin(g * 1.4) * 0.34;
        p.lLegX = -1.48;
        p.rLegX = -1.48;
        p.lLegZ = 0.12;
        p.rLegZ = -0.12;
        p.lKneeX = 1.48;
        p.rKneeX = 1.48;
        p.lArmX = -0.58;
        p.rArmX = -0.58;
        p.lArmZ = 0.18;
        p.rArmZ = -0.18;
        p.lForearmX = -0.65;
        p.rForearmX = -0.65;
        break;
      }

      case 'bench_rage': {
        // Jumping up & down furiously on bench waving both arms!
        blendSpeed = 26;
        const hop = Math.abs(Math.sin(t * 13));
        const wave = Math.sin(t * 22);
        p.bodyPosY = -0.12 + hop * 0.46;
        p.torsoRotX = 0.12;
        p.torsoRotZ = wave * 0.18;
        p.headRotY = Math.sin(t * 16) * 0.35;
        p.lArmX = -2.55 + wave * 0.4;
        p.rArmX = -2.55 - wave * 0.4;
        p.lArmZ = 0.55 + Math.abs(wave) * 0.3;
        p.rArmZ = -0.55 - Math.abs(wave) * 0.3;
        p.lForearmX = -0.35;
        p.rForearmX = -0.35;
        p.lLegX = -0.35 + hop * 0.35;
        p.rLegX = -0.35 + hop * 0.35;
        p.lKneeX = 0.55;
        p.rKneeX = 0.55;
        p.browTilt = 0.56;
        p.mouthScaleX = 1.45;
        p.mouthScaleY = 2.8;
        break;
      }

      default: {
        const _exhaustive: never = animState;
        void _exhaustive;
        break;
      }
    }

    // Apply smoothly blended transforms (snap immediately if dt === 0 for VAR scrubbing)
    const alpha = safeDt <= 0.0001 ? 1 : 1 - Math.exp(-blendSpeed * safeDt);

    parts.bodyRoot.position.x = lerp(parts.bodyRoot.position.x, p.bodyPosX, alpha);
    parts.bodyRoot.position.y = lerp(parts.bodyRoot.position.y, p.bodyPosY, alpha);
    parts.bodyRoot.position.z = lerp(parts.bodyRoot.position.z, p.bodyPosZ, alpha);
    parts.bodyRoot.rotation.x = lerp(parts.bodyRoot.rotation.x, p.bodyRotX, alpha);
    parts.bodyRoot.rotation.y = lerp(parts.bodyRoot.rotation.y, p.bodyRotY, alpha);
    parts.bodyRoot.rotation.z = lerp(parts.bodyRoot.rotation.z, p.bodyRotZ, alpha);

    parts.torso.rotation.x = lerp(parts.torso.rotation.x, p.torsoRotX, alpha);
    parts.torso.rotation.y = lerp(parts.torso.rotation.y, p.torsoRotY, alpha);
    parts.torso.rotation.z = lerp(parts.torso.rotation.z, p.torsoRotZ, alpha);

    parts.headGroup.rotation.x = lerp(parts.headGroup.rotation.x, p.headRotX, alpha);
    parts.headGroup.rotation.y = lerp(parts.headGroup.rotation.y, p.headRotY, alpha);
    parts.headGroup.rotation.z = lerp(parts.headGroup.rotation.z, p.headRotZ, alpha);

    parts.leftArmPivot.rotation.x = lerp(parts.leftArmPivot.rotation.x, p.lArmX, alpha);
    parts.leftArmPivot.rotation.y = lerp(parts.leftArmPivot.rotation.y, p.lArmY, alpha);
    parts.leftArmPivot.rotation.z = lerp(parts.leftArmPivot.rotation.z, p.lArmZ, alpha);
    parts.leftForearmPivot.rotation.x = lerp(parts.leftForearmPivot.rotation.x, p.lForearmX, alpha);

    parts.rightArmPivot.rotation.x = lerp(parts.rightArmPivot.rotation.x, p.rArmX, alpha);
    parts.rightArmPivot.rotation.y = lerp(parts.rightArmPivot.rotation.y, p.rArmY, alpha);
    parts.rightArmPivot.rotation.z = lerp(parts.rightArmPivot.rotation.z, p.rArmZ, alpha);
    parts.rightForearmPivot.rotation.x = lerp(parts.rightForearmPivot.rotation.x, p.rForearmX, alpha);

    parts.leftLegPivot.rotation.x = lerp(parts.leftLegPivot.rotation.x, p.lLegX, alpha);
    parts.leftLegPivot.rotation.z = lerp(parts.leftLegPivot.rotation.z, p.lLegZ, alpha);
    parts.leftKneePivot.rotation.x = lerp(parts.leftKneePivot.rotation.x, p.lKneeX, alpha);

    parts.rightLegPivot.rotation.x = lerp(parts.rightLegPivot.rotation.x, p.rLegX, alpha);
    parts.rightLegPivot.rotation.z = lerp(parts.rightLegPivot.rotation.z, p.rLegZ, alpha);
    parts.rightKneePivot.rotation.x = lerp(parts.rightKneePivot.rotation.x, p.rKneeX, alpha);

    // Facial expressions
    parts.leftBrow.rotation.z = lerp(parts.leftBrow.rotation.z, p.browTilt, alpha);
    parts.rightBrow.rotation.z = lerp(parts.rightBrow.rotation.z, -p.browTilt, alpha);
    parts.leftBrow.position.y = lerp(parts.leftBrow.position.y, 0.12 + p.browLift, alpha);
    parts.rightBrow.position.y = lerp(parts.rightBrow.position.y, 0.12 + p.browLift, alpha);
    parts.mouthMesh.scale.x = lerp(parts.mouthMesh.scale.x, p.mouthScaleX, alpha);
    parts.mouthMesh.scale.y = lerp(parts.mouthMesh.scale.y, p.mouthScaleY, alpha);

    // Role props visibility & pop scale
    if (parts.yellowCardProp) {
      parts.yellowCardProp.visible = p.showYellowCard;
      if (p.showYellowCard) {
        const s = 1 + Math.sin(t * 14) * 0.08;
        parts.yellowCardProp.scale.set(s, s, 1);
      }
    }
    if (parts.redCardProp) {
      parts.redCardProp.visible = p.showRedCard;
      if (p.showRedCard) {
        const s = 1.06 + Math.sin(t * 18) * 0.1;
        parts.redCardProp.scale.set(s, s, 1);
      }
    }
    if (parts.whistleProp) {
      parts.whistleProp.visible = p.showWhistle;
    }

    // Contact shadow subtly shrinks when airborne
    const airHeight = Math.max(0, parts.bodyRoot.position.y);
    const shadowScale = Math.max(0.45, 1 - airHeight * 0.42);
    parts.shadowDisc.scale.set(shadowScale, shadowScale, 1);
  }
}
