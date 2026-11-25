import * as THREE from 'three';
import type { JumbotronUpdateState } from '../../types/engine';
import type { TeamId } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

const JUMBOTRON_W = 15.6;
const JUMBOTRON_H = 7.4;
const JUMBOTRON_Y = 17.5;
const JUMBOTRON_Z = 43.0;

/**
 * Twin suspended 3D LED Jumbotron scoreboards mounted above the North and South stands
 * (`Z = ±43, Y = 17.5`, facing the pitch). Renders a crisp `CanvasTexture` broadcast
 * scoreboard with dirty-checking so the canvas only redraws when score, whole-second
 * clock, headline, or VAR status changes.
 */
export class StadiumJumbotron {
  public readonly group: THREE.Group;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly screenTexture: THREE.CanvasTexture;
  private readonly frameMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly accentMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  // Cached render state for strict dirty-check redraws
  private redScore = 0;
  private blueScore = 0;
  private clockWholeSec = 0;
  private customHeadline: string | null = null;
  private varActive = false;
  private goalFlashTeam: TeamId | null = null;
  private goalFlashRemaining = 0;
  private lastDrawSignature = '';

  private readonly baseFrameColor = new THREE.Color(0x00e5ff);
  private readonly redGlowColor = new THREE.Color(0xef4444);
  private readonly blueGlowColor = new THREE.Color(0x3b82f6);
  private readonly goldGlowColor = new THREE.Color(0xffd426);
  private readonly varGlowColor = new THREE.Color(0xf43f5e);
  private readonly tempColor = new THREE.Color();

  constructor(config: StadiumConfig) {
    this.group = new THREE.Group();
    this.group.name = 'StadiumJumbotrons';

    this.redGlowColor.setHex(config.colors.redTeam);
    this.blueGlowColor.setHex(config.colors.blueTeam);

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 512;
    this.ctx = this.canvas.getContext('2d');

    this.screenTexture = new THREE.CanvasTexture(this.canvas);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    this.screenTexture.anisotropy = 4;

    this.buildJumbotronUnit(-JUMBOTRON_Z, 0, 'NorthJumbotron');
    this.buildJumbotronUnit(JUMBOTRON_Z, Math.PI, 'SouthJumbotron');

    // Initial broadcast frame
    this.redrawIfDirty(true);
  }

  private buildJumbotronUnit(zPos: number, rotY: number, name: string): void {
    const unit = new THREE.Group();
    unit.name = name;
    unit.position.set(0, JUMBOTRON_Y, zPos);
    unit.rotation.y = rotY;

    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.42,
      metalness: 0.78,
    });
    const trussMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.48,
      metalness: 0.72,
    });
    const frameNeonMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: this.baseFrameColor.clone(),
      emissiveIntensity: 1.9,
      roughness: 0.2,
      metalness: 0.2,
    });
    const accentNeonMat = new THREE.MeshStandardMaterial({
      color: 0xffd426,
      emissive: this.goldGlowColor.clone(),
      emissiveIntensity: 1.4,
      roughness: 0.25,
      metalness: 0.3,
    });
    // Slightly muted base color (~0xd6d6d6) keeps bright text crisp under UnrealBloomPass
    const screenMat = new THREE.MeshBasicMaterial({
      map: this.screenTexture,
      color: 0xd8d8d8,
    });

    this.materials.push(steelMat, trussMat, frameNeonMat, accentNeonMat, screenMat);
    this.frameMaterials.push(frameNeonMat);
    this.accentMaterials.push(accentNeonMat);

    // Main rear electronics cabinet housing
    const cabinetGeo = new THREE.BoxGeometry(JUMBOTRON_W + 0.9, JUMBOTRON_H + 0.9, 1.35);
    const cabinet = new THREE.Mesh(cabinetGeo, steelMat);
    cabinet.position.z = -0.72;
    unit.add(cabinet);
    this.geometries.push(cabinetGeo);

    // Front glowing LED screen plane facing pitch (+Z in local space)
    const screenGeo = new THREE.PlaneGeometry(JUMBOTRON_W, JUMBOTRON_H);
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.z = 0.02;
    unit.add(screen);
    this.geometries.push(screenGeo);

    // Glowing neon bezel bars (top, bottom, left, right)
    const bezelThick = 0.26;
    const horizBezelGeo = new THREE.BoxGeometry(JUMBOTRON_W + bezelThick * 2, bezelThick, 0.32);
    const vertBezelGeo = new THREE.BoxGeometry(bezelThick, JUMBOTRON_H + bezelThick * 2, 0.32);
    this.geometries.push(horizBezelGeo, vertBezelGeo);

    const topBezel = new THREE.Mesh(horizBezelGeo, frameNeonMat);
    topBezel.position.set(0, JUMBOTRON_H / 2 + bezelThick / 2, 0.06);
    unit.add(topBezel);

    const bottomBezel = new THREE.Mesh(horizBezelGeo, frameNeonMat);
    bottomBezel.position.set(0, -(JUMBOTRON_H / 2 + bezelThick / 2), 0.06);
    unit.add(bottomBezel);

    const leftBezel = new THREE.Mesh(vertBezelGeo, frameNeonMat);
    leftBezel.position.set(-(JUMBOTRON_W / 2 + bezelThick / 2), 0, 0.06);
    unit.add(leftBezel);

    const rightBezel = new THREE.Mesh(vertBezelGeo, frameNeonMat);
    rightBezel.position.set(JUMBOTRON_W / 2 + bezelThick / 2, 0, 0.06);
    unit.add(rightBezel);

    // Upper branding crown bar
    const crownGeo = new THREE.BoxGeometry(7.2, 0.48, 0.45);
    const crown = new THREE.Mesh(crownGeo, steelMat);
    crown.position.set(0, JUMBOTRON_H / 2 + 0.56, -0.15);
    unit.add(crown);

    const crownStripGeo = new THREE.BoxGeometry(6.6, 0.14, 0.16);
    const crownStrip = new THREE.Mesh(crownStripGeo, accentNeonMat);
    crownStrip.position.set(0, JUMBOTRON_H / 2 + 0.56, 0.12);
    unit.add(crownStrip);
    this.geometries.push(crownGeo, crownStripGeo);

    // Heavy architectural steel truss girders suspending the board above the stand canopy
    const columnGeo = new THREE.CylinderGeometry(0.24, 0.28, 7.6, 8);
    const crossBeamGeo = new THREE.BoxGeometry(JUMBOTRON_W + 2.4, 0.36, 0.42);
    const diagStrutGeo = new THREE.CylinderGeometry(0.11, 0.11, 5.2, 6);
    this.geometries.push(columnGeo, crossBeamGeo, diagStrutGeo);

    const supportXs = [-JUMBOTRON_W * 0.36, JUMBOTRON_W * 0.36];
    for (const sx of supportXs) {
      // Twin vertical steel pylons descending into rear stand structure
      const pylon = new THREE.Mesh(columnGeo, trussMat);
      pylon.position.set(sx, -JUMBOTRON_H / 2 - 3.6, -1.05);
      unit.add(pylon);

      // Upper suspension tie-back strut
      const topStrut = new THREE.Mesh(diagStrutGeo, trussMat);
      topStrut.position.set(sx, JUMBOTRON_H / 2 + 1.8, -1.55);
      topStrut.rotation.x = 0.48;
      unit.add(topStrut);
    }

    // Horizontal rear truss crossbar
    const rearBeamTop = new THREE.Mesh(crossBeamGeo, trussMat);
    rearBeamTop.position.set(0, JUMBOTRON_H / 2 + 0.22, -1.35);
    unit.add(rearBeamTop);

    const rearBeamBot = new THREE.Mesh(crossBeamGeo, trussMat);
    rearBeamBot.position.set(0, -JUMBOTRON_H / 2 - 0.22, -1.35);
    unit.add(rearBeamBot);

    this.group.add(unit);
  }

  public updateState(state: JumbotronUpdateState): void {
    this.redScore = Math.max(0, Math.floor(state.redScore));
    this.blueScore = Math.max(0, Math.floor(state.blueScore));
    this.clockWholeSec = Math.max(0, Math.floor(state.clockSec));
    if (state.headline !== undefined) {
      this.customHeadline = state.headline;
    }
    if (state.varActive !== undefined) {
      this.varActive = state.varActive;
    }
    this.redrawIfDirty(false);
  }

  public triggerGoalFlash(scoringTeam: TeamId): void {
    this.goalFlashTeam = scoringTeam;
    this.goalFlashRemaining = 4.4;
    this.redrawIfDirty(false);
  }

  public setVARActive(active: boolean): void {
    if (this.varActive === active) return;
    this.varActive = active;
    this.redrawIfDirty(false);
  }

  public update(dt: number, elapsed: number): void {
    if (this.goalFlashRemaining > 0) {
      this.goalFlashRemaining = Math.max(0, this.goalFlashRemaining - dt);
      if (this.goalFlashRemaining === 0) {
        this.goalFlashTeam = null;
        this.redrawIfDirty(false);
      }
    }

    // Subtle neon bezel pulse (zero canvas redraw per frame!)
    if (this.goalFlashTeam && this.goalFlashRemaining > 0) {
      const strobe = 0.5 + 0.5 * Math.sin(elapsed * 14);
      const teamCol = this.goalFlashTeam === 'red' ? this.redGlowColor : this.blueGlowColor;
      this.tempColor.copy(teamCol).lerp(this.goldGlowColor, strobe * 0.55);
      for (const mat of this.frameMaterials) {
        mat.emissive.copy(this.tempColor);
        mat.emissiveIntensity = 2.4 + strobe * 1.4;
      }
      for (const mat of this.accentMaterials) {
        mat.emissive.copy(this.goldGlowColor);
        mat.emissiveIntensity = 2.2 + strobe * 1.2;
      }
    } else if (this.varActive) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 9);
      this.tempColor.copy(this.varGlowColor).lerp(this.baseFrameColor, pulse * 0.5);
      for (const mat of this.frameMaterials) {
        mat.emissive.copy(this.tempColor);
        mat.emissiveIntensity = 2.2 + pulse * 0.9;
      }
    } else {
      const breath = 0.5 + 0.5 * Math.sin(elapsed * 2.2);
      for (const mat of this.frameMaterials) {
        mat.emissive.copy(this.baseFrameColor);
        mat.emissiveIntensity = 1.65 + breath * 0.35;
      }
      for (const mat of this.accentMaterials) {
        mat.emissive.copy(this.goldGlowColor);
        mat.emissiveIntensity = 1.3 + breath * 0.25;
      }
    }
  }

  private getEffectiveHeadline(): { text: string; mode: 'normal' | 'goal' | 'var' } {
    if (this.varActive) {
      return { text: 'الفار بيحقق... 📺', mode: 'var' };
    }
    if (this.goalFlashRemaining > 0 && this.goalFlashTeam) {
      return { text: 'جووووول عالمي! ⚽🔥', mode: 'goal' };
    }
    if (this.customHeadline && this.customHeadline.trim().length > 0) {
      return { text: this.customHeadline.trim(), mode: 'normal' };
    }
    return { text: 'ملعب لايف • البث المباشر ⚽', mode: 'normal' };
  }

  private redrawIfDirty(force: boolean): void {
    const headlineInfo = this.getEffectiveHeadline();
    const sig = `${this.redScore}|${this.blueScore}|${this.clockWholeSec}|${headlineInfo.mode}|${headlineInfo.text}|${this.goalFlashTeam ?? ''}`;
    if (!force && sig === this.lastDrawSignature) return;
    this.lastDrawSignature = sig;
    this.drawBroadcastCanvas(headlineInfo.text, headlineInfo.mode);
  }

  private drawBroadcastCanvas(headline: string, mode: 'normal' | 'goal' | 'var'): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;

    // Deep broadcast dark stadium slate background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    if (mode === 'goal') {
      const tint = this.goalFlashTeam === 'red' ? '#450a14' : '#082047';
      bgGrad.addColorStop(0, tint);
      bgGrad.addColorStop(0.5, '#0b1224');
      bgGrad.addColorStop(1, tint);
    } else if (mode === 'var') {
      bgGrad.addColorStop(0, '#38091b');
      bgGrad.addColorStop(0.5, '#0f172a');
      bgGrad.addColorStop(1, '#1a0c2e');
    } else {
      bgGrad.addColorStop(0, '#070f22');
      bgGrad.addColorStop(0.5, '#0b1630');
      bgGrad.addColorStop(1, '#050b19');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle LED scanline dot-matrix texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    for (let y = 0; y < h; y += 8) {
      ctx.fillRect(0, y, w, 2);
    }

    // Top live broadcast header bar
    ctx.fillStyle = mode === 'var' ? '#be123c' : mode === 'goal' ? '#d97706' : '#0e2244';
    ctx.fillRect(0, 0, w, 86);

    ctx.fillStyle = mode === 'var' ? '#fda4af' : mode === 'goal' ? '#fde68a' : '#38bdf8';
    ctx.fillRect(0, 82, w, 5);

    // LIVE pill badge
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.roundRect(36, 20, 128, 46, 23);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 26px Cairo, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('● LIVE', 100, 44);

    // Stadium League title
    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 36px Cairo, Tajawal, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ELMAL3AB LIVE • ستاد القاهرة الليلي', w / 2 + 30, 45);

    // Format MM:SS clock
    const mins = Math.floor(this.clockWholeSec / 60);
    const secs = this.clockWholeSec % 60;
    const clockStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    // Center score & clock panels
    // RED TEAM PANEL (Left)
    const redGrad = ctx.createLinearGradient(44, 118, 390, 344);
    redGrad.addColorStop(0, '#991b1b');
    redGrad.addColorStop(1, '#ef4444');
    ctx.fillStyle = redGrad;
    ctx.beginPath();
    ctx.roundRect(44, 118, 336, 226, 26);
    ctx.fill();
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#fee2e2';
    ctx.font = '800 34px Cairo, Tajawal, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('الأحمر', 212, 162);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 132px Cairo, Impact, system-ui, sans-serif';
    ctx.fillText(String(this.redScore), 212, 272);

    // BLUE TEAM PANEL (Right)
    const blueGrad = ctx.createLinearGradient(644, 118, 980, 344);
    blueGrad.addColorStop(0, '#1e40af');
    blueGrad.addColorStop(1, '#3b82f6');
    ctx.fillStyle = blueGrad;
    ctx.beginPath();
    ctx.roundRect(644, 118, 336, 226, 26);
    ctx.fill();
    ctx.strokeStyle = '#93c5fd';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#dbeafe';
    ctx.font = '800 34px Cairo, Tajawal, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('الأزرق', 812, 162);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 132px Cairo, Impact, system-ui, sans-serif';
    ctx.fillText(String(this.blueScore), 812, 272);

    // CENTER CLOCK & VS BOX
    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    ctx.beginPath();
    ctx.roundRect(404, 132, 216, 198, 24);
    ctx.fill();
    ctx.strokeStyle = mode === 'var' ? '#fb7185' : '#ffd166';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '800 26px Cairo, system-ui, sans-serif';
    ctx.fillText('الوقت', w / 2, 174);

    ctx.fillStyle = '#fde047';
    ctx.font = '900 66px Cairo, monospace, sans-serif';
    ctx.fillText(clockStr, w / 2, 244);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '800 24px Cairo, system-ui, sans-serif';
    ctx.fillText('VS', w / 2, 302);

    // Bottom dynamic ticker / headline banner
    const bannerY = 374;
    const bannerH = 104;
    ctx.fillStyle =
      mode === 'goal'
        ? '#f59e0b'
        : mode === 'var'
          ? '#e11d48'
          : 'rgba(14, 30, 58, 0.96)';
    ctx.beginPath();
    ctx.roundRect(44, bannerY, w - 88, bannerH, 22);
    ctx.fill();
    ctx.strokeStyle =
      mode === 'goal' ? '#fef08a' : mode === 'var' ? '#fda4af' : '#00e5ff';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = mode === 'goal' ? '#111827' : '#ffffff';
    ctx.font =
      mode === 'goal'
        ? '900 54px Cairo, Tajawal, system-ui, sans-serif'
        : '900 44px Cairo, Tajawal, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const clipped = headline.length > 34 ? `${headline.slice(0, 33)}…` : headline;
    ctx.fillText(clipped, w / 2, bannerY + bannerH / 2 + 2);

    this.screenTexture.needsUpdate = true;
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.screenTexture.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.frameMaterials.length = 0;
    this.accentMaterials.length = 0;
  }
}
