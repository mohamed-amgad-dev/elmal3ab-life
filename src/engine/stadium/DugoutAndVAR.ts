import * as THREE from 'three';
import type { TeamId, Vec3 } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

export class DugoutAndVAR {
  public readonly group: THREE.Group;
  private config: StadiumConfig;

  private varActive = false;
  private varScreenMat!: THREE.MeshStandardMaterial;
  private varBeaconMat!: THREE.MeshStandardMaterial;
  private varSidePillarMat!: THREE.MeshStandardMaterial;
  private varPointLight!: THREE.PointLight;
  private varRingMat!: THREE.MeshStandardMaterial;
  private varStandbyTexture!: THREE.CanvasTexture;
  private varActiveTexture!: THREE.CanvasTexture;

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  constructor(config: StadiumConfig) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'DugoutAndVAR';

    this.buildTeamDugouts();
    this.buildCoachTechnicalZones();
    this.buildVARMonitorBooth();
  }

  private buildTeamDugouts(): void {
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x161f30,
      roughness: 0.4,
      metalness: 0.75,
    });
    const platformMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.85,
      metalness: 0.15,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x88ccff,
      roughness: 0.12,
      metalness: 0.15,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const seatBaseMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.5,
      metalness: 0.6,
    });

    this.materials.push(frameMat, platformMat, glassMat, seatBaseMat);

    const teams: {
      team: TeamId;
      colorHex: number;
      seats: Vec3[];
      centerZ: number;
      label: string;
    }[] = [
      {
        team: 'red',
        colorHex: this.config.colors.redTeam,
        seats: this.config.benchPositions.red,
        centerZ: -6,
        label: 'دكة الفريق الأحمر 🔴',
      },
      {
        team: 'blue',
        colorHex: this.config.colors.blueTeam,
        seats: this.config.benchPositions.blue,
        centerZ: 6,
        label: 'دكة الفريق الأزرق 🔵',
      },
    ];

    const dugoutLength = 8.6;
    const dugoutDepth = 1.9;
    const dugoutHeight = 2.45;
    const baseX = 25.5;

    const platformGeo = new THREE.BoxGeometry(dugoutDepth + 0.5, 0.08, dugoutLength + 0.4);
    const backGlassGeo = new THREE.BoxGeometry(0.08, dugoutHeight - 0.2, dugoutLength);
    const roofGlassGeo = new THREE.BoxGeometry(dugoutDepth + 0.35, 0.08, dugoutLength + 0.2);
    const sideGlassGeo = new THREE.BoxGeometry(dugoutDepth, dugoutHeight - 0.2, 0.08);
    const pillarGeo = new THREE.BoxGeometry(0.14, dugoutHeight, 0.14);
    const trimBarGeo = new THREE.BoxGeometry(0.16, 0.22, dugoutLength + 0.24);

    // 3D Bucket Seat geometries
    const seatPedestalGeo = new THREE.CylinderGeometry(0.11, 0.16, 0.38, 10);
    const seatCushionGeo = new THREE.BoxGeometry(0.56, 0.1, 0.62);
    const seatBackGeo = new THREE.BoxGeometry(0.12, 0.78, 0.58);
    const seatHeadrestGeo = new THREE.BoxGeometry(0.14, 0.24, 0.38);

    this.geometries.push(
      platformGeo,
      backGlassGeo,
      roofGlassGeo,
      sideGlassGeo,
      pillarGeo,
      trimBarGeo,
      seatPedestalGeo,
      seatCushionGeo,
      seatBackGeo,
      seatHeadrestGeo
    );

    for (const info of teams) {
      const dugoutGroup = new THREE.Group();
      dugoutGroup.name = `Dugout_${info.team}`;

      const teamMat = new THREE.MeshStandardMaterial({
        color: info.colorHex,
        roughness: 0.38,
        metalness: 0.15,
      });
      const teamLedMat = new THREE.MeshStandardMaterial({
        color: info.colorHex,
        emissive: new THREE.Color(info.colorHex),
        emissiveIntensity: 1.9,
        roughness: 0.2,
      });
      this.materials.push(teamMat, teamLedMat);

      // Floor platform
      const platform = new THREE.Mesh(platformGeo, platformMat);
      platform.position.set(baseX + 0.1, 0.04, info.centerZ);
      platform.receiveShadow = true;
      dugoutGroup.add(platform);

      // Translucent shelter back wall & side shields
      const backGlass = new THREE.Mesh(backGlassGeo, glassMat);
      backGlass.position.set(
        baseX + dugoutDepth / 2 + 0.1,
        dugoutHeight / 2,
        info.centerZ
      );
      dugoutGroup.add(backGlass);

      const roofGlass = new THREE.Mesh(roofGlassGeo, glassMat);
      roofGlass.position.set(baseX + 0.05, dugoutHeight, info.centerZ);
      roofGlass.rotation.z = 0.12;
      dugoutGroup.add(roofGlass);

      for (const sz of [-1, 1]) {
        const sideZ = info.centerZ + sz * (dugoutLength / 2);
        const sideGlass = new THREE.Mesh(sideGlassGeo, glassMat);
        sideGlass.position.set(baseX + 0.1, dugoutHeight / 2, sideZ);
        dugoutGroup.add(sideGlass);

        const frontPillar = new THREE.Mesh(pillarGeo, frameMat);
        frontPillar.position.set(
          baseX - dugoutDepth / 2 + 0.15,
          dugoutHeight / 2,
          sideZ
        );
        dugoutGroup.add(frontPillar);

        const rearPillar = new THREE.Mesh(pillarGeo, frameMat);
        rearPillar.position.set(
          baseX + dugoutDepth / 2 + 0.1,
          dugoutHeight / 2,
          sideZ
        );
        dugoutGroup.add(rearPillar);
      }

      // Glowing team LED header strip along front of dugout roof
      const trimBar = new THREE.Mesh(trimBarGeo, teamLedMat);
      trimBar.position.set(
        baseX - dugoutDepth / 2 + 0.05,
        dugoutHeight + 0.08,
        info.centerZ
      );
      dugoutGroup.add(trimBar);

      // 3 physical racing-style 3D bucket seats at exact config.benchPositions[team]
      for (const seatPos of info.seats) {
        const seatGroup = new THREE.Group();
        seatGroup.position.set(seatPos.x, seatPos.y, seatPos.z);

        const pedestal = new THREE.Mesh(seatPedestalGeo, seatBaseMat);
        pedestal.position.set(0.1, 0.19, 0);
        seatGroup.add(pedestal);

        const cushion = new THREE.Mesh(seatCushionGeo, teamMat);
        cushion.position.set(0.08, 0.4, 0);
        cushion.castShadow = true;
        cushion.receiveShadow = true;
        seatGroup.add(cushion);

        // Backrest sits slightly behind (+X) the seat center so player character sitting at seatPos faces -X cleanly
        const backrest = new THREE.Mesh(seatBackGeo, teamMat);
        backrest.position.set(0.36, 0.82, 0);
        backrest.rotation.z = -0.14;
        backrest.castShadow = true;
        seatGroup.add(backrest);

        const headrest = new THREE.Mesh(seatHeadrestGeo, seatBaseMat);
        headrest.position.set(0.41, 1.28, 0);
        headrest.rotation.z = -0.14;
        seatGroup.add(headrest);

        dugoutGroup.add(seatGroup);
      }

      this.group.add(dugoutGroup);
    }
  }

  private buildCoachTechnicalZones(): void {
    const zones: { team: TeamId; pos: Vec3; colorHex: number }[] = [
      {
        team: 'red',
        pos: this.config.coachZones.red,
        colorHex: this.config.colors.redTeam,
      },
      {
        team: 'blue',
        pos: this.config.coachZones.blue,
        colorHex: this.config.colors.blueTeam,
      },
    ];

    const boxW = 3.2;
    const boxL = 4.4;

    for (const zInfo of zones) {
      const tex = this.createTechnicalBoxTexture(zInfo.colorHex, zInfo.team);
      this.textures.push(tex);

      const geo = new THREE.PlaneGeometry(boxW, boxL);
      geo.rotateX(-Math.PI / 2);

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.45,
        transparent: true,
        roughness: 0.7,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(zInfo.pos.x, 0.015, zInfo.pos.z);
      this.group.add(mesh);

      this.geometries.push(geo);
      this.materials.push(mat);
    }
  }

  private createTechnicalBoxTexture(
    teamColorHex: number,
    team: TeamId
  ): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 352;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hexStr = `#${teamColorHex.toString(16).padStart(6, '0')}`;
    ctx.fillStyle =
      team === 'red'
        ? 'rgba(230, 46, 61, 0.14)'
        : 'rgba(34, 119, 255, 0.14)';
    ctx.fillRect(10, 10, canvas.width - 20, canvas.height - 20);

    // Dashed technical area border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.lineWidth = 8;
    ctx.setLineDash([22, 14]);
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

    // Inner team-colored corner brackets
    ctx.setLineDash([]);
    ctx.strokeStyle = hexStr;
    ctx.lineWidth = 6;
    ctx.strokeRect(22, 22, canvas.width - 44, canvas.height - 44);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = '800 26px "Cairo", sans-serif';
    ctx.fillText(
      team === 'red' ? 'COACH ZONE • المدير الفني' : 'COACH ZONE • المدير الفني',
      0,
      0
    );
    ctx.restore();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private createVARScreenTexture(active: boolean): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (active) {
      grad.addColorStop(0, '#041c2c');
      grad.addColorStop(0.5, '#190a36');
      grad.addColorStop(1, '#05192d');
    } else {
      grad.addColorStop(0, '#071120');
      grad.addColorStop(1, '#0e1d36');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Broadcast tactical grid overlay
    ctx.strokeStyle = active
      ? 'rgba(0, 240, 255, 0.26)'
      : 'rgba(0, 210, 255, 0.12)';
    ctx.lineWidth = 2;
    for (let x = 32; x < canvas.width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 32; y < canvas.height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Glowing border
    ctx.strokeStyle = active ? '#ff007f' : '#00e5ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 56px "Cairo", sans-serif';
    ctx.fillText('📺 VAR', canvas.width / 2, 110);

    ctx.fillStyle = active ? '#00f0ff' : '#94a3b8';
    ctx.font = '800 34px "Cairo", sans-serif';
    ctx.fillText(
      active ? 'جاري مراجعة اللقطة...' : 'غرفة الفار • جاهز',
      canvas.width / 2,
      205
    );

    if (active) {
      ctx.fillStyle = '#ff007f';
      ctx.font = '700 22px "Cairo", sans-serif';
      ctx.fillText('LIVE REPLAY • إعادة بالحركة البطيئة', canvas.width / 2, 265);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private buildVARMonitorBooth(): void {
    const varPos = this.config.varBoothPos; // { x: -25.5, y: 0, z: 0 }
    const boothGroup = new THREE.Group();
    boothGroup.name = 'VARMonitorBooth';
    boothGroup.position.set(varPos.x, varPos.y, varPos.z);
    // Face +X toward the center of the pitch
    boothGroup.rotation.y = Math.PI / 2;

    this.varStandbyTexture = this.createVARScreenTexture(false);
    this.varActiveTexture = this.createVARScreenTexture(true);
    this.textures.push(this.varStandbyTexture, this.varActiveTexture);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x131b2e,
      roughness: 0.35,
      metalness: 0.78,
    });

    this.varRingMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: new THREE.Color(0x00e5ff),
      emissiveIntensity: 1.4,
      roughness: 0.25,
    });

    this.varSidePillarMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: new THREE.Color(0x00e5ff),
      emissiveIntensity: 1.5,
      roughness: 0.2,
    });

    this.varBeaconMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: new THREE.Color(0x00f0ff),
      emissiveIntensity: 1.6,
      roughness: 0.15,
    });

    this.varScreenMat = new THREE.MeshStandardMaterial({
      map: this.varStandbyTexture,
      emissiveMap: this.varStandbyTexture,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.15,
      roughness: 0.18,
    });

    this.materials.push(
      bodyMat,
      this.varRingMat,
      this.varSidePillarMat,
      this.varBeaconMat,
      this.varScreenMat
    );

    // Circular base platform + glowing neon floor ring
    const basePlatformGeo = new THREE.CylinderGeometry(1.25, 1.4, 0.12, 24);
    const basePlatform = new THREE.Mesh(basePlatformGeo, bodyMat);
    basePlatform.position.y = 0.06;
    basePlatform.receiveShadow = true;
    boothGroup.add(basePlatform);

    const floorRingGeo = new THREE.TorusGeometry(1.32, 0.055, 8, 28);
    floorRingGeo.rotateX(Math.PI / 2);
    const floorRing = new THREE.Mesh(floorRingGeo, this.varRingMat);
    floorRing.position.y = 0.08;
    boothGroup.add(floorRing);

    // Angled central pedestal column
    const columnGeo = new THREE.BoxGeometry(0.42, 1.45, 0.36);
    const column = new THREE.Mesh(columnGeo, bodyMat);
    column.position.set(0, 0.78, -0.15);
    column.castShadow = true;
    boothGroup.add(column);

    // Broadcast monitor housing & sun hood
    const monitorHousingGeo = new THREE.BoxGeometry(2.05, 1.26, 0.24);
    const monitorHousing = new THREE.Mesh(monitorHousingGeo, bodyMat);
    monitorHousing.position.set(0, 1.72, 0);
    monitorHousing.rotation.x = -0.12;
    monitorHousing.castShadow = true;
    boothGroup.add(monitorHousing);

    const screenGeo = new THREE.PlaneGeometry(1.86, 1.08);
    const screenMesh = new THREE.Mesh(screenGeo, this.varScreenMat);
    screenMesh.position.set(0, 1.72, 0.13);
    screenMesh.rotation.x = -0.12;
    boothGroup.add(screenMesh);

    // Twin vertical neon side strips flanking the monitor
    const sideStripGeo = new THREE.BoxGeometry(0.1, 1.32, 0.28);
    for (const sx of [-1.06, 1.06]) {
      const strip = new THREE.Mesh(sideStripGeo, this.varSidePillarMat);
      strip.position.set(sx, 1.72, 0.02);
      strip.rotation.x = -0.12;
      boothGroup.add(strip);
    }

    // Top VAR Beacon mast & glowing dome
    const beaconMastGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.55, 10);
    const beaconMast = new THREE.Mesh(beaconMastGeo, bodyMat);
    beaconMast.position.set(0, 2.55, -0.05);
    boothGroup.add(beaconMast);

    const beaconDomeGeo = new THREE.SphereGeometry(0.24, 16, 12);
    const beaconDome = new THREE.Mesh(beaconDomeGeo, this.varBeaconMat);
    beaconDome.position.set(0, 2.88, -0.05);
    boothGroup.add(beaconDome);

    this.varPointLight = new THREE.PointLight(0x00f0ff, 2.0, 9.0);
    this.varPointLight.position.set(0, 2.9, 0.6);
    boothGroup.add(this.varPointLight);

    this.geometries.push(
      basePlatformGeo,
      floorRingGeo,
      columnGeo,
      monitorHousingGeo,
      screenGeo,
      sideStripGeo,
      beaconMastGeo,
      beaconDomeGeo
    );

    this.group.add(boothGroup);
  }

  public setVARActive(active: boolean): void {
    if (this.varActive === active) return;
    this.varActive = active;

    const tex = active ? this.varActiveTexture : this.varStandbyTexture;
    this.varScreenMat.map = tex;
    this.varScreenMat.emissiveMap = tex;
    this.varScreenMat.needsUpdate = true;
  }

  public getBenchSeatPosition(team: TeamId, slotIndex: number): Vec3 {
    const seats = this.config.benchPositions[team];
    if (!seats || seats.length === 0) {
      return { x: 25.5, y: 0, z: team === 'red' ? -6 : 6 };
    }
    const idx = Math.abs(Math.floor(slotIndex)) % seats.length;
    const target = seats[idx];
    return { x: target.x, y: target.y, z: target.z };
  }

  public update(_dt: number, elapsed: number): void {
    if (this.varActive) {
      // Dramatic alternating cyan / magenta VAR alert strobe
      const wave = 0.5 + 0.5 * Math.sin(elapsed * 12.0);
      const cyan = new THREE.Color(0x00f0ff);
      const magenta = new THREE.Color(0xff007f);

      this.varBeaconMat.emissive.copy(cyan).lerp(magenta, wave);
      this.varBeaconMat.emissiveIntensity = 3.2 + wave * 2.2;

      this.varSidePillarMat.emissive.copy(magenta).lerp(cyan, wave);
      this.varSidePillarMat.emissiveIntensity = 2.6 + (1 - wave) * 1.8;

      this.varRingMat.emissive.copy(cyan).lerp(magenta, 1 - wave);
      this.varRingMat.emissiveIntensity = 2.5;

      this.varScreenMat.emissiveIntensity = 1.75 + 0.35 * Math.sin(elapsed * 8.0);

      this.varPointLight.color.copy(this.varBeaconMat.emissive);
      this.varPointLight.intensity = 12.0 + wave * 8.0;
    } else {
      const slowPulse = 0.5 + 0.5 * Math.sin(elapsed * 2.2);
      this.varBeaconMat.emissive.setHex(0x00e5ff);
      this.varBeaconMat.emissiveIntensity = 1.2 + slowPulse * 0.6;

      this.varSidePillarMat.emissive.setHex(0x00e5ff);
      this.varSidePillarMat.emissiveIntensity = 1.3;

      this.varRingMat.emissive.setHex(0x00e5ff);
      this.varRingMat.emissiveIntensity = 1.2;

      this.varScreenMat.emissiveIntensity = 1.05;
      this.varPointLight.color.setHex(0x00e5ff);
      this.varPointLight.intensity = 1.8;
    }
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries = [];
    this.materials = [];
    this.textures = [];
  }
}
