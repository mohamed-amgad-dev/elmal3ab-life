import * as THREE from 'three';
import type { ICharacterSystem } from '../../types/engine';
import type { PlayerEntityState, RoleType, TeamId } from '../../types/game';
import {
  buildCharacterMesh,
  drawNameTagCanvas,
  drawSpeechBubbleCanvas,
  type CharacterVisualParts,
} from './CharacterMesh';
import { CharacterRig } from './CharacterRig';
import { GoalkeeperGlovesFP, type FPDiveState } from './GoalkeeperGlovesFP';

interface ManagedCharacter {
  id: string;
  parts: CharacterVisualParts;
  rig: CharacterRig;
  kitSignature: string;
  tagSignature: string;
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
  return `${player.name}|${player.team}|${player.role}|${player.yellowCards}|${player.isSentOff}|${player.isHumanControlled}`;
}

/**
 * Manages all stylized 3D characters, overhead HUD badges, comic Arabic speech
 * bubbles, procedural animations, human-control ground rings, and First-Person
 * goalkeeper gloves.
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

      // Apply any queued speech bubble for this player
      const pending = this.pendingBubbles.get(player.id);
      if (pending) {
        this.applyBubble(entry, pending.text, pending.duration);
        this.pendingBubbles.delete(player.id);
      }

      // Also honor speechBubble directly from PlayerEntityState
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
      const root = entry.parts.root;
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
        const canvas = entry.parts.nameTagTexture.image as HTMLCanvasElement;
        drawNameTagCanvas(canvas, player);
        entry.parts.nameTagTexture.needsUpdate = true;
        entry.tagSignature = tagSig;
      }

      // Active human-control glowing ground ring pulse
      const showRing = player.isHumanControlled && !player.isSentOff;
      entry.parts.controlRing.visible = showRing;
      entry.parts.controlRingInner.visible = showRing;
      if (showRing) {
        const pulse = 1 + Math.sin(elapsed * 6.5) * 0.09;
        entry.parts.controlRing.scale.set(pulse, pulse, 1);
        entry.parts.controlRing.rotation.z = elapsed * 1.4;
        const innerPulse = 1 + Math.cos(elapsed * 6.5) * 0.06;
        entry.parts.controlRingInner.scale.set(innerPulse, innerPulse, 1);
      }

      // Update procedural character animation
      entry.rig.update(
        entry.parts,
        player.animState,
        safeDt,
        elapsed,
        player.role === 'coach'
      );

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
    const parts = buildCharacterMesh(player);
    this.group.add(parts.root);

    const rig = new CharacterRig(this.nextSeed++);
    return {
      id: player.id,
      parts,
      rig,
      kitSignature: getKitSignature(player),
      tagSignature: getTagSignature(player),
      initialized: false,
      bubbleText: '',
      bubbleRemaining: 0,
      bubbleDuration: 2.6,
      lastStateBubbleText: '',
    };
  }

  private removeCharacter(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    this.group.remove(entry.parts.root);
    for (const d of entry.parts.disposables) {
      d.dispose();
    }
    this.characters.delete(id);
  }

  private applyBubble(entry: ManagedCharacter, text: string, duration: number): void {
    const canvas = entry.parts.speechBubbleTexture.image as HTMLCanvasElement;
    if (text !== entry.bubbleText) {
      drawSpeechBubbleCanvas(canvas, text);
      entry.parts.speechBubbleTexture.needsUpdate = true;
      entry.bubbleText = text;
    }
    entry.bubbleDuration = Math.max(0.5, duration);
    entry.bubbleRemaining = entry.bubbleDuration;
    entry.parts.speechBubbleSprite.visible = true;
  }

  private updateBubble(entry: ManagedCharacter, dt: number): void {
    const sprite = entry.parts.speechBubbleSprite;
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

    sprite.scale.set(3.4 * popScale, 0.85 * popScale, 1);
    sprite.position.y = 3.35 + Math.sin(elapsed * 4.5) * 0.06;
    sprite.material.opacity = opacity;
  }
}

export type { RoleType, TeamId };
