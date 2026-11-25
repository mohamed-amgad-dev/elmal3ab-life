import * as THREE from 'three';
import type { ICharacterSystem } from '../../types/engine';
import type { PlayerEntityState, RoleType, TeamId } from '../../types/game';
import { GoalkeeperGlovesFP, type FPDiveState } from './GoalkeeperGlovesFP';
import { HumanoidAnimator } from './HumanoidAnimator';
import {
  buildFallbackHumanoidPlaceholder,
  cloneHumanoidFromTemplate,
  getCachedHumanoidTemplate,
  onHumanoidModelReady,
  preloadHumanoidModel,
  type ClonedHumanoidInstance,
  type LoadedHumanoidTemplate,
} from './HumanoidModelLoader';

interface RoleVisualTheme {
  mainColor: number;
  jointsColor: number;
  emissiveColor: number;
  emissiveIntensity: number;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  gloveColor: number;
  gloveTrim: number;
}

interface AttachedProps {
  yellowCardProp: THREE.Mesh | null;
  redCardProp: THREE.Mesh | null;
  whistleProp: THREE.Group | null;
  clipboardProp: THREE.Group | null;
  propDisposables: Array<{ dispose: () => void }>;
}

interface ManagedCharacter {
  id: string;
  playerSnapshot: PlayerEntityState;
  seed: number;
  root: THREE.Group;
  visualMount: THREE.Group;
  shadowDisc: THREE.Mesh;
  controlRing: THREE.Mesh;
  controlRingInner: THREE.Mesh;
  controlRingMat: THREE.MeshBasicMaterial;
  controlRingInnerMat: THREE.MeshBasicMaterial;
  nameTagSprite: THREE.Sprite;
  nameTagTexture: THREE.CanvasTexture;
  speechBubbleSprite: THREE.Sprite;
  speechBubbleTexture: THREE.CanvasTexture;
  commonDisposables: Array<{ dispose: () => void }>;

  // Fallback placeholder (active briefly while GLB resolves)
  fallbackGroup: THREE.Group | null;
  fallbackDisposables: Array<{ dispose: () => void }>;
  unsubscribeReady: (() => void) | null;

  // Rigged GLB humanoid + animator (swapped in-place once loaded)
  humanoid: ClonedHumanoidInstance | null;
  animator: HumanoidAnimator | null;
  props: AttachedProps | null;

  kitSignature: string;
  tagSignature: string;
  ringStyleKey: string;
  initialized: boolean;

  // Speech bubble state
  bubbleText: string;
  bubbleRemaining: number;
  bubbleDuration: number;
  lastStateBubbleText: string;
}

function shortestAngleLerp(current: number, target: number, t: number): number {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

function getKitSignature(player: PlayerEntityState): string {
  return `${player.team}|${player.role}|${player.number}`;
}

function getTagSignature(player: PlayerEntityState): string {
  return `${player.name}|${player.number}|${player.team}|${player.role}|${player.yellowCards}|${player.isSentOff}|${player.isHumanControlled}|${Boolean(player.isRemoteHuman)}`;
}

function getRoleVisualTheme(team: TeamId | 'ref' | 'neutral', role: RoleType): RoleVisualTheme {
  if (role === 'referee' || team === 'ref') {
    return {
      mainColor: 0xfacc15,
      jointsColor: 0x111319,
      emissiveColor: 0xca8a04,
      emissiveIntensity: 0.14,
      badgeBg: '#111827',
      badgeBorder: '#facc15',
      badgeText: '#facc15',
      gloveColor: 0xffffff,
      gloveTrim: 0xfacc15,
    };
  }

  if (role === 'coach') {
    const isRed = team === 'red';
    return {
      mainColor: 0x1e293b,
      jointsColor: isRed ? 0xef4444 : 0x3b82f6,
      emissiveColor: isRed ? 0x7f1d1d : 0x1e3a8a,
      emissiveIntensity: 0.1,
      badgeBg: '#0f172a',
      badgeBorder: isRed ? '#ef4444' : '#3b82f6',
      badgeText: '#f8fafc',
      gloveColor: 0xffffff,
      gloveTrim: 0x1e293b,
    };
  }

  if (role === 'goalkeeper') {
    if (team === 'red') {
      return {
        mainColor: 0x84cc16,
        jointsColor: 0x13261a,
        emissiveColor: 0x4d7c0f,
        emissiveIntensity: 0.14,
        badgeBg: '#14261c',
        badgeBorder: '#a3e635',
        badgeText: '#ecfccb',
        gloveColor: 0xf8fafc,
        gloveTrim: 0x84cc16,
      };
    }
    return {
      mainColor: 0xf97316,
      jointsColor: 0x1b1528,
      emissiveColor: 0xc2410c,
      emissiveIntensity: 0.14,
      badgeBg: '#1b1528',
      badgeBorder: '#fb923c',
      badgeText: '#ffedd5',
      gloveColor: 0x22d3ee,
      gloveTrim: 0xf97316,
    };
  }

  if (team === 'red') {
    return {
      mainColor: 0xef4444,
      jointsColor: 0x1c141d,
      emissiveColor: 0x991b1b,
      emissiveIntensity: 0.11,
      badgeBg: '#7f1d1d',
      badgeBorder: '#ffd166',
      badgeText: '#ffffff',
      gloveColor: 0xffffff,
      gloveTrim: 0xef4444,
    };
  }

  if (team === 'blue') {
    return {
      mainColor: 0x3b82f6,
      jointsColor: 0x0f1f3d,
      emissiveColor: 0x1d4ed8,
      emissiveIntensity: 0.11,
      badgeBg: '#0f2557',
      badgeBorder: '#7dd3fc',
      badgeText: '#ffffff',
      gloveColor: 0xffffff,
      gloveTrim: 0x3b82f6,
    };
  }

  return {
    mainColor: 0x94a3b8,
    jointsColor: 0x1e293b,
    emissiveColor: 0x334155,
    emissiveIntensity: 0.08,
    badgeBg: '#1e293b',
    badgeBorder: '#cbd5e1',
    badgeText: '#ffffff',
    gloveColor: 0xffffff,
    gloveTrim: 0x94a3b8,
  };
}

/**
 * Draws the upgraded overhead player badge with jersey number, role emoji,
 * yellow/red card indicator, and clear local (`أنت ⭐`) vs remote (`صاحبك 🌐`) tag.
 */
function drawPlayerNameTagCanvas(
  canvas: HTMLCanvasElement,
  player: PlayerEntityState
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const isLocalHuman = Boolean(player.isHumanControlled && !player.isRemoteHuman);
  const isRemoteHuman = Boolean(player.isRemoteHuman);

  const teamAccent =
    player.role === 'referee' || player.team === 'ref'
      ? '#facc15'
      : player.team === 'red'
        ? '#ef4444'
        : player.team === 'blue'
          ? '#3b82f6'
          : '#94a3b8';

  const borderStroke = isRemoteHuman
    ? '#d946ef'
    : isLocalHuman
      ? '#ffd166'
      : teamAccent;

  // Top human indicator chip ("أنت ⭐" for local, "صاحبك 🌐" for remote peer)
  if (isLocalHuman || isRemoteHuman) {
    const tagText = isRemoteHuman ? 'صاحبك 🌐' : 'أنت ⭐';
    ctx.font = '900 26px Cairo, Tajawal, "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif';
    const chipW = Math.max(150, ctx.measureText(tagText).width + 38);
    const chipH = 42;
    const cx = (w - chipW) / 2;
    const cy = 6;

    ctx.save();
    ctx.fillStyle = isRemoteHuman ? 'rgba(134, 25, 143, 0.94)' : 'rgba(180, 83, 9, 0.94)';
    ctx.strokeStyle = isRemoteHuman ? '#f0abfc' : '#67e8f9';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.roundRect(cx, cy, chipW, chipH, 21);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tagText, w / 2, cy + chipH / 2 + 1);
    ctx.restore();
  }

  // Main player pill
  const roleIcon =
    player.role === 'goalkeeper'
      ? '🧤'
      : player.role === 'referee'
        ? '🏁'
        : player.role === 'coach'
          ? '📋'
          : '';

  const showNumber = player.role !== 'referee' && player.role !== 'coach' && player.number > 0;
  const shortName = player.name.length > 13 ? `${player.name.slice(0, 12)}…` : player.name;
  const numPart = showNumber ? `#${player.number} ` : '';
  const label = roleIcon ? `${numPart}${shortName} ${roleIcon}` : `${numPart}${shortName}`;

  ctx.font = '800 32px Cairo, Tajawal, "Segoe UI Emoji", system-ui, sans-serif';
  const textW = ctx.measureText(label).width;
  const cardExtra = player.isSentOff || player.yellowCards > 0 ? 42 : 0;
  const pillW = Math.min(w - 18, Math.max(185, textW + 64 + cardExtra));
  const pillH = 62;
  const px = (w - pillW) / 2;
  const py = isLocalHuman || isRemoteHuman ? 56 : (h - pillH) / 2;

  ctx.save();
  ctx.shadowColor = isRemoteHuman
    ? 'rgba(217, 70, 239, 0.85)'
    : isLocalHuman
      ? 'rgba(255, 209, 102, 0.8)'
      : 'rgba(0, 0, 0, 0.72)';
  ctx.shadowBlur = isLocalHuman || isRemoteHuman ? 14 : 8;

  ctx.fillStyle = isRemoteHuman
    ? 'rgba(30, 12, 44, 0.92)'
    : isLocalHuman
      ? 'rgba(12, 22, 44, 0.92)'
      : 'rgba(10, 14, 26, 0.82)';
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, 31);
  ctx.fill();
  ctx.restore();

  ctx.lineWidth = isLocalHuman || isRemoteHuman ? 4.5 : 3.2;
  ctx.strokeStyle = borderStroke;
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, 31);
  ctx.stroke();

  // Team color dot
  ctx.fillStyle = teamAccent;
  ctx.beginPath();
  ctx.arc(px + pillW - 22, py + pillH / 2, 8.5, 0, Math.PI * 2);
  ctx.fill();

  // Name & number text
  ctx.fillStyle = isRemoteHuman ? '#fdf4ff' : isLocalHuman ? '#fffbeb' : '#f8fafc';
  ctx.font = '800 30px Cairo, Tajawal, "Segoe UI Emoji", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textCenterX = px + (pillW - 14 + (cardExtra > 0 ? 18 : 0)) / 2;
  ctx.fillText(label, textCenterX, py + pillH / 2 + 1);

  // Yellow or Red card badge
  if (player.isSentOff || player.yellowCards > 0) {
    const cx = px + 20;
    const cy = py + 15;
    ctx.fillStyle = player.isSentOff ? '#ef4444' : '#facc15';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(cx, cy, 22, 32, 4);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Upgraded high-DPI comic speech bubble canvas built for crisp Arabic + emoji
 * Quick-Chat phrases (`1-8`) and comedy callouts over night stadium lighting.
 */
function drawUpgradedSpeechBubbleCanvas(
  canvas: HTMLCanvasElement,
  text: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const clean = text.trim();
  if (!clean) return;

  const display = clean.length > 30 ? `${clean.slice(0, 29)}…` : clean;
  const fontStack = 'Cairo, Tajawal, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif';

  // Auto-fit font size so long Arabic + emoji Quick-Chat phrases stay super crisp
  let fontSize = 40;
  ctx.font = `900 ${fontSize}px ${fontStack}`;
  let measured = ctx.measureText(display).width;
  while (measured > w - 108 && fontSize > 26) {
    fontSize -= 2;
    ctx.font = `900 ${fontSize}px ${fontStack}`;
    measured = ctx.measureText(display).width;
  }

  const bubbleW = Math.min(w - 28, Math.max(240, measured + 76));
  const bubbleH = 104;
  const bx = (w - bubbleW) / 2;
  const by = 18;

  // Drop shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
  ctx.beginPath();
  ctx.roundRect(bx + 6, by + 8, bubbleW, bubbleH, 28);
  ctx.fill();
  ctx.restore();

  // Rich dark-navy comic panel with vibrant cyan-gold border (below bloom blowout)
  const panelGrad = ctx.createLinearGradient(bx, by, bx, by + bubbleH);
  panelGrad.addColorStop(0, 'rgba(15, 23, 42, 0.96)');
  panelGrad.addColorStop(1, 'rgba(8, 13, 28, 0.96)');
  ctx.fillStyle = panelGrad;
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(bx, by, bubbleW, bubbleH, 28);
  ctx.fill();
  ctx.stroke();

  // Inner subtle highlight rim
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(bx + 7, by + 7, bubbleW - 14, bubbleH - 14, 21);
  ctx.stroke();

  // Speech pointer tail
  const tx = w / 2;
  const ty = by + bubbleH - 2;
  ctx.beginPath();
  ctx.moveTo(tx - 18, ty);
  ctx.lineTo(tx - 4, ty + 28);
  ctx.lineTo(tx + 16, ty);
  ctx.closePath();
  ctx.fillStyle = 'rgba(8, 13, 28, 0.97)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(tx - 18, ty);
  ctx.lineTo(tx - 4, ty + 28);
  ctx.lineTo(tx + 16, ty);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Cleanly mask top seam of pointer tail
  ctx.fillStyle = 'rgba(8, 13, 28, 0.99)';
  ctx.fillRect(tx - 17, ty - 6, 32, 10);

  // High-contrast Arabic + emoji text with subtle dark stroke for readability
  ctx.font = `900 ${fontSize}px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
  ctx.strokeText(display, w / 2, by + bubbleH / 2 + 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(display, w / 2, by + bubbleH / 2 + 2);
}

/**
 * Creates a crisp curved-style jersey back number patch mounted on `Spine2`.
 */
function createBackNumberBadgeTexture(
  player: PlayerEntityState,
  theme: RoleVisualTheme
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = theme.badgeBg;
    ctx.beginPath();
    ctx.roundRect(12, 12, 232, 232, 34);
    ctx.fill();

    ctx.strokeStyle = theme.badgeBorder;
    ctx.lineWidth = 12;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (player.role === 'referee' || player.team === 'ref') {
      ctx.fillStyle = theme.badgeText;
      ctx.font = '900 84px Cairo, Impact, sans-serif';
      ctx.fillText('REF', 128, 132);
    } else if (player.role === 'coach') {
      ctx.fillStyle = theme.badgeText;
      ctx.font = '900 66px Cairo, Tajawal, sans-serif';
      ctx.fillText('المدرب', 128, 132);
    } else {
      const numStr = String(player.number || 10);
      ctx.font = '900 144px Cairo, Impact, sans-serif';
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#020617';
      ctx.strokeText(numStr, 128, 136);
      ctx.fillStyle = theme.badgeText;
      ctx.fillText(numStr, 128, 136);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Manages all rigged 3D Mixamo humanoids (`player_humanoid.glb`), dynamic team/role
 * PBR styling & bone-attached props, overhead HUD badges (`أنت ⭐` / `صاحبك 🌐`),
 * glowing local & remote selection rings, upgraded Arabic + emoji speech bubbles,
 * and First-Person goalkeeper gloves.
 */
export class CharacterSystem implements ICharacterSystem {
  public readonly group: THREE.Group;

  private readonly characters = new Map<string, ManagedCharacter>();
  private readonly pendingBubbles = new Map<string, { text: string; duration: number }>();
  private readonly fpGloves: GoalkeeperGlovesFP;
  private nextSeed = 1;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'character_system';

    this.fpGloves = new GoalkeeperGlovesFP();
    this.group.add(this.fpGloves.root);

    // Kick off single cached GLB preload immediately so models resolve as fast as possible
    preloadHumanoidModel().catch(() => {
      // Fallback placeholders remain visible cleanly if offline/missing
    });
  }

  public syncPlayers(players: PlayerEntityState[], dt: number, elapsed: number): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    const activeIds = new Set<string>();

    for (const player of players) {
      activeIds.add(player.id);
      let entry = this.characters.get(player.id);
      const kitSig = getKitSignature(player);

      if (!entry || entry.kitSignature !== kitSig) {
        if (entry) {
          this.removeCharacter(player.id);
        }
        entry = this.createCharacter(player);
        this.characters.set(player.id, entry);
      }

      entry.playerSnapshot = player;

      // Apply any queued speech bubble for this player
      const pending = this.pendingBubbles.get(player.id);
      if (pending) {
        this.applyBubble(entry, pending.text, pending.duration);
        this.pendingBubbles.delete(player.id);
      }

      // Honor speechBubble directly from PlayerEntityState
      if (player.speechBubble && player.speechBubble.trim().length > 0) {
        if (
          player.speechBubble !== entry.lastStateBubbleText ||
          (player.speechTimer !== undefined && player.speechTimer > 0 && entry.bubbleRemaining <= 0)
        ) {
          const dur = player.speechTimer && player.speechTimer > 0 ? player.speechTimer : 2.6;
          this.applyBubble(entry, player.speechBubble, dur);
        }
        entry.lastStateBubbleText = player.speechBubble;
      } else {
        entry.lastStateBubbleText = '';
      }

      // Position & rotation synchronization (snap on first frame, teleport, or paused/VAR scrub)
      const root = entry.root;
      const dx = player.pos.x - root.position.x;
      const dy = player.pos.y - root.position.y;
      const dz = player.pos.z - root.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (!entry.initialized || distSq > 20 || safeDt <= 0.0001) {
        root.position.set(player.pos.x, player.pos.y, player.pos.z);
        root.rotation.y = player.rotY;
        entry.initialized = true;
      } else {
        const posAlpha = 1 - Math.exp(-24 * safeDt);
        const rotAlpha = 1 - Math.exp(-18 * safeDt);
        root.position.x += dx * posAlpha;
        root.position.y += dy * posAlpha;
        root.position.z += dz * posAlpha;
        root.rotation.y = shortestAngleLerp(root.rotation.y, player.rotY, rotAlpha);
      }

      // Overhead HUD badge dirty-check redraw
      const tagSig = getTagSignature(player);
      if (tagSig !== entry.tagSignature) {
        const canvas = entry.nameTagTexture.image as HTMLCanvasElement;
        drawPlayerNameTagCanvas(canvas, player);
        entry.nameTagTexture.needsUpdate = true;
        entry.tagSignature = tagSig;
      }

      // Ground selection rings: Local human (Gold/Cyan) vs Remote online human (Purple/Magenta #d946ef)
      const isLocalHuman = Boolean(player.isHumanControlled && !player.isRemoteHuman);
      const isRemoteHuman = Boolean(player.isRemoteHuman);
      const showRing = (isLocalHuman || isRemoteHuman) && !player.isSentOff;

      entry.controlRing.visible = showRing;
      entry.controlRingInner.visible = showRing;

      if (showRing) {
        const desiredRingKey = isRemoteHuman ? 'remote' : 'local';
        if (entry.ringStyleKey !== desiredRingKey) {
          if (isRemoteHuman) {
            entry.controlRingMat.color.setHex(0xd946ef); // Purple/Magenta
            entry.controlRingInnerMat.color.setHex(0xf0abfc);
          } else {
            entry.controlRingMat.color.setHex(0xffd166); // Gold outer
            entry.controlRingInnerMat.color.setHex(0x22d3ee); // Cyan inner
          }
          entry.ringStyleKey = desiredRingKey;
        }

        const pulse = 1 + Math.sin(elapsed * 6.5) * 0.09;
        entry.controlRing.scale.set(pulse, pulse, 1);
        entry.controlRing.rotation.z = elapsed * (isRemoteHuman ? -1.5 : 1.4);
        const innerPulse = 1 + Math.cos(elapsed * 6.5) * 0.06;
        entry.controlRingInner.scale.set(innerPulse, innerPulse, 1);
      }

      // Step rigged GLB humanoid animation (or subtle idle bob on temporary fallback)
      if (entry.animator) {
        const out = entry.animator.update(
          player.animState,
          safeDt,
          elapsed,
          player.role === 'coach'
        );

        if (entry.props) {
          if (entry.props.yellowCardProp) {
            entry.props.yellowCardProp.visible = out.showYellowCard;
            if (out.showYellowCard) {
              const s = 1 + Math.sin(elapsed * 14) * 0.08;
              entry.props.yellowCardProp.scale.set(s, s, 1);
            }
          }
          if (entry.props.redCardProp) {
            entry.props.redCardProp.visible = out.showRedCard;
            if (out.showRedCard) {
              const s = 1.06 + Math.sin(elapsed * 18) * 0.1;
              entry.props.redCardProp.scale.set(s, s, 1);
            }
          }
          if (entry.props.whistleProp) {
            entry.props.whistleProp.visible = out.showWhistle;
          }
        }

        const shadowScale = Math.max(0.45, 1 - out.airHeight * 0.42);
        entry.shadowDisc.scale.set(shadowScale, shadowScale, 1);
      } else if (entry.fallbackGroup) {
        entry.fallbackGroup.position.y = Math.abs(Math.sin(elapsed * 5 + entry.seed)) * 0.04;
      }

      // Update floating comic speech bubble lifecycle & pop spring
      this.updateBubble(entry, safeDt);
    }

    // Remove characters no longer in state
    for (const existingId of this.characters.keys()) {
      if (!activeIds.has(existingId)) {
        this.removeCharacter(existingId);
      }
    }
  }

  public updateFPGloves(
    camera: THREE.Camera,
    active: boolean,
    diveState: FPDiveState,
    dt: number
  ): void {
    this.fpGloves.update(camera, active, diveState, dt);
  }

  public triggerSpeechBubble(playerId: string, text: string, duration = 2.6): void {
    const clean = text.trim();
    if (!clean) return;

    const entry = this.characters.get(playerId);
    if (!entry) {
      this.pendingBubbles.set(playerId, { text: clean, duration });
      return;
    }
    this.applyBubble(entry, clean, duration);
  }

  public dispose(): void {
    for (const id of Array.from(this.characters.keys())) {
      this.removeCharacter(id);
    }
    this.pendingBubbles.clear();
    this.fpGloves.dispose();
    this.group.remove(this.fpGloves.root);
  }

  private createCharacter(player: PlayerEntityState): ManagedCharacter {
    const commonDisposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(item: T): T => {
      commonDisposables.push(item);
      return item;
    };

    const seed = this.nextSeed++;
    const root = new THREE.Group();
    root.name = `char_${player.id}`;
    this.group.add(root);

    // Ground contact shadow disc
    const shadowGeo = track(new THREE.CircleGeometry(0.56, 20));
    const shadowMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x04070f,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      })
    );
    const shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = 0.025;
    root.add(shadowDisc);

    // Selection rings (Gold/Cyan for Local Human, Purple/Magenta for Remote Human)
    const isRemote = Boolean(player.isRemoteHuman);
    const ringGeo = track(new THREE.RingGeometry(0.72, 0.98, 36));
    const controlRingMat = track(
      new THREE.MeshBasicMaterial({
        color: isRemote ? 0xd946ef : 0xffd166,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      })
    );
    const controlRing = new THREE.Mesh(ringGeo, controlRingMat);
    controlRing.rotation.x = -Math.PI / 2;
    controlRing.position.y = 0.04;
    controlRing.visible = Boolean((player.isHumanControlled || isRemote) && !player.isSentOff);
    root.add(controlRing);

    const innerRingGeo = track(new THREE.RingGeometry(0.56, 0.66, 32));
    const controlRingInnerMat = track(
      new THREE.MeshBasicMaterial({
        color: isRemote ? 0xf0abfc : 0x22d3ee,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      })
    );
    const controlRingInner = new THREE.Mesh(innerRingGeo, controlRingInnerMat);
    controlRingInner.rotation.x = -Math.PI / 2;
    controlRingInner.position.y = 0.045;
    controlRingInner.visible = controlRing.visible;
    root.add(controlRingInner);

    // Mount group where fallback or rigged GLB humanoid attaches
    const visualMount = new THREE.Group();
    visualMount.name = 'visual_mount';
    root.add(visualMount);

    // Overhead HUD Name Tag + Human indicator sprite
    const nameCanvas = document.createElement('canvas');
    nameCanvas.width = 512;
    nameCanvas.height = 144;
    drawPlayerNameTagCanvas(nameCanvas, player);
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
    nameTagSprite.position.set(0, 2.38, 0);
    nameTagSprite.scale.set(2.45, 0.69, 1);
    nameTagSprite.renderOrder = 10;
    root.add(nameTagSprite);

    // Upgraded Comic / Quick-Chat Arabic + Emoji 3D Speech Bubble sprite
    const bubbleCanvas = document.createElement('canvas');
    bubbleCanvas.width = 768;
    bubbleCanvas.height = 200;
    const speechBubbleTexture = track(new THREE.CanvasTexture(bubbleCanvas));
    speechBubbleTexture.colorSpace = THREE.SRGBColorSpace;

    const bubbleMat = track(
      new THREE.SpriteMaterial({
        map: speechBubbleTexture,
        color: 0xd2d2d2,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    );
    const speechBubbleSprite = new THREE.Sprite(bubbleMat);
    speechBubbleSprite.position.set(0, 3.25, 0);
    speechBubbleSprite.scale.set(3.6, 0.94, 1);
    speechBubbleSprite.visible = false;
    speechBubbleSprite.renderOrder = 15;
    root.add(speechBubbleSprite);

    const entry: ManagedCharacter = {
      id: player.id,
      playerSnapshot: player,
      seed,
      root,
      visualMount,
      shadowDisc,
      controlRing,
      controlRingInner,
      controlRingMat,
      controlRingInnerMat,
      nameTagSprite,
      nameTagTexture,
      speechBubbleSprite,
      speechBubbleTexture,
      commonDisposables,
      fallbackGroup: null,
      fallbackDisposables: [],
      unsubscribeReady: null,
      humanoid: null,
      animator: null,
      props: null,
      kitSignature: getKitSignature(player),
      tagSignature: getTagSignature(player),
      ringStyleKey: isRemote ? 'remote' : 'local',
      initialized: false,
      bubbleText: '',
      bubbleRemaining: 0,
      bubbleDuration: 2.6,
      lastStateBubbleText: '',
    };

    const cached = getCachedHumanoidTemplate();
    if (cached) {
      this.attachRiggedHumanoid(entry, cached);
    } else {
      // Mount lightweight temporary silhouette while async GLB streams in (~100ms)
      const theme = getRoleVisualTheme(player.team, player.role);
      const fallback = buildFallbackHumanoidPlaceholder(theme.mainColor, theme.jointsColor);
      entry.fallbackGroup = fallback.group;
      entry.fallbackDisposables = fallback.disposables;
      entry.visualMount.add(fallback.group);

      entry.unsubscribeReady = onHumanoidModelReady((template) => {
        // Ensure character still exists in map before swapping in-place
        if (this.characters.get(entry.id) !== entry) return;
        this.attachRiggedHumanoid(entry, template);
      });
    }

    return entry;
  }

  private attachRiggedHumanoid(
    entry: ManagedCharacter,
    template: LoadedHumanoidTemplate
  ): void {
    // Cleanly remove & dispose temporary fallback if present
    if (entry.fallbackGroup) {
      entry.visualMount.remove(entry.fallbackGroup);
      for (const d of entry.fallbackDisposables) {
        d.dispose();
      }
      entry.fallbackGroup = null;
      entry.fallbackDisposables = [];
    }
    entry.unsubscribeReady = null;

    const humanoid = cloneHumanoidFromTemplate(template);
    const theme = getRoleVisualTheme(entry.playerSnapshot.team, entry.playerSnapshot.role);

    // Style cloned materials dynamically (`Beta_Joints_MAT`, `asdf1:Beta_HighLimbsGeoSG2`)
    this.styleHumanoidMaterials(humanoid, theme);

    // Attach role props & crisp back jersey number patch onto Mixamo bones
    const props = this.attachBoneProps(humanoid, entry.playerSnapshot, theme);

    entry.visualMount.add(humanoid.root);
    entry.humanoid = humanoid;
    entry.props = props;
    entry.animator = new HumanoidAnimator(humanoid, entry.seed);
  }

  private styleHumanoidMaterials(
    humanoid: ClonedHumanoidInstance,
    theme: RoleVisualTheme
  ): void {
    const applyStyle = (mat: THREE.Material, fallbackIndex: number): void => {
      if (!(mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial)) {
        return;
      }

      const lower = (mat.name || '').toLowerCase();
      const isJoints =
        lower.includes('joints') ||
        lower.includes('beta_joints') ||
        (!lower.includes('highlimbs') && !lower.includes('limbs') && fallbackIndex === 0);

      if (isJoints) {
        mat.color.setHex(theme.jointsColor);
        mat.roughness = 0.56;
        mat.metalness = 0.22;
        mat.emissive.setHex(theme.jointsColor);
        mat.emissiveIntensity = 0.04;
      } else {
        // Main armor / kit shell (`asdf1:Beta_HighLimbsGeoSG2`)
        mat.color.setHex(theme.mainColor);
        mat.roughness = 0.42;
        mat.metalness = 0.14;
        mat.emissive.setHex(theme.emissiveColor);
        mat.emissiveIntensity = theme.emissiveIntensity;
      }
      mat.needsUpdate = true;
    };

    humanoid.skinnedMeshes.forEach((mesh, idx) => {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m, mi) => applyStyle(m, idx + mi));
      } else if (mesh.material) {
        applyStyle(mesh.material, idx);
      }
    });
  }

  private attachBoneProps(
    humanoid: ClonedHumanoidInstance,
    player: PlayerEntityState,
    theme: RoleVisualTheme
  ): AttachedProps {
    const propDisposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(item: T): T => {
      propDisposables.push(item);
      return item;
    };

    const s = humanoid.bonePropScale;
    const makeMount = (boneKey: string): THREE.Group | null => {
      const bone = humanoid.bones.get(boneKey);
      if (!bone) return null;
      const mount = new THREE.Group();
      mount.scale.setScalar(s);
      bone.add(mount);
      return mount;
    };

    // 1. Crisp back jersey number / role badge mounted on upper back (`Spine2`)
    const spineMount = makeMount('Spine2') ?? makeMount('Spine1');
    if (spineMount) {
      const badgeTex = track(createBackNumberBadgeTexture(player, theme));
      const badgeGeo = track(new THREE.PlaneGeometry(0.27, 0.27));
      const badgeMat = track(
        new THREE.MeshStandardMaterial({
          map: badgeTex,
          roughness: 0.45,
          metalness: 0.05,
        })
      );
      const badgeMesh = new THREE.Mesh(badgeGeo, badgeMat);
      // Positioned cleanly on the back (-Z) of the chest shell facing backward
      badgeMesh.position.set(0, 0.05, -0.155);
      badgeMesh.rotation.y = Math.PI;
      spineMount.add(badgeMesh);
    }

    // 2. Oversized padded Goalkeeper Gloves mounted on `LeftHand` & `RightHand` bones
    if (player.role === 'goalkeeper') {
      const palmGeo = track(new THREE.BoxGeometry(0.18, 0.12, 0.18));
      const wristGeo = track(new THREE.CylinderGeometry(0.065, 0.072, 0.09, 10));
      const thumbGeo = track(new THREE.BoxGeometry(0.09, 0.07, 0.08));

      const gloveMat = track(
        new THREE.MeshStandardMaterial({
          color: theme.gloveColor,
          emissive: theme.gloveColor,
          emissiveIntensity: 0.14,
          roughness: 0.34,
          metalness: 0.08,
        })
      );
      const trimMat = track(
        new THREE.MeshStandardMaterial({
          color: theme.gloveTrim,
          roughness: 0.4,
          metalness: 0.1,
        })
      );

      const attachGlove = (boneKey: string, signX: number) => {
        const handMount = makeMount(boneKey);
        if (!handMount) return;

        const palm = new THREE.Mesh(palmGeo, gloveMat);
        palm.position.set(signX * 0.1, 0, 0.01);
        palm.castShadow = true;
        handMount.add(palm);

        const wrist = new THREE.Mesh(wristGeo, trimMat);
        wrist.rotation.z = Math.PI / 2;
        wrist.position.set(signX * 0.01, 0, 0);
        handMount.add(wrist);

        const thumb = new THREE.Mesh(thumbGeo, trimMat);
        thumb.position.set(signX * 0.09, 0.02, 0.1);
        handMount.add(thumb);
      };

      attachGlove('LeftHand', 1);
      attachGlove('RightHand', -1);
    }

    // 3. Referee Whistle (on `Head`) + Glowing Yellow & Red Cards (on `RightHand`)
    let yellowCardProp: THREE.Mesh | null = null;
    let redCardProp: THREE.Mesh | null = null;
    let whistleProp: THREE.Group | null = null;

    if (player.role === 'referee' || player.team === 'ref') {
      const headMount = makeMount('Head');
      if (headMount) {
        whistleProp = new THREE.Group();
        const silverMat = track(
          new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            metalness: 0.88,
            roughness: 0.18,
          })
        );
        const bodyGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.055, 10));
        const body = new THREE.Mesh(bodyGeo, silverMat);
        body.rotation.z = Math.PI / 2;
        whistleProp.add(body);

        const tipGeo = track(new THREE.BoxGeometry(0.026, 0.028, 0.065));
        const tip = new THREE.Mesh(tipGeo, silverMat);
        tip.position.z = -0.036;
        whistleProp.add(tip);

        whistleProp.position.set(0, 0.03, 0.16);
        whistleProp.visible = false;
        headMount.add(whistleProp);
      }

      const rightHandMount = makeMount('RightHand');
      if (rightHandMount) {
        const cardGeo = track(new THREE.BoxGeometry(0.24, 0.17, 0.018));
        const yellowMat = track(
          new THREE.MeshStandardMaterial({
            color: 0xfacc15,
            emissive: 0xeab308,
            emissiveIntensity: 1.15,
            roughness: 0.18,
          })
        );
        const redMat = track(
          new THREE.MeshStandardMaterial({
            color: 0xff1744,
            emissive: 0xff0033,
            emissiveIntensity: 1.25,
            roughness: 0.18,
          })
        );

        // Mounted extending beyond RightHand (-X along finger axis so raising arm skyward holds card upright!)
        yellowCardProp = new THREE.Mesh(cardGeo, yellowMat);
        yellowCardProp.position.set(-0.18, 0, 0.03);
        yellowCardProp.visible = false;
        rightHandMount.add(yellowCardProp);

        redCardProp = new THREE.Mesh(cardGeo, redMat);
        redCardProp.position.set(-0.18, 0, 0.03);
        redCardProp.visible = false;
        rightHandMount.add(redCardProp);
      }
    }

    // 4. Coach Tactical Clipboard prop mounted on `LeftHand`
    let clipboardProp: THREE.Group | null = null;
    if (player.role === 'coach') {
      const leftHandMount = makeMount('LeftHand');
      if (leftHandMount) {
        clipboardProp = new THREE.Group();
        const boardGeo = track(new THREE.BoxGeometry(0.26, 0.34, 0.024));
        const boardMat = track(
          new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.65 })
        );
        const board = new THREE.Mesh(boardGeo, boardMat);
        clipboardProp.add(board);

        const paperGeo = track(new THREE.BoxGeometry(0.21, 0.28, 0.01));
        const paperMat = track(new THREE.MeshBasicMaterial({ color: 0xf8fafc }));
        const paper = new THREE.Mesh(paperGeo, paperMat);
        paper.position.z = 0.015;
        clipboardProp.add(paper);

        const pitchGeo = track(new THREE.BoxGeometry(0.16, 0.18, 0.012));
        const pitchMat = track(new THREE.MeshBasicMaterial({ color: 0x16a34a }));
        const pitchDiagram = new THREE.Mesh(pitchGeo, pitchMat);
        pitchDiagram.position.set(0, 0.02, 0.02);
        clipboardProp.add(pitchDiagram);

        clipboardProp.position.set(0.14, 0.04, 0.06);
        clipboardProp.rotation.set(-0.45, 0.35, -0.4);
        leftHandMount.add(clipboardProp);
      }
    }

    return {
      yellowCardProp,
      redCardProp,
      whistleProp,
      clipboardProp,
      propDisposables,
    };
  }

  private removeCharacter(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    if (entry.unsubscribeReady) {
      entry.unsubscribeReady();
      entry.unsubscribeReady = null;
    }

    if (entry.animator) {
      entry.animator.dispose();
      entry.animator = null;
    }

    if (entry.props) {
      for (const d of entry.props.propDisposables) {
        d.dispose();
      }
      entry.props = null;
    }

    if (entry.humanoid) {
      for (const m of entry.humanoid.materialDisposables) {
        m.dispose();
      }
      entry.humanoid = null;
    }

    for (const d of entry.fallbackDisposables) {
      d.dispose();
    }
    entry.fallbackDisposables = [];

    for (const d of entry.commonDisposables) {
      d.dispose();
    }
    entry.commonDisposables = [];

    this.group.remove(entry.root);
    this.characters.delete(id);
  }

  private applyBubble(entry: ManagedCharacter, text: string, duration: number): void {
    const canvas = entry.speechBubbleTexture.image as HTMLCanvasElement;
    if (text !== entry.bubbleText) {
      drawUpgradedSpeechBubbleCanvas(canvas, text);
      entry.speechBubbleTexture.needsUpdate = true;
      entry.bubbleText = text;
    }
    entry.bubbleDuration = Math.max(0.5, duration);
    entry.bubbleRemaining = entry.bubbleDuration;
    entry.speechBubbleSprite.visible = true;
  }

  private updateBubble(entry: ManagedCharacter, dt: number): void {
    const sprite = entry.speechBubbleSprite;
    if (entry.bubbleRemaining <= 0) {
      sprite.visible = false;
      return;
    }

    entry.bubbleRemaining = Math.max(0, entry.bubbleRemaining - dt);
    if (entry.bubbleRemaining <= 0) {
      sprite.visible = false;
      return;
    }

    sprite.visible = true;
    const elapsed = entry.bubbleDuration - entry.bubbleRemaining;

    // Pop-in spring over first 0.2s, fade out over final 0.35s
    let popScale = 1;
    if (elapsed < 0.2) {
      const u = elapsed / 0.2;
      popScale = 0.2 + 0.8 * (1 + Math.sin(u * Math.PI) * 0.22);
    }

    let opacity = 1;
    if (entry.bubbleRemaining < 0.35) {
      opacity = Math.max(0, entry.bubbleRemaining / 0.35);
    }

    sprite.scale.set(3.6 * popScale, 0.94 * popScale, 1);
    sprite.position.y = 3.25 + Math.sin(elapsed * 4.5) * 0.06;
    sprite.material.opacity = opacity;
  }
}

export type { RoleType, TeamId };
