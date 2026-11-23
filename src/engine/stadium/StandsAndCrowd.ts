import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TeamId } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

interface SpectatorRecord {
  x: number;
  y: number;
  z: number;
  rotY: number;
  phase: number;
  speed: number;
  teamBias: TeamId;
}

interface SponsorSpec {
  text: string;
  subtext: string;
  bgStart: string;
  bgEnd: string;
  accentColor: string;
  textColor: string;
}

const EGYPTIAN_SPONSORS: SponsorSpec[] = [
  {
    text: 'ملعب لايف ⚽',
    subtext: 'ELMAL3AB LIVE • البث المباشر',
    bgStart: '#071b34',
    bgEnd: '#0d3b66',
    accentColor: '#00f0ff',
    textColor: '#ffffff',
  },
  {
    text: 'كشري الأسطى 🔥',
    subtext: 'دقة وشطة تخليك تشوط من نص الملعب',
    bgStart: '#3b0a0a',
    bgEnd: '#7c1616',
    accentColor: '#ffb703',
    textColor: '#fff8e7',
  },
  {
    text: 'شاي الخمسينة ☕',
    subtext: 'اظبط دماغك بين الشوطين',
    bgStart: '#1e130c',
    bgEnd: '#4a2511',
    accentColor: '#f59e0b',
    textColor: '#fef3c7',
  },
  {
    text: 'أكاديمية الغطس 🎭',
    subtext: 'فن التمثيل والحصول على ضربات الجزاء',
    bgStart: '#1d1135',
    bgEnd: '#3c1e70',
    accentColor: '#e879f9',
    textColor: '#fdf4ff',
  },
  {
    text: 'كارت أحمر لايف 🟥',
    subtext: 'برعاية حكم الساحة والـ VAR المصري',
    bgStart: '#330814',
    bgEnd: '#6e0d25',
    accentColor: '#ff2a4b',
    textColor: '#ffe4e6',
  },
];

export class StandsAndCrowd {
  public readonly group: THREE.Group;
  private config: StadiumConfig;
  private crowdMesh!: THREE.InstancedMesh;
  private spectators: SpectatorRecord[] = [];
  private dummy = new THREE.Object3D();

  private ledTrimMaterials: THREE.MeshStandardMaterial[] = [];
  private baseTrimColors: THREE.Color[] = [];
  private tempColor = new THREE.Color();

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  private crowdExcitement = 0.35;
  private targetExcitement = 0.35;

  constructor(config: StadiumConfig) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'StandsAndCrowd';

    this.buildGrandstandsAndCanopies();
    this.buildInstancedCrowd();
    this.buildPerimeterAdBoards();
  }

  private buildGrandstandsAndCanopies(): void {
    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x192132,
      roughness: 0.85,
      metalness: 0.12,
    });
    const riserMat = new THREE.MeshStandardMaterial({
      color: 0x232e45,
      roughness: 0.75,
      metalness: 0.18,
    });
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x0f1626,
      roughness: 0.5,
      metalness: 0.65,
    });
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.75,
    });

    this.materials.push(concreteMat, riserMat, roofMat, pillarMat);

    const numTiers = 6;
    const tierDepth = 1.95;
    const tierHeight = 1.45;

    // Helper to build a tiered grandstand along Z (West/East) or along X (North/South)
    const createStandSection = (
      axis: 'x' | 'z',
      sign: -1 | 1,
      startOffset: number,
      spanLength: number,
      trimColorHex: number
    ) => {
      const standGroup = new THREE.Group();

      // Low front retaining wall facing pitch
      const wallHeight = 1.35;
      const wallGeo =
        axis === 'x'
          ? new THREE.BoxGeometry(0.6, wallHeight, spanLength)
          : new THREE.BoxGeometry(spanLength, wallHeight, 0.6);
      const wallMesh = new THREE.Mesh(wallGeo, riserMat);
      if (axis === 'x') {
        wallMesh.position.set(sign * (startOffset - 0.3), wallHeight / 2, 0);
      } else {
        wallMesh.position.set(0, wallHeight / 2, sign * (startOffset - 0.3));
      }
      wallMesh.receiveShadow = true;
      standGroup.add(wallMesh);
      this.geometries.push(wallGeo);

      // Glowing LED ribbon along the front retaining wall
      const baseTrim = new THREE.Color(trimColorHex);
      const trimMat = new THREE.MeshStandardMaterial({
        color: trimColorHex,
        emissive: baseTrim.clone(),
        emissiveIntensity: 2.1,
        roughness: 0.2,
      });
      this.ledTrimMaterials.push(trimMat);
      this.baseTrimColors.push(baseTrim);
      this.materials.push(trimMat);

      const frontRibbonGeo =
        axis === 'x'
          ? new THREE.BoxGeometry(0.14, 0.24, spanLength - 0.4)
          : new THREE.BoxGeometry(spanLength - 0.4, 0.24, 0.14);
      const frontRibbon = new THREE.Mesh(frontRibbonGeo, trimMat);
      if (axis === 'x') {
        frontRibbon.position.set(sign * (startOffset - 0.62), 1.05, 0);
      } else {
        frontRibbon.position.set(0, 1.05, sign * (startOffset - 0.62));
      }
      standGroup.add(frontRibbon);
      this.geometries.push(frontRibbonGeo);

      // 6 stepped concrete seating tiers
      for (let t = 0; t < numTiers; t++) {
        const offset = startOffset + t * tierDepth + tierDepth / 2;
        const height = (t + 1) * tierHeight;

        const tierGeo =
          axis === 'x'
            ? new THREE.BoxGeometry(tierDepth, height, spanLength)
            : new THREE.BoxGeometry(spanLength, height, tierDepth);

        const tierMesh = new THREE.Mesh(
          tierGeo,
          t % 2 === 0 ? concreteMat : riserMat
        );
        if (axis === 'x') {
          tierMesh.position.set(sign * offset, height / 2, 0);
        } else {
          tierMesh.position.set(0, height / 2, sign * offset);
        }
        tierMesh.receiveShadow = true;
        tierMesh.castShadow = true;
        standGroup.add(tierMesh);
        this.geometries.push(tierGeo);

        // Populate spectator slots along this tier
        const rowY = height + 0.05;
        const seatSpacing = 1.38;
        const seatsInRow = Math.floor((spanLength - 3.0) / seatSpacing);

        for (let s = 0; s < seatsInRow; s++) {
          // Leave occasional aisle gaps for stadium realism
          if (s % 11 === 5) continue;
          if (Math.random() < 0.12) continue;

          const alongCoord =
            -((seatsInRow - 1) * seatSpacing) / 2 +
            s * seatSpacing +
            (Math.random() - 0.5) * 0.28;
          const depthJitter = (Math.random() - 0.5) * 0.32;

          let sx = 0;
          let sz = 0;
          let rotY = 0;
          if (axis === 'x') {
            sx = sign * (offset - 0.15 + depthJitter);
            sz = alongCoord;
            rotY = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
          } else {
            sx = alongCoord;
            sz = sign * (offset - 0.15 + depthJitter);
            rotY = sign < 0 ? 0 : Math.PI;
          }

          // Determine team section bias (North & -Z halves favor Red, South & +Z halves favor Blue)
          const teamBias: TeamId =
            sz < -2 ? 'red' : sz > 2 ? 'blue' : Math.random() < 0.5 ? 'red' : 'blue';

          this.spectators.push({
            x: sx,
            y: rowY,
            z: sz,
            rotY,
            phase: Math.random() * Math.PI * 2,
            speed: 4.5 + Math.random() * 3.2,
            teamBias,
          });
        }
      }

      // Rear back wall & high cantilevered canopy roof (Y = 18.2 so stands_cam at Y=15 has full clear sightline!)
      const backEdge = startOffset + numTiers * tierDepth;
      const roofY = 18.2;
      const roofDepth = numTiers * tierDepth + 2.8;
      const roofCenterOffset = backEdge - roofDepth / 2 + 0.6;

      const backWallH = roofY - numTiers * tierHeight;
      const backWallGeo =
        axis === 'x'
          ? new THREE.BoxGeometry(0.9, backWallH, spanLength)
          : new THREE.BoxGeometry(spanLength, backWallH, 0.9);
      const backWall = new THREE.Mesh(backWallGeo, pillarMat);
      if (axis === 'x') {
        backWall.position.set(
          sign * (backEdge + 0.2),
          numTiers * tierHeight + backWallH / 2,
          0
        );
      } else {
        backWall.position.set(
          0,
          numTiers * tierHeight + backWallH / 2,
          sign * (backEdge + 0.2)
        );
      }
      standGroup.add(backWall);
      this.geometries.push(backWallGeo);

      const roofGeo =
        axis === 'x'
          ? new THREE.BoxGeometry(roofDepth, 0.55, spanLength + 1.2)
          : new THREE.BoxGeometry(spanLength + 1.2, 0.55, roofDepth);
      const roofMesh = new THREE.Mesh(roofGeo, roofMat);
      if (axis === 'x') {
        roofMesh.position.set(sign * roofCenterOffset, roofY, 0);
        roofMesh.rotation.z = sign * 0.08;
      } else {
        roofMesh.position.set(0, roofY, sign * roofCenterOffset);
        roofMesh.rotation.x = -sign * 0.08;
      }
      standGroup.add(roofMesh);
      this.geometries.push(roofGeo);

      // Glowing neon canopy fascia LED strip
      const fasciaOffset = backEdge - roofDepth + 0.65;
      const fasciaGeo =
        axis === 'x'
          ? new THREE.BoxGeometry(0.26, 0.34, spanLength + 0.8)
          : new THREE.BoxGeometry(spanLength + 0.8, 0.34, 0.26);
      const fasciaMesh = new THREE.Mesh(fasciaGeo, trimMat);
      if (axis === 'x') {
        fasciaMesh.position.set(sign * fasciaOffset, roofY - 0.52, 0);
      } else {
        fasciaMesh.position.set(0, roofY - 0.52, sign * fasciaOffset);
      }
      standGroup.add(fasciaMesh);
      this.geometries.push(fasciaGeo);

      this.group.add(standGroup);
    };

    // West Stand (-X), East Stand (+X), North Stand (-Z, Red Kop), South Stand (+Z, Blue Kop)
    createStandSection('x', -1, 29.2, 66, 0x00e5ff);
    createStandSection('x', 1, 29.2, 66, 0xffd426);
    createStandSection('z', -1, 39.2, 50, this.config.colors.redTeam);
    createStandSection('z', 1, 39.2, 50, this.config.colors.blueTeam);
  }

  private createSpectatorGeometry(): THREE.BufferGeometry {
    // Stylized low-poly cheering spectator with torso, head, and raised arms
    // All 4 parts use indexed geometries with matching (position, normal, uv) attributes
    const torso = new THREE.BoxGeometry(0.54, 0.72, 0.34);
    torso.translate(0, 0.38, 0);

    const head = new THREE.SphereGeometry(0.21, 8, 6);
    head.translate(0, 0.94, 0);

    const leftArm = new THREE.BoxGeometry(0.14, 0.48, 0.14);
    leftArm.rotateZ(0.32);
    leftArm.translate(-0.36, 0.74, 0.04);

    const rightArm = new THREE.BoxGeometry(0.14, 0.48, 0.14);
    rightArm.rotateZ(-0.32);
    rightArm.translate(0.36, 0.74, 0.04);

    const merged = mergeGeometries([torso, head, leftArm, rightArm], false);
    torso.dispose();
    head.dispose();
    leftArm.dispose();
    rightArm.dispose();
    return merged ?? new THREE.BoxGeometry(0.54, 1.1, 0.34);
  }

  private buildInstancedCrowd(): void {
    const count = this.spectators.length;
    const specGeo = this.createSpectatorGeometry();
    const specMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.1,
    });

    this.geometries.push(specGeo);
    this.materials.push(specMat);

    this.crowdMesh = new THREE.InstancedMesh(specGeo, specMat, count);
    this.crowdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.crowdMesh.castShadow = false;
    this.crowdMesh.receiveShadow = true;

    const redPalette = [
      this.config.colors.redTeam,
      0xff3b5c,
      0xffd426,
      0xffffff,
      0xc81e32,
    ];
    const bluePalette = [
      this.config.colors.blueTeam,
      0x00d4ff,
      0x38bdf8,
      0xffd426,
      0xffffff,
    ];

    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const spec = this.spectators[i];
      this.dummy.position.set(spec.x, spec.y, spec.z);
      this.dummy.rotation.set(0, spec.rotY, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.crowdMesh.setMatrixAt(i, this.dummy.matrix);

      const palette = spec.teamBias === 'red' ? redPalette : bluePalette;
      const chosenHex = palette[i % palette.length];
      color.setHex(chosenHex);
      this.crowdMesh.setColorAt(i, color);
    }

    this.crowdMesh.instanceMatrix.needsUpdate = true;
    if (this.crowdMesh.instanceColor) {
      this.crowdMesh.instanceColor.needsUpdate = true;
    }

    this.group.add(this.crowdMesh);
  }

  private createAdBoardTexture(sponsor: SponsorSpec): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 192;
    const ctx = canvas.getContext('2d')!;

    // Rich neon stadium LED banner gradient background
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, sponsor.bgStart);
    grad.addColorStop(0.5, sponsor.bgEnd);
    grad.addColorStop(1, sponsor.bgStart);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle LED pixel matrix scanlines
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    for (let y = 0; y < canvas.height; y += 8) {
      ctx.fillRect(0, y, canvas.width, 2);
    }

    // Glowing top & bottom neon accent borders
    ctx.fillStyle = sponsor.accentColor;
    ctx.fillRect(0, 0, canvas.width, 10);
    ctx.fillRect(0, canvas.height - 10, canvas.width, 10);

    // Side chevrons
    ctx.fillStyle = sponsor.accentColor;
    ctx.fillRect(18, 26, 12, canvas.height - 52);
    ctx.fillRect(canvas.width - 30, 26, 12, canvas.height - 52);

    // Main bold Arabic comedy sponsor headline
    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = sponsor.accentColor;
    ctx.shadowBlur = 16;
    ctx.fillStyle = sponsor.textColor;
    ctx.font = '900 72px "Cairo", "Tajawal", sans-serif';
    ctx.fillText(sponsor.text, canvas.width / 2, 78);

    // Subtitle line
    ctx.shadowBlur = 6;
    ctx.fillStyle = sponsor.accentColor;
    ctx.font = '700 28px "Tajawal", "Cairo", sans-serif';
    ctx.fillText(sponsor.subtext, canvas.width / 2, 146);
    ctx.restore();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  private buildPerimeterAdBoards(): void {
    const sponsorMaterials: THREE.MeshStandardMaterial[] = [];

    for (const sponsor of EGYPTIAN_SPONSORS) {
      const tex = this.createAdBoardTexture(sponsor);
      this.textures.push(tex);

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.92,
        roughness: 0.25,
        metalness: 0.1,
      });
      this.materials.push(mat);
      sponsorMaterials.push(mat);
    }

    const backingMat = new THREE.MeshStandardMaterial({
      color: 0x131a29,
      roughness: 0.6,
      metalness: 0.5,
    });
    this.materials.push(backingMat);

    const boardW = 8.4;
    const boardH = 1.12;
    const boardDepth = 0.22;

    const frameGeo = new THREE.BoxGeometry(boardW, boardH, boardDepth);
    const screenGeo = new THREE.PlaneGeometry(boardW - 0.16, boardH - 0.14);
    this.geometries.push(frameGeo, screenGeo);

    let sponsorIdx = 0;
    const placeBoard = (x: number, z: number, rotY: number) => {
      const boardGroup = new THREE.Group();
      boardGroup.position.set(x, boardH / 2, z);
      boardGroup.rotation.y = rotY;

      const frame = new THREE.Mesh(frameGeo, backingMat);
      frame.castShadow = true;
      frame.receiveShadow = true;
      boardGroup.add(frame);

      const screenMat =
        sponsorMaterials[sponsorIdx % sponsorMaterials.length];
      sponsorIdx++;

      const screen = new THREE.Mesh(screenGeo, screenMat);
      screen.position.z = boardDepth / 2 + 0.01;
      boardGroup.add(screen);

      this.group.add(boardGroup);
    };

    // West touchline (-X = -23.6), leaving clear central gap for VAR Booth at Z = 0
    for (const z of [-27, -18, -9, 9, 18, 27]) {
      placeBoard(-23.6, z, Math.PI / 2);
    }

    // East touchline (+X = +23.6) outer wings, leaving central technical & dugout zone clear
    for (const z of [-28, -19.2, 19.2, 28]) {
      placeBoard(23.6, z, -Math.PI / 2);
    }

    // North endline (-Z = -35.8) flanking Red goal (goal width is 9.2 -> X in [-4.6, 4.6])
    placeBoard(-15.5, -35.8, 0);
    placeBoard(-9.8, -35.8, 0);
    placeBoard(9.8, -35.8, 0);
    placeBoard(15.5, -35.8, 0);

    // South endline (+Z = +35.8) flanking Blue goal
    placeBoard(-15.5, 35.8, Math.PI);
    placeBoard(-9.8, 35.8, Math.PI);
    placeBoard(9.8, 35.8, Math.PI);
    placeBoard(15.5, 35.8, Math.PI);
  }

  public setCrowdExcitement(level: number): void {
    this.targetExcitement = THREE.MathUtils.clamp(level, 0.15, 1.0);
    if (level > this.crowdExcitement) {
      this.crowdExcitement = this.targetExcitement;
    }
  }

  public update(
    dt: number,
    elapsed: number,
    celebrationTeam: TeamId | null = null,
    celebrationTimer = 0
  ): void {
    // Smoothly decay excitement toward ambient stadium energy (or keep high during goal celebration)
    const minBaseline = celebrationTimer > 0 ? 0.95 : 0.32;
    this.targetExcitement = Math.max(
      minBaseline,
      this.targetExcitement - dt * 0.18
    );
    this.crowdExcitement = THREE.MathUtils.lerp(
      this.crowdExcitement,
      this.targetExcitement,
      Math.min(1, dt * 6.0)
    );

    // Animate InstancedMesh spectators bouncing & cheering
    const jumpAmp = 0.08 + this.crowdExcitement * 0.44;
    const speedMult = 0.85 + this.crowdExcitement * 1.35;

    for (let i = 0; i < this.spectators.length; i++) {
      const spec = this.spectators[i];
      const wave = Math.sin(elapsed * spec.speed * speedMult + spec.phase);
      const bounce = Math.abs(wave) * jumpAmp;
      const sway =
        Math.cos(elapsed * (spec.speed * 0.65) + spec.phase) *
        (0.06 + this.crowdExcitement * 0.16);

      this.dummy.position.set(spec.x, spec.y + bounce, spec.z);
      this.dummy.rotation.set(0, spec.rotY + sway * 0.5, sway);
      const stretch = 1.0 + bounce * 0.25;
      this.dummy.scale.set(1.0 - bounce * 0.08, stretch, 1.0 - bounce * 0.08);
      this.dummy.updateMatrix();
      this.crowdMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.crowdMesh.instanceMatrix.needsUpdate = true;

    // Pulse canopy & retaining wall LED trim strips during goal celebrations
    if (celebrationTeam && celebrationTimer > 0) {
      const teamHex =
        celebrationTeam === 'red'
          ? this.config.colors.redTeam
          : this.config.colors.blueTeam;
      this.tempColor.setHex(teamHex);
      const strobe = 0.5 + 0.5 * Math.sin(elapsed * 16.0);

      for (let i = 0; i < this.ledTrimMaterials.length; i++) {
        const mat = this.ledTrimMaterials[i];
        mat.emissive.copy(this.tempColor);
        mat.emissiveIntensity = 1.8 + strobe * 2.6;
      }
    } else {
      for (let i = 0; i < this.ledTrimMaterials.length; i++) {
        const mat = this.ledTrimMaterials[i];
        mat.emissive.copy(this.baseTrimColors[i]);
        mat.emissiveIntensity = 2.0 + 0.2 * Math.sin(elapsed * 2.5 + i);
      }
    }
  }

  public dispose(): void {
    for (const g of this.geometries) g?.dispose();
    for (const m of this.materials) m?.dispose();
    for (const t of this.textures) t?.dispose();
    this.geometries = [];
    this.materials = [];
    this.textures = [];
    this.spectators = [];
  }
}
