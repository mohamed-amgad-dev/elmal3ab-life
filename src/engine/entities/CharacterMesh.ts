import * as THREE from 'three';
import type { PlayerEntityState, RoleType, TeamId } from '../../types/game';

export interface CharacterVisualParts {
  root: THREE.Group;
  bodyRoot: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  headGroup: THREE.Group;
  leftBrow: THREE.Mesh;
  rightBrow: THREE.Mesh;
  mouthMesh: THREE.Mesh;
  leftArmPivot: THREE.Group;
  rightArmPivot: THREE.Group;
  leftForearmPivot: THREE.Group;
  rightForearmPivot: THREE.Group;
  leftLegPivot: THREE.Group;
  rightLegPivot: THREE.Group;
  leftKneePivot: THREE.Group;
  rightKneePivot: THREE.Group;
  shadowDisc: THREE.Mesh;
  controlRing: THREE.Mesh;
  controlRingInner: THREE.Mesh;
  yellowCardProp: THREE.Mesh | null;
  redCardProp: THREE.Mesh | null;
  whistleProp: THREE.Group | null;
  clipboardProp: THREE.Group | null;
  nameTagSprite: THREE.Sprite;
  nameTagTexture: THREE.CanvasTexture;
  speechBubbleSprite: THREE.Sprite;
  speechBubbleTexture: THREE.CanvasTexture;
  disposables: Array<{ dispose: () => void }>;
}

export interface CharacterVisualKey {
  team: TeamId | 'ref' | 'neutral';
  role: RoleType;
  number: number;
  name: string;
}

const SKIN_TONES = [0xf2c29b, 0xd99b6c, 0xc28154, 0x9c623c, 0xe8b48a];
const HAIR_COLORS = [0x171412, 0x2a1d14, 0x101318, 0x3b281c, 0x1e1b18];

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export interface KitPalette {
  primary: string;
  secondary: string;
  accent: string;
  shorts: number;
  socks: number;
  cleats: number;
  striped?: boolean;
  isKeeper?: boolean;
  isCoach?: boolean;
  numberColor: string;
  numberOutline: string;
}

export function getKitPalette(team: TeamId | 'ref' | 'neutral', role: RoleType): KitPalette {
  if (role === 'referee' || team === 'ref') {
    return {
      primary: '#ffe600',
      secondary: '#12151c',
      accent: '#ffffff',
      shorts: 0x111319,
      socks: 0x181c26,
      cleats: 0xffe600,
      striped: true,
      numberColor: '#ffe600',
      numberOutline: '#000000',
    };
  }

  if (role === 'coach') {
    const isRed = team === 'red';
    return {
      primary: '#1b2234',
      secondary: isRed ? '#ff2e4c' : '#00c2ff',
      accent: isRed ? '#ffd166' : '#7ef9ff',
      shorts: 0x151a28,
      socks: 0x1b2234,
      cleats: 0x262d3d,
      isCoach: true,
      numberColor: '#ffffff',
      numberOutline: '#000000',
    };
  }

  if (role === 'goalkeeper') {
    if (team === 'red') {
      return {
        primary: '#a3ff12',
        secondary: '#122618',
        accent: '#ff2e4c',
        shorts: 0x16221c,
        socks: 0xa3ff12,
        cleats: 0xff2e4c,
        isKeeper: true,
        numberColor: '#0e1a10',
        numberOutline: '#ffffff',
      };
    }
    return {
      primary: '#ff7b00',
      secondary: '#1b1626',
      accent: '#00c2ff',
      shorts: 0x171828,
      socks: 0xff7b00,
      cleats: 0x00c2ff,
      isKeeper: true,
      numberColor: '#120d1a',
      numberOutline: '#ffffff',
    };
  }

  if (team === 'red') {
    return {
      primary: '#ff2e4c',
      secondary: '#9e112b',
      accent: '#ffd166',
      shorts: 0x8c0f24,
      socks: 0xff2e4c,
      cleats: 0xffd166,
      numberColor: '#ffffff',
      numberOutline: '#730a1c',
    };
  }

  if (team === 'blue') {
    return {
      primary: '#00c2ff',
      secondary: '#0b2545',
      accent: '#e0fbff',
      shorts: 0x0b2545,
      socks: 0x00c2ff,
      cleats: 0xffffff,
      numberColor: '#ffffff',
      numberOutline: '#071b36',
    };
  }

  return {
    primary: '#8e9aaf',
    secondary: '#3c4559',
    accent: '#ffd166',
    shorts: 0x2a3040,
    socks: 0x8e9aaf,
    cleats: 0xffffff,
    numberColor: '#ffffff',
    numberOutline: '#1a202c',
  };
}

/**
 * Generates a crisp procedural torso texture for BoxGeometry face mapping
 * or Cylinder/Box jersey wrap with front chest crest/number and large back number.
 */
function createJerseyFaceTexture(
  palette: KitPalette,
  jerseyNumber: number,
  side: 'front' | 'back' | 'side'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  // Base fill
  ctx.fillStyle = palette.primary;
  ctx.fillRect(0, 0, 256, 256);

  if (palette.striped) {
    // Referee bold vertical stripes
    ctx.fillStyle = palette.secondary;
    const stripeW = 32;
    for (let x = 0; x < 256; x += stripeW * 2) {
      ctx.fillRect(x, 0, stripeW, 256);
    }
    // Collar & whistle pocket accent
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, 256, 26);
    if (side === 'front') {
      // FIFA-style ref chest badge
      ctx.fillStyle = '#111827';
      ctx.beginPath();
      ctx.roundRect(156, 56, 54, 62, 10);
      ctx.fill();
      ctx.strokeStyle = '#ffe600';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = '#ffe600';
      ctx.font = '900 22px Cairo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('REF', 183, 88);
    }
  } else if (palette.isCoach) {
    // Sleek tracksuit jacket with central zipper & team chest stripe
    ctx.fillStyle = palette.secondary;
    ctx.fillRect(0, 38, 256, 24);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 62, 256, 7);
    if (side === 'front') {
      // Center zipper line
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(125, 0, 6, 256);
      // Coach badge
      ctx.fillStyle = palette.secondary;
      ctx.beginPath();
      ctx.roundRect(148, 86, 66, 36, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 18px Cairo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('COACH', 181, 105);
    } else if (side === 'back') {
      ctx.fillStyle = palette.accent;
      ctx.font = '900 42px Cairo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('المدرب', 128, 140);
    }
  } else if (palette.isKeeper) {
    // Dynamic geometric keeper chevron pattern
    ctx.fillStyle = palette.secondary;
    ctx.globalAlpha = 0.28;
    for (let y = 20; y < 240; y += 44) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(128, y + 26);
      ctx.lineTo(256, y);
      ctx.lineTo(256, y + 18);
      ctx.lineTo(128, y + 44);
      ctx.lineTo(0, y + 18);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Bold shoulder/collar accent
    ctx.fillStyle = palette.secondary;
    ctx.fillRect(0, 0, 256, 28);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 24, 256, 8);
  } else {
    // Outfield arcade jersey: bold athletic V-panel & gold/navy trim
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, palette.primary);
    grad.addColorStop(1, palette.secondary);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    // Stylish diagonal speed sash
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.moveTo(0, 175);
    ctx.lineTo(256, 55);
    ctx.lineTo(256, 105);
    ctx.lineTo(0, 225);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Collar + hem trim
    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 0, 256, 22);
    ctx.fillRect(0, 238, 256, 18);

    if (side === 'side') {
      // Side stripe
      ctx.fillStyle = palette.accent;
      ctx.fillRect(108, 0, 40, 256);
    }
  }

  // Draw crisp jersey number for outfield & goalkeepers
  if (!palette.striped && !palette.isCoach && jerseyNumber > 0) {
    const numStr = String(jerseyNumber);
    if (side === 'back') {
      ctx.font = '900 132px Cairo, Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 14;
      ctx.strokeStyle = palette.numberOutline;
      ctx.strokeText(numStr, 128, 138);
      ctx.fillStyle = palette.numberColor;
      ctx.fillText(numStr, 128, 138);
    } else if (side === 'front') {
      // Small team crest on chest left
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(182, 68, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = palette.secondary;
      ctx.lineWidth = 4;
      ctx.stroke();

      // Medium chest number
      ctx.font = '900 84px Cairo, Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 10;
      ctx.strokeStyle = palette.numberOutline;
      ctx.strokeText(numStr, 114, 154);
      ctx.fillStyle = palette.numberColor;
      ctx.fillText(numStr, 114, 154);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Redraws the overhead HUD pill CanvasTexture cleanly whenever name, yellowCards,
 * sentOff, or human-controlled state changes.
 */
export function drawNameTagCanvas(
  canvas: HTMLCanvasElement,
  player: PlayerEntityState
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const badgeColor =
    player.role === 'referee' || player.team === 'ref'
      ? '#ffe600'
      : player.team === 'red'
        ? '#ff2e4c'
        : player.team === 'blue'
          ? '#00c2ff'
          : '#94a3b8';

  const rolePrefix =
    player.role === 'goalkeeper'
      ? '🧤'
      : player.role === 'referee'
        ? '🏁'
        : player.role === 'coach'
          ? '📋'
          : player.isHumanControlled
            ? '★'
            : '';

  const shortName = player.name.length > 14 ? `${player.name.slice(0, 13)}…` : player.name;
  const label = rolePrefix ? `${shortName} ${rolePrefix}` : shortName;

  // Measure pill width
  ctx.font = '800 34px Cairo, Tajawal, system-ui, sans-serif';
  const textW = ctx.measureText(label).width;
  const cardExtra = player.isSentOff || player.yellowCards > 0 ? 44 : 0;
  const pillW = Math.min(w - 16, Math.max(170, textW + 56 + cardExtra));
  const pillH = 66;
  const x = (w - pillW) / 2;
  const y = (h - pillH) / 2;

  // Drop shadow glow
  ctx.save();
  ctx.shadowColor = player.isHumanControlled ? '#ffe600' : 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = player.isHumanControlled ? 16 : 10;

  // Pill background
  ctx.fillStyle = player.isHumanControlled
    ? 'rgba(15, 23, 42, 0.92)'
    : 'rgba(10, 14, 26, 0.80)';
  ctx.beginPath();
  ctx.roundRect(x, y, pillW, pillH, 33);
  ctx.fill();
  ctx.restore();

  // Colored border
  ctx.lineWidth = player.isHumanControlled ? 5 : 3.5;
  ctx.strokeStyle = player.isHumanControlled ? '#ffd166' : badgeColor;
  ctx.beginPath();
  ctx.roundRect(x, y, pillW, pillH, 33);
  ctx.stroke();

  // Team accent dot on right side (RTL friendly)
  ctx.fillStyle = badgeColor;
  ctx.beginPath();
  ctx.arc(x + pillW - 22, y + pillH / 2, 9, 0, Math.PI * 2);
  ctx.fill();

  // Text
  ctx.fillStyle = player.isHumanControlled ? '#fffbeb' : '#f8fafc';
  ctx.font = '800 32px Cairo, Tajawal, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textCenterX = x + (pillW - 14 + (cardExtra > 0 ? 18 : 0)) / 2;
  ctx.fillText(label, textCenterX, y + pillH / 2 + 2);

  // Tiny card indicator (yellow or red if sent off)
  if (player.isSentOff || player.yellowCards > 0) {
    const cx = x + 22;
    const cy = y + 16;
    ctx.fillStyle = player.isSentOff ? '#ff1744' : '#ffe600';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(cx, cy, 22, 32, 4);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Draws a punchy comic Arabic speech bubble on a CanvasTexture.
 */
export function drawSpeechBubbleCanvas(
  canvas: HTMLCanvasElement,
  text: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!text.trim()) return;

  ctx.font = '900 36px Cairo, Tajawal, system-ui, sans-serif';
  const display = text.length > 26 ? `${text.slice(0, 25)}…` : text;
  const measured = ctx.measureText(display).width;
  const bubbleW = Math.min(w - 24, Math.max(190, measured + 64));
  const bubbleH = 84;
  const bx = (w - bubbleW) / 2;
  const by = 14;

  // Comic drop shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.roundRect(bx + 5, by + 7, bubbleW, bubbleH, 24);
  ctx.fill();
  ctx.restore();

  // Bubble body (dark slate + warm gold border so it stays below UnrealBloomPass threshold)
  ctx.fillStyle = 'rgba(10, 15, 32, 0.94)';
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(bx, by, bubbleW, bubbleH, 24);
  ctx.fill();
  ctx.stroke();

  // Comic speech pointer tail
  const tx = w / 2;
  const ty = by + bubbleH - 2;
  ctx.beginPath();
  ctx.moveTo(tx - 16, ty);
  ctx.lineTo(tx - 4, ty + 24);
  ctx.lineTo(tx + 14, ty);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10, 15, 32, 0.96)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(tx - 16, ty);
  ctx.lineTo(tx - 4, ty + 24);
  ctx.lineTo(tx + 14, ty);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Cover top seam of tail cleanly
  ctx.fillStyle = 'rgba(10, 15, 32, 0.98)';
  ctx.fillRect(tx - 15, ty - 5, 28, 9);

  // Crisp high-contrast Arabic text
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 34px Cairo, Tajawal, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, w / 2, by + bubbleH / 2 + 2);
}

/**
 * Builds an expressive stylized arcade 3D character mesh hierarchy with
 * articulated joints, procedural jersey numbers, role props, overhead HUD badge,
 * comic speech bubble, and glowing human-control ground ring.
 *
 * Orientation convention:
 * - Character faces +Z at rotY = 0.
 * - Character's LEFT is +X, RIGHT is -X.
 * - Feet rest cleanly at Y = 0.
 */
export function buildCharacterMesh(player: PlayerEntityState): CharacterVisualParts {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const palette = getKitPalette(player.team, player.role);
  const idHash = hashString(player.id + player.name);
  const skinColor = SKIN_TONES[idHash % SKIN_TONES.length];
  const hairColor = HAIR_COLORS[(idHash >> 3) % HAIR_COLORS.length];

  const skinMat = track(
    new THREE.MeshStandardMaterial({
      color: skinColor,
      roughness: 0.62,
      metalness: 0.04,
    })
  );
  const hairMat = track(
    new THREE.MeshStandardMaterial({
      color: hairColor,
      roughness: 0.78,
      metalness: 0.05,
    })
  );
  const primaryMat = track(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.primary),
      roughness: 0.48,
      metalness: 0.08,
    })
  );
  const secondaryMat = track(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.secondary),
      roughness: 0.52,
      metalness: 0.1,
    })
  );
  const accentMat = track(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.accent),
      roughness: 0.35,
      metalness: 0.2,
    })
  );
  const shortsMat = track(
    new THREE.MeshStandardMaterial({
      color: palette.shorts,
      roughness: 0.6,
      metalness: 0.05,
    })
  );
  const socksMat = track(
    new THREE.MeshStandardMaterial({
      color: palette.socks,
      roughness: 0.58,
      metalness: 0.05,
    })
  );
  const cleatsMat = track(
    new THREE.MeshStandardMaterial({
      color: palette.cleats,
      roughness: 0.32,
      metalness: 0.25,
    })
  );

  const root = new THREE.Group();
  root.name = `char_${player.id}`;

  // Ground contact shadow disc
  const shadowGeo = track(new THREE.CircleGeometry(0.58, 20));
  const shadowMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x04070f,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    })
  );
  const shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
  shadowDisc.rotation.x = -Math.PI / 2;
  shadowDisc.position.y = 0.025;
  root.add(shadowDisc);

  // Active human-control glowing ground ring
  const ringGeo = track(new THREE.RingGeometry(0.72, 0.96, 32));
  const ringMat = track(
    new THREE.MeshBasicMaterial({
      color: player.team === 'blue' ? 0x00e5ff : player.role === 'referee' ? 0xffe600 : 0xffd166,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    })
  );
  const controlRing = new THREE.Mesh(ringGeo, ringMat);
  controlRing.rotation.x = -Math.PI / 2;
  controlRing.position.y = 0.04;
  controlRing.visible = player.isHumanControlled;
  root.add(controlRing);

  const innerRingGeo = track(new THREE.RingGeometry(0.58, 0.66, 28));
  const innerRingMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    })
  );
  const controlRingInner = new THREE.Mesh(innerRingGeo, innerRingMat);
  controlRingInner.rotation.x = -Math.PI / 2;
  controlRingInner.position.y = 0.045;
  controlRingInner.visible = player.isHumanControlled;
  root.add(controlRingInner);

  // Body root (allows jumping, diving, flopping, spinning)
  const bodyRoot = new THREE.Group();
  root.add(bodyRoot);

  // Hips / Pelvis
  const hips = new THREE.Group();
  hips.position.y = 0.84;
  bodyRoot.add(hips);

  const pelvisGeo = track(new THREE.BoxGeometry(0.52, 0.24, 0.34));
  const pelvisMesh = new THREE.Mesh(pelvisGeo, shortsMat);
  pelvisMesh.castShadow = true;
  pelvisMesh.receiveShadow = true;
  hips.add(pelvisMesh);

  // Legs helper (hip pivot -> thigh -> knee pivot -> shin/sock -> cleat)
  const thighGeo = track(new THREE.CylinderGeometry(0.11, 0.095, 0.36, 10));
  const shinGeo = track(new THREE.CylinderGeometry(0.085, 0.075, 0.34, 10));
  const sockBandGeo = track(new THREE.CylinderGeometry(0.089, 0.087, 0.07, 10));
  const cleatGeo = track(new THREE.BoxGeometry(0.16, 0.11, 0.30));

  const createLeg = (xOffset: number): { legPivot: THREE.Group; kneePivot: THREE.Group } => {
    const legPivot = new THREE.Group();
    legPivot.position.set(xOffset, -0.08, 0);
    hips.add(legPivot);

    // Shorts thigh + skin lower thigh
    const shortsLeg = new THREE.Mesh(thighGeo, shortsMat);
    shortsLeg.scale.set(1.08, 0.62, 1.08);
    shortsLeg.position.y = -0.11;
    shortsLeg.castShadow = true;
    legPivot.add(shortsLeg);

    const lowerThigh = new THREE.Mesh(thighGeo, player.role === 'coach' ? shortsMat : skinMat);
    lowerThigh.scale.set(0.88, 0.56, 0.88);
    lowerThigh.position.y = -0.28;
    lowerThigh.castShadow = true;
    legPivot.add(lowerThigh);

    const kneePivot = new THREE.Group();
    kneePivot.position.y = -0.37;
    legPivot.add(kneePivot);

    const shin = new THREE.Mesh(shinGeo, player.role === 'coach' ? shortsMat : socksMat);
    shin.position.y = -0.17;
    shin.castShadow = true;
    kneePivot.add(shin);

    if (player.role !== 'coach') {
      const sockBand = new THREE.Mesh(sockBandGeo, accentMat);
      sockBand.position.y = -0.04;
      kneePivot.add(sockBand);
    }

    const cleat = new THREE.Mesh(cleatGeo, cleatsMat);
    cleat.position.set(0, -0.34, 0.06);
    cleat.castShadow = true;
    kneePivot.add(cleat);

    return { legPivot, kneePivot };
  };

  const leftLeg = createLeg(0.15);
  const rightLeg = createLeg(-0.15);

  // Torso (chunky athletic silhouette with front/back canvas jersey textures)
  const torso = new THREE.Group();
  torso.position.y = 0.10;
  hips.add(torso);

  const frontTex = track(createJerseyFaceTexture(palette, player.number, 'front'));
  const backTex = track(createJerseyFaceTexture(palette, player.number, 'back'));
  const sideTex = track(createJerseyFaceTexture(palette, player.number, 'side'));

  const frontMat = track(
    new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.45, metalness: 0.06 })
  );
  const backMat = track(
    new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.45, metalness: 0.06 })
  );
  const sideMat = track(
    new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.48, metalness: 0.06 })
  );

  // BoxGeometry material order: +X, -X, +Y, -Y, +Z (front), -Z (back)
  const chestGeo = track(new THREE.BoxGeometry(0.62, 0.68, 0.36));
  const chestMesh = new THREE.Mesh(chestGeo, [
    sideMat,
    sideMat,
    primaryMat,
    secondaryMat,
    frontMat,
    backMat,
  ]);
  chestMesh.position.y = 0.34;
  chestMesh.castShadow = true;
  chestMesh.receiveShadow = true;
  torso.add(chestMesh);

  // Athletic rounded shoulder pads for chunky arcade readability
  const shoulderGeo = track(new THREE.SphereGeometry(0.145, 10, 8));
  const leftShoulderCap = new THREE.Mesh(shoulderGeo, primaryMat);
  leftShoulderCap.position.set(0.32, 0.58, 0);
  torso.add(leftShoulderCap);

  const rightShoulderCap = new THREE.Mesh(shoulderGeo, primaryMat);
  rightShoulderCap.position.set(-0.32, 0.58, 0);
  torso.add(rightShoulderCap);

  // Neck
  const neckGeo = track(new THREE.CylinderGeometry(0.10, 0.11, 0.14, 10));
  const neckMesh = new THREE.Mesh(neckGeo, skinMat);
  neckMesh.position.y = 0.72;
  torso.add(neckMesh);

  // Expressive Stylized Head
  const headGroup = new THREE.Group();
  headGroup.position.y = 0.96;
  torso.add(headGroup);

  const headGeo = track(new THREE.SphereGeometry(0.28, 16, 14));
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.scale.set(0.96, 1.04, 0.98);
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  headGroup.add(headMesh);

  // Cute stylized ears
  const earGeo = track(new THREE.SphereGeometry(0.065, 8, 8));
  const leftEar = new THREE.Mesh(earGeo, skinMat);
  leftEar.position.set(0.26, -0.01, 0.0);
  headGroup.add(leftEar);
  const rightEar = new THREE.Mesh(earGeo, skinMat);
  rightEar.position.set(-0.26, -0.01, 0.0);
  headGroup.add(rightEar);

  // Hair tuft / Coach cap
  if (player.role === 'coach') {
    const capDomeGeo = track(new THREE.SphereGeometry(0.295, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52));
    const capMat = secondaryMat;
    const capDome = new THREE.Mesh(capDomeGeo, capMat);
    capDome.position.y = 0.04;
    headGroup.add(capDome);

    const visorGeo = track(new THREE.BoxGeometry(0.34, 0.045, 0.22));
    const visor = new THREE.Mesh(visorGeo, accentMat);
    visor.position.set(0, 0.07, 0.24);
    visor.rotation.x = 0.12;
    headGroup.add(visor);
  } else {
    const hairCapGeo = track(new THREE.SphereGeometry(0.292, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56));
    const hairCap = new THREE.Mesh(hairCapGeo, hairMat);
    hairCap.position.y = 0.03;
    hairCap.rotation.x = -0.18;
    headGroup.add(hairCap);

    // Stylized front hair quiff / curls
    const quiffGeo = track(new THREE.SphereGeometry(0.13, 10, 8));
    const quiff = new THREE.Mesh(quiffGeo, hairMat);
    quiff.scale.set(1.4, 0.72, 1.1);
    quiff.position.set(0, 0.24, 0.14);
    headGroup.add(quiff);
  }

  // Expressive Eyes
  const whiteMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const pupilMat = track(new THREE.MeshBasicMaterial({ color: 0x0f172a }));
  const eyeGeo = track(new THREE.SphereGeometry(0.056, 10, 8));
  const pupilGeo = track(new THREE.SphereGeometry(0.031, 8, 8));

  const leftEye = new THREE.Mesh(eyeGeo, whiteMat);
  leftEye.position.set(0.10, 0.035, 0.235);
  leftEye.scale.set(0.95, 1.15, 0.65);
  headGroup.add(leftEye);
  const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupil.position.set(0.10, 0.035, 0.265);
  headGroup.add(leftPupil);

  const rightEye = new THREE.Mesh(eyeGeo, whiteMat);
  rightEye.position.set(-0.10, 0.035, 0.235);
  rightEye.scale.set(0.95, 1.15, 0.65);
  headGroup.add(rightEye);
  const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
  rightPupil.position.set(-0.10, 0.035, 0.265);
  headGroup.add(rightPupil);

  // Expressive Eyebrows (animated by CharacterRig!)
  const browGeo = track(new THREE.BoxGeometry(0.11, 0.032, 0.03));
  const leftBrow = new THREE.Mesh(browGeo, hairMat);
  leftBrow.position.set(0.105, 0.12, 0.255);
  headGroup.add(leftBrow);

  const rightBrow = new THREE.Mesh(browGeo, hairMat);
  rightBrow.position.set(-0.105, 0.12, 0.255);
  headGroup.add(rightBrow);

  // Expressive Mouth
  const mouthGeo = track(new THREE.BoxGeometry(0.11, 0.036, 0.03));
  const mouthMat = track(new THREE.MeshBasicMaterial({ color: 0x3b1218 }));
  const mouthMesh = new THREE.Mesh(mouthGeo, mouthMat);
  mouthMesh.position.set(0, -0.095, 0.252);
  headGroup.add(mouthMesh);

  // Referee silver whistle near mouth
  let whistleProp: THREE.Group | null = null;
  if (player.role === 'referee' || player.team === 'ref') {
    whistleProp = new THREE.Group();
    const silverMat = track(
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.85, roughness: 0.2 })
    );
    const bodyGeo = track(new THREE.CylinderGeometry(0.036, 0.036, 0.06, 10));
    const whistleBody = new THREE.Mesh(bodyGeo, silverMat);
    whistleBody.rotation.z = Math.PI / 2;
    whistleProp.add(whistleBody);

    const tipGeo = track(new THREE.BoxGeometry(0.03, 0.032, 0.07));
    const tip = new THREE.Mesh(tipGeo, silverMat);
    tip.position.z = -0.04;
    whistleProp.add(tip);

    whistleProp.position.set(0, -0.10, 0.31);
    whistleProp.visible = false;
    headGroup.add(whistleProp);
  }

  // Arms helper
  const upperArmGeo = track(new THREE.CylinderGeometry(0.088, 0.078, 0.30, 10));
  const forearmGeo = track(new THREE.CylinderGeometry(0.072, 0.064, 0.28, 10));
  const handGeo = track(new THREE.SphereGeometry(0.08, 10, 8));
  const keeperGlovePalmGeo = track(new THREE.BoxGeometry(0.18, 0.22, 0.12));
  const keeperGloveThumbGeo = track(new THREE.BoxGeometry(0.08, 0.11, 0.08));
  const keeperGloveMat = track(
    new THREE.MeshStandardMaterial({
      color: player.team === 'red' ? 0xffffff : 0x00f5d4,
      emissive: player.team === 'red' ? 0x1a3305 : 0x052833,
      roughness: 0.35,
      metalness: 0.08,
    })
  );
  const keeperGloveTrimMat = track(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.primary),
      roughness: 0.4,
    })
  );

  const createArm = (
    xOffset: number,
    isLeft: boolean
  ): { armPivot: THREE.Group; forearmPivot: THREE.Group; handGroup: THREE.Group } => {
    const armPivot = new THREE.Group();
    armPivot.position.set(xOffset, 0.56, 0);
    torso.add(armPivot);

    const sleeve = new THREE.Mesh(upperArmGeo, primaryMat);
    sleeve.position.y = -0.14;
    sleeve.castShadow = true;
    armPivot.add(sleeve);

    const forearmPivot = new THREE.Group();
    forearmPivot.position.y = -0.28;
    armPivot.add(forearmPivot);

    const forearmMat = player.role === 'coach' || player.role === 'goalkeeper' ? primaryMat : skinMat;
    const forearm = new THREE.Mesh(forearmGeo, forearmMat);
    forearm.position.y = -0.13;
    forearm.castShadow = true;
    forearmPivot.add(forearm);

    const handGroup = new THREE.Group();
    handGroup.position.y = -0.28;
    forearmPivot.add(handGroup);

    if (player.role === 'goalkeeper') {
      // Oversized chunky padded 3D keeper gloves!
      const glove = new THREE.Mesh(keeperGlovePalmGeo, keeperGloveMat);
      glove.position.y = -0.05;
      glove.castShadow = true;
      handGroup.add(glove);

      const wrist = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.085, 0.085, 0.09, 10)),
        keeperGloveTrimMat
      );
      wrist.position.y = 0.06;
      handGroup.add(wrist);

      const thumb = new THREE.Mesh(keeperGloveThumbGeo, keeperGloveTrimMat);
      thumb.position.set(isLeft ? -0.10 : 0.10, -0.02, 0.04);
      thumb.rotation.z = isLeft ? 0.5 : -0.5;
      handGroup.add(thumb);
    } else {
      const hand = new THREE.Mesh(handGeo, skinMat);
      hand.castShadow = true;
      handGroup.add(hand);
    }

    return { armPivot, forearmPivot, handGroup };
  };

  const leftArm = createArm(0.39, true);
  const rightArm = createArm(-0.39, false);

  // Referee Yellow & Red Card props mounted in RIGHT hand
  let yellowCardProp: THREE.Mesh | null = null;
  let redCardProp: THREE.Mesh | null = null;
  if (player.role === 'referee' || player.team === 'ref') {
    const cardGeo = track(new THREE.BoxGeometry(0.18, 0.27, 0.02));
    const yellowCardMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xffe600,
        emissive: 0xffb700,
        emissiveIntensity: 0.75,
        roughness: 0.2,
      })
    );
    const redCardMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xff1744,
        emissive: 0xff0033,
        emissiveIntensity: 0.85,
        roughness: 0.2,
      })
    );

    yellowCardProp = new THREE.Mesh(cardGeo, yellowCardMat);
    yellowCardProp.position.set(0, -0.16, 0.04);
    yellowCardProp.visible = false;
    rightArm.handGroup.add(yellowCardProp);

    redCardProp = new THREE.Mesh(cardGeo, redCardMat);
    redCardProp.position.set(0, -0.16, 0.04);
    redCardProp.visible = false;
    rightArm.handGroup.add(redCardProp);
  }

  // Coach Clipboard prop mounted in LEFT hand
  let clipboardProp: THREE.Group | null = null;
  if (player.role === 'coach') {
    clipboardProp = new THREE.Group();
    const boardGeo = track(new THREE.BoxGeometry(0.26, 0.34, 0.025));
    const boardMat = track(new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.65 }));
    const board = new THREE.Mesh(boardGeo, boardMat);
    clipboardProp.add(board);

    const paperGeo = track(new THREE.BoxGeometry(0.21, 0.28, 0.01));
    const paperMat = track(new THREE.MeshBasicMaterial({ color: 0xf8fafc }));
    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.position.z = 0.016;
    clipboardProp.add(paper);

    const pitchDiagramGeo = track(new THREE.BoxGeometry(0.16, 0.18, 0.012));
    const pitchDiagramMat = track(new THREE.MeshBasicMaterial({ color: 0x16a34a }));
    const pitchDiagram = new THREE.Mesh(pitchDiagramGeo, pitchDiagramMat);
    pitchDiagram.position.set(0, 0.02, 0.02);
    clipboardProp.add(pitchDiagram);

    clipboardProp.position.set(0.05, -0.12, 0.10);
    clipboardProp.rotation.set(-0.4, 0.2, 0.15);
    leftArm.handGroup.add(clipboardProp);
  }

  // Overhead floating HUD Name Tag sprite
  const nameCanvas = document.createElement('canvas');
  nameCanvas.width = 512;
  nameCanvas.height = 128;
  drawNameTagCanvas(nameCanvas, player);
  const nameTagTexture = track(new THREE.CanvasTexture(nameCanvas));
  nameTagTexture.colorSpace = THREE.SRGBColorSpace;

  const nameTagMat = track(
    new THREE.SpriteMaterial({
      map: nameTagTexture,
      color: 0xd8d8d8,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
  );
  const nameTagSprite = new THREE.Sprite(nameTagMat);
  nameTagSprite.position.set(0, 2.55, 0);
  nameTagSprite.scale.set(2.4, 0.6, 1);
  nameTagSprite.renderOrder = 10;
  root.add(nameTagSprite);

  // Comic 3D Speech Bubble sprite (above name tag)
  const bubbleCanvas = document.createElement('canvas');
  bubbleCanvas.width = 640;
  bubbleCanvas.height = 160;
  const speechBubbleTexture = track(new THREE.CanvasTexture(bubbleCanvas));
  speechBubbleTexture.colorSpace = THREE.SRGBColorSpace;

  const bubbleMat = track(
    new THREE.SpriteMaterial({
      map: speechBubbleTexture,
      color: 0xd0d0d0,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
  );
  const speechBubbleSprite = new THREE.Sprite(bubbleMat);
  speechBubbleSprite.position.set(0, 3.35, 0);
  speechBubbleSprite.scale.set(3.4, 0.85, 1);
  speechBubbleSprite.visible = false;
  speechBubbleSprite.renderOrder = 15;
  root.add(speechBubbleSprite);

  return {
    root,
    bodyRoot,
    hips,
    torso,
    headGroup,
    leftBrow,
    rightBrow,
    mouthMesh,
    leftArmPivot: leftArm.armPivot,
    rightArmPivot: rightArm.armPivot,
    leftForearmPivot: leftArm.forearmPivot,
    rightForearmPivot: rightArm.forearmPivot,
    leftLegPivot: leftLeg.legPivot,
    rightLegPivot: rightLeg.legPivot,
    leftKneePivot: leftLeg.kneePivot,
    rightKneePivot: rightLeg.kneePivot,
    shadowDisc,
    controlRing,
    controlRingInner,
    yellowCardProp,
    redCardProp,
    whistleProp,
    clipboardProp,
    nameTagSprite,
    nameTagTexture,
    speechBubbleSprite,
    speechBubbleTexture,
    disposables,
  };
}
