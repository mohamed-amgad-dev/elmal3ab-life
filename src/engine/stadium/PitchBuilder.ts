import * as THREE from 'three';
import type { StadiumConfig } from '../../types/stadium';

interface CornerFlagEntry {
  geometry: THREE.PlaneGeometry;
  basePositions: Float32Array;
  phaseOffset: number;
}

export class PitchBuilder {
  public readonly group: THREE.Group;
  private config: StadiumConfig;
  private cornerFlags: CornerFlagEntry[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  constructor(config: StadiumConfig) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'PitchGroup';

    this.buildOuterStadiumFloor();
    this.buildTurfSurface();
    this.buildCornerFlags();
  }

  private buildOuterStadiumFloor(): void {
    // Dark rubberized stadium track & architectural concourse surrounding the turf apron
    const concourseGeo = new THREE.PlaneGeometry(110, 134);
    concourseGeo.rotateX(-Math.PI / 2);

    const concourseMat = new THREE.MeshStandardMaterial({
      color: 0x111726,
      roughness: 0.92,
      metalness: 0.08,
    });

    const concourseMesh = new THREE.Mesh(concourseGeo, concourseMat);
    concourseMesh.position.y = -0.04;
    concourseMesh.receiveShadow = true;
    this.group.add(concourseMesh);

    // Subtle track border ring around the turf perimeter
    const trackGeo = new THREE.PlaneGeometry(
      this.config.pitchWidth + 14,
      this.config.pitchLength + 14
    );
    trackGeo.rotateX(-Math.PI / 2);
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x1a2234,
      roughness: 0.88,
      metalness: 0.05,
    });
    const trackMesh = new THREE.Mesh(trackGeo, trackMat);
    trackMesh.position.y = -0.02;
    trackMesh.receiveShadow = true;
    this.group.add(trackMesh);

    this.geometries.push(concourseGeo, trackGeo);
    this.materials.push(concourseMat, trackMat);
  }

  private buildTurfSurface(): void {
    const margin = 3.5; // 3.5m turf apron around touchlines and goal lines
    const totalW = this.config.pitchWidth + margin * 2; // 51m
    const totalL = this.config.pitchLength + margin * 2; // 75m

    const pitchTexture = this.createProceduralPitchTexture(totalW, totalL);
    const { normalMap, roughnessMap } = this.createProceduralTurfPBRMaps(totalW, totalL);
    this.textures.push(pitchTexture, normalMap, roughnessMap);

    const pitchGeo = new THREE.PlaneGeometry(totalW, totalL, 1, 1);
    pitchGeo.rotateX(-Math.PI / 2);

    const pitchMat = new THREE.MeshStandardMaterial({
      map: pitchTexture,
      normalMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughnessMap,
      roughness: 1.0,
      metalness: 0.05,
    });

    const pitchMesh = new THREE.Mesh(pitchGeo, pitchMat);
    pitchMesh.position.y = 0;
    pitchMesh.receiveShadow = true;
    pitchMesh.name = 'PitchTurf';
    this.group.add(pitchMesh);

    this.geometries.push(pitchGeo);
    this.materials.push(pitchMat);
  }

  /**
   * Generates high-detail procedural PBR `normalMap` (fine grass blade micro-normals
   * + directional mowing stripe grain) and `roughnessMap` (subtle night-dew specular
   * variation under stadium floodlights) aligned 1:1 with the pitch turf.
   */
  private createProceduralTurfPBRMaps(
    totalW: number,
    totalL: number
  ): { normalMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
    const w = 512;
    const h = 768;

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = w;
    normalCanvas.height = h;
    const nCtx = normalCanvas.getContext('2d')!;
    const nImg = nCtx.createImageData(w, h);
    const nData = nImg.data;

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = w;
    roughCanvas.height = h;
    const rCtx = roughCanvas.getContext('2d')!;
    const rImg = rCtx.createImageData(w, h);
    const rData = rImg.data;

    const hl = this.config.halfLength;
    const hw = this.config.halfWidth;
    const numStripes = 18;
    const stripeLength = this.config.pitchLength / numStripes;

    // Fast deterministic spatial hash for blade micro-detail (no Math.random overhead)
    const hash2 = (x: number, y: number): number => {
      let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };

    for (let py = 0; py < h; py++) {
      const v = py / h;
      const wz = (v - 0.5) * totalL;
      const inPitchZ = Math.abs(wz) <= hl + 0.5;
      const stripeIdx = Math.floor((wz + hl) / stripeLength);
      const isEvenStripe = ((stripeIdx % 2) + 2) % 2 === 0;
      // Alternating roller mow lean along Z gives real stadium stripe reflection shifts
      const stripeBiasY = inPitchZ ? (isEvenStripe ? 0.14 : -0.14) : 0;
      const stripeRoughBase = inPitchZ ? (isEvenStripe ? 0.68 : 0.78) : 0.86;

      for (let px = 0; px < w; px++) {
        const u = px / w;
        const wx = (u - 0.5) * totalW;
        const idx = (py * w + px) * 4;

        // Multi-scale grass blade normal perturbation
        const h1 = hash2(px, py) * 2 - 1;
        const h2 = hash2(px >> 1, py >> 1) * 2 - 1;
        // Subtle mowing roller micro-grooves along X
        const mowGroove = Math.sin(py * 0.85) * 0.08;
        const nx = h1 * 0.34 + h2 * 0.14;
        const ny = h2 * 0.28 + stripeBiasY + mowGroove;
        const nz = Math.sqrt(Math.max(0.15, 1 - nx * nx - ny * ny));

        nData[idx] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
        nData[idx + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
        nData[idx + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
        nData[idx + 3] = 255;

        // Night-dew specular variation: smooth organic dew patches + fine blade sparkle
        const dewWave =
          Math.sin(wx * 0.22 + wz * 0.14) * Math.cos(wx * 0.13 - wz * 0.19) * 0.5 +
          Math.sin(wx * 0.45 - wz * 0.31) * 0.25;
        const inPitchX = Math.abs(wx) <= hw + 0.5;
        const wearCenter =
          inPitchX && inPitchZ
            ? Math.exp(-(wx * wx + wz * wz) / 95) * 0.05
            : 0;
        const rawRough =
          stripeRoughBase - dewWave * 0.11 + h1 * 0.065 + wearCenter;
        const clampedRough = Math.max(0.46, Math.min(0.94, rawRough));
        const rByte = Math.round(clampedRough * 255);

        rData[idx] = rByte;
        rData[idx + 1] = rByte;
        rData[idx + 2] = rByte;
        rData[idx + 3] = 255;
      }
    }

    nCtx.putImageData(nImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);

    const normalMap = new THREE.CanvasTexture(normalCanvas);
    normalMap.anisotropy = 8;
    normalMap.needsUpdate = true;

    const roughnessMap = new THREE.CanvasTexture(roughCanvas);
    roughnessMap.anisotropy = 8;
    roughnessMap.needsUpdate = true;

    return { normalMap, roughnessMap };
  }

  private createProceduralPitchTexture(
    totalW: number,
    totalL: number
  ): THREE.CanvasTexture {
    const ppm = 24; // 24 pixels per meter -> isotropic scale in X and Z
    const widthPx = Math.round(totalW * ppm);
    const heightPx = Math.round(totalL * ppm);

    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d')!;

    const toX = (wx: number) => (wx + totalW / 2) * ppm;
    const toY = (wz: number) => (wz + totalL / 2) * ppm;

    const lightColor = `#${this.config.colors.grassLight.toString(16).padStart(6, '0')}`;
    const darkColor = `#${this.config.colors.grassDark.toString(16).padStart(6, '0')}`;

    // Base dark emerald fill for run-off apron
    ctx.fillStyle = darkColor;
    ctx.fillRect(0, 0, widthPx, heightPx);

    const hw = this.config.halfWidth;
    const hl = this.config.halfLength;

    // 18 crisp horizontal mowed stripes across the pitch length
    const numStripes = 18;
    const stripeLength = this.config.pitchLength / numStripes;
    for (let i = 0; i < numStripes; i++) {
      const z0 = -hl + i * stripeLength;
      ctx.fillStyle = i % 2 === 0 ? lightColor : darkColor;
      ctx.fillRect(
        toX(-hw - 1.2),
        toY(z0),
        (this.config.pitchWidth + 2.4) * ppm,
        stripeLength * ppm + 1
      );
    }

    // Subtle vertical cross-mow sheen bands
    const numCols = 10;
    const colWidth = this.config.pitchWidth / numCols;
    for (let c = 0; c < numCols; c++) {
      const x0 = -hw + c * colWidth;
      ctx.fillStyle =
        c % 2 === 0 ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.035)';
      ctx.fillRect(
        toX(x0),
        toY(-hl),
        colWidth * ppm,
        this.config.pitchLength * ppm
      );
    }

    // Subtle organic turf grain speckles so close-up goalkeeper/player cams feel rich
    for (let i = 0; i < 16000; i++) {
      const gx = Math.random() * widthPx;
      const gy = Math.random() * heightPx;
      ctx.fillStyle =
        i % 2 === 0 ? 'rgba(255, 255, 255, 0.045)' : 'rgba(0, 18, 6, 0.065)';
      ctx.fillRect(gx, gy, 2, 2);
    }

    // Vignette darkening around outer turf apron
    const apronGrad = ctx.createRadialGradient(
      widthPx / 2,
      heightPx / 2,
      Math.min(widthPx, heightPx) * 0.35,
      widthPx / 2,
      heightPx / 2,
      Math.max(widthPx, heightPx) * 0.54
    );
    apronGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    apronGrad.addColorStop(1, 'rgba(4, 14, 8, 0.32)');
    ctx.fillStyle = apronGrad;
    ctx.fillRect(0, 0, widthPx, heightPx);

    // Crisp glowing white pitch lines
    ctx.strokeStyle = 'rgba(248, 252, 255, 0.96)';
    ctx.fillStyle = 'rgba(248, 252, 255, 0.96)';
    ctx.lineWidth = 0.16 * ppm;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(210, 240, 255, 0.45)';
    ctx.shadowBlur = 4;

    // 1. Outer pitch boundary rectangle
    ctx.strokeRect(
      toX(-hw),
      toY(-hl),
      this.config.pitchWidth * ppm,
      this.config.pitchLength * ppm
    );

    // 2. Halfway line
    ctx.beginPath();
    ctx.moveTo(toX(-hw), toY(0));
    ctx.lineTo(toX(hw), toY(0));
    ctx.stroke();

    // 3. Center circle & kickoff spot
    ctx.beginPath();
    ctx.arc(
      toX(0),
      toY(0),
      this.config.centerCircleRadius * ppm,
      0,
      Math.PI * 2
    );
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(toX(0), toY(0), 0.28 * ppm, 0, Math.PI * 2);
    ctx.fill();

    // 4. Penalty boxes, 6-yard goal boxes, penalty spots, and goal-line highlights
    const pBoxHalfW = this.config.penaltyBoxWidth / 2; // 12
    const pBoxDepth = this.config.penaltyBoxDepth; // 12
    const gBoxHalfW = 6.6;
    const gBoxDepth = 4.5;

    // North (-Z, Red defends) Penalty Box & Goal Box
    ctx.strokeRect(
      toX(-pBoxHalfW),
      toY(-hl),
      this.config.penaltyBoxWidth * ppm,
      pBoxDepth * ppm
    );
    ctx.strokeRect(
      toX(-gBoxHalfW),
      toY(-hl),
      gBoxHalfW * 2 * ppm,
      gBoxDepth * ppm
    );

    // South (+Z, Blue defends) Penalty Box & Goal Box
    ctx.strokeRect(
      toX(-pBoxHalfW),
      toY(hl - pBoxDepth),
      this.config.penaltyBoxWidth * ppm,
      pBoxDepth * ppm
    );
    ctx.strokeRect(
      toX(-gBoxHalfW),
      toY(hl - gBoxDepth),
      gBoxHalfW * 2 * ppm,
      gBoxDepth * ppm
    );

    // Penalty spots at Z = ±config.penaltySpotZ (±23)
    const pSpotZ = this.config.penaltySpotZ;
    for (const sz of [-pSpotZ, pSpotZ]) {
      ctx.beginPath();
      ctx.arc(toX(0), toY(sz), 0.25 * ppm, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Penalty arcs ("the D") clipped to the region outside the penalty boxes
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      toX(-hw),
      toY(-hl + pBoxDepth),
      this.config.pitchWidth * ppm,
      (this.config.pitchLength - pBoxDepth * 2) * ppm
    );
    ctx.clip();

    const arcRadius = 6.5 * ppm;
    ctx.beginPath();
    ctx.arc(toX(0), toY(-pSpotZ), arcRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(toX(0), toY(pSpotZ), arcRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 6. Four Corner Arcs clipped to inside the pitch boundary
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      toX(-hw),
      toY(-hl),
      this.config.pitchWidth * ppm,
      this.config.pitchLength * ppm
    );
    ctx.clip();

    const cornerRadius = 1.25 * ppm;
    const corners: [number, number][] = [
      [-hw, -hl],
      [hw, -hl],
      [-hw, hl],
      [hw, hl],
    ];
    for (const [cx, cz] of corners) {
      ctx.beginPath();
      ctx.arc(toX(cx), toY(cz), cornerRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  }

  private buildCornerFlags(): void {
    const hw = this.config.halfWidth;
    const hl = this.config.halfLength;
    const corners: { x: number; z: number; color: number }[] = [
      { x: -hw, z: -hl, color: this.config.colors.redTeam },
      { x: hw, z: -hl, color: this.config.colors.redTeam },
      { x: -hw, z: hl, color: this.config.colors.blueTeam },
      { x: hw, z: hl, color: this.config.colors.blueTeam },
    ];

    const poleGeo = new THREE.CylinderGeometry(0.04, 0.045, 1.55, 8);
    const finialGeo = new THREE.SphereGeometry(0.065, 8, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.3,
      metalness: 0.2,
    });
    const finialMat = new THREE.MeshStandardMaterial({
      color: 0xffd426,
      emissive: 0xffaa00,
      emissiveIntensity: 0.4,
      roughness: 0.25,
      metalness: 0.6,
    });

    this.geometries.push(poleGeo, finialGeo);
    this.materials.push(poleMat, finialMat);

    corners.forEach((corner, idx) => {
      const flagGroup = new THREE.Group();
      flagGroup.position.set(corner.x, 0, corner.z);

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 0.775;
      pole.castShadow = true;
      flagGroup.add(pole);

      const finial = new THREE.Mesh(finialGeo, finialMat);
      finial.position.y = 1.57;
      flagGroup.add(finial);

      // Subdivided cloth flag plane shifted so left edge attaches to the pole
      const clothW = 0.72;
      const clothH = 0.46;
      const clothGeo = new THREE.PlaneGeometry(clothW, clothH, 8, 4);
      clothGeo.translate(clothW / 2, 0, 0);

      const clothMat = new THREE.MeshStandardMaterial({
        color: corner.color,
        emissive: corner.color,
        emissiveIntensity: 0.35,
        roughness: 0.45,
        side: THREE.DoubleSide,
      });

      const clothMesh = new THREE.Mesh(clothGeo, clothMat);
      clothMesh.position.set(0.03, 1.3, 0);
      clothMesh.castShadow = true;
      flagGroup.add(clothMesh);

      const posAttr = clothGeo.attributes.position as THREE.BufferAttribute;
      const basePositions = new Float32Array(posAttr.array.length);
      basePositions.set(posAttr.array);

      this.cornerFlags.push({
        geometry: clothGeo,
        basePositions,
        phaseOffset: idx * 1.57,
      });

      this.geometries.push(clothGeo);
      this.materials.push(clothMat);
      this.group.add(flagGroup);
    });
  }

  public update(elapsed: number): void {
    for (const flag of this.cornerFlags) {
      const posAttr = flag.geometry.attributes.position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const base = flag.basePositions;

      for (let i = 0; i < posAttr.count; i++) {
        const ix = i * 3;
        const bx = base[ix]; // 0 at pole, up to 0.72 at tip
        const by = base[ix + 1];
        const normX = Math.max(0, bx / 0.72);

        const wave1 = Math.sin(elapsed * 7.5 - normX * 4.8 + flag.phaseOffset);
        const wave2 = Math.cos(elapsed * 11.2 - normX * 7.5 + by * 3.0);

        arr[ix + 2] = (wave1 * 0.11 + wave2 * 0.04) * Math.pow(normX, 1.25);
        arr[ix + 1] = by + wave1 * 0.025 * normX;
      }

      posAttr.needsUpdate = true;
      flag.geometry.computeVertexNormals();
    }
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries = [];
    this.materials = [];
    this.textures = [];
    this.cornerFlags = [];
  }
}
