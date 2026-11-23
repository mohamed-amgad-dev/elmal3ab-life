import * as THREE from 'three';
import type { TeamId, Vec3 } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';

interface NetPanelData {
  geometry: THREE.PlaneGeometry;
  baseLocalPositions: Float32Array;
  worldRestPositions: Float32Array;
  edgeWeights: Float32Array;
  localNormal: THREE.Vector3;
}

interface RippleWave {
  origin: THREE.Vector3;
  age: number;
  duration: number;
  amplitude: number;
}

interface GoalInstance {
  defendingTeam: TeamId;
  goalZ: number;
  outwardSignZ: number; // -1 for North goal (Z=-34), +1 for South goal (Z=+34)
  panels: NetPanelData[];
  ripples: RippleWave[];
  ledStripMat: THREE.MeshStandardMaterial;
  baseLedColor: THREE.Color;
  flashTimer: number;
}

export class GoalNet {
  public readonly group: THREE.Group;
  private config: StadiumConfig;
  private goals: GoalInstance[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private netTexture: THREE.CanvasTexture;

  constructor(config: StadiumConfig) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'GoalsGroup';

    this.netTexture = this.createNetPatternTexture();
    this.textures.push(this.netTexture);

    // North Goal at Z = -34 (Red defends, net extends to -36.6)
    this.goals.push(
      this.buildGoal('red', -this.config.halfLength, -1, this.config.colors.redTeam)
    );

    // South Goal at Z = +34 (Blue defends, net extends to +36.6)
    this.goals.push(
      this.buildGoal('blue', this.config.halfLength, 1, this.config.colors.blueTeam)
    );
  }

  private createNetPatternTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, size, size);

    // Crisp bright diamond & hexagonal stadium net weave
    ctx.strokeStyle = 'rgba(240, 248, 255, 0.88)';
    ctx.lineWidth = 4.0;

    const step = 32;
    for (let i = -size; i <= size * 2; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + size, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(i, size);
      ctx.lineTo(i + size, 0);
      ctx.stroke();
    }

    // Subtle knot highlights at intersections
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (let y = 0; y <= size; y += step / 2) {
      for (let x = 0; x <= size; x += step / 2) {
        if (((x + y) / (step / 2)) % 2 === 0) {
          ctx.beginPath();
          ctx.arc(x, y, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 3);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private buildGoal(
    defendingTeam: TeamId,
    goalZ: number,
    outwardSignZ: number,
    teamColorHex: number
  ): GoalInstance {
    const goalGroup = new THREE.Group();
    goalGroup.name = `Goal_${defendingTeam}`;

    const gw = this.config.goalWidth; // 9.2
    const halfW = gw / 2; // 4.6
    const gh = this.config.goalHeight; // 3.6
    const gd = this.config.goalDepth; // 2.6
    const backZ = goalZ + outwardSignZ * gd;
    const postRadius = 0.11;

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.18,
      metalness: 0.32,
    });
    const stanchionMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.45,
      metalness: 0.68,
    });
    const baseLedColor = new THREE.Color(teamColorHex);
    const ledStripMat = new THREE.MeshStandardMaterial({
      color: teamColorHex,
      emissive: baseLedColor.clone(),
      emissiveIntensity: 1.6,
      roughness: 0.2,
    });

    this.materials.push(postMat, stanchionMat, ledStripMat);

    // Left and Right main vertical goalposts
    const postGeo = new THREE.CylinderGeometry(postRadius, postRadius, gh, 16);
    const crossbarGeo = new THREE.CylinderGeometry(
      postRadius,
      postRadius,
      gw + postRadius * 2,
      16
    );
    crossbarGeo.rotateZ(Math.PI / 2);
    const cornerJointGeo = new THREE.SphereGeometry(postRadius * 1.12, 12, 12);

    this.geometries.push(postGeo, crossbarGeo, cornerJointGeo);

    for (const sx of [-1, 1]) {
      const px = sx * halfW;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, gh / 2, goalZ);
      post.castShadow = true;
      post.receiveShadow = true;
      goalGroup.add(post);

      const joint = new THREE.Mesh(cornerJointGeo, postMat);
      joint.position.set(px, gh, goalZ);
      goalGroup.add(joint);

      // Glowing team-colored collar ring at base of goalpost
      const collarGeo = new THREE.CylinderGeometry(
        postRadius * 1.28,
        postRadius * 1.35,
        0.38,
        14
      );
      const collar = new THREE.Mesh(collarGeo, ledStripMat);
      collar.position.set(px, 0.19, goalZ);
      goalGroup.add(collar);
      this.geometries.push(collarGeo);

      // Rear D-frame stanchion supports (top depth bar, bottom ground frame, diagonal strut)
      const topSupportGeo = new THREE.CylinderGeometry(0.045, 0.045, gd, 8);
      topSupportGeo.rotateX(Math.PI / 2);
      const topSupport = new THREE.Mesh(topSupportGeo, stanchionMat);
      topSupport.position.set(px, gh - 0.04, goalZ + outwardSignZ * (gd / 2));
      goalGroup.add(topSupport);

      const bottomSupportGeo = new THREE.CylinderGeometry(0.05, 0.05, gd, 8);
      bottomSupportGeo.rotateX(Math.PI / 2);
      const bottomSupport = new THREE.Mesh(bottomSupportGeo, stanchionMat);
      bottomSupport.position.set(px, 0.05, goalZ + outwardSignZ * (gd / 2));
      goalGroup.add(bottomSupport);

      const backVerticalGeo = new THREE.CylinderGeometry(0.045, 0.045, gh, 8);
      const backVertical = new THREE.Mesh(backVerticalGeo, stanchionMat);
      backVertical.position.set(px, gh / 2, backZ);
      goalGroup.add(backVertical);

      this.geometries.push(topSupportGeo, bottomSupportGeo, backVerticalGeo);
    }

    // Main horizontal crossbar
    const crossbar = new THREE.Mesh(crossbarGeo, postMat);
    crossbar.position.set(0, gh, goalZ);
    crossbar.castShadow = true;
    goalGroup.add(crossbar);

    // Rear top and bottom frame bars
    const rearBarGeo = new THREE.CylinderGeometry(0.05, 0.05, gw, 10);
    rearBarGeo.rotateZ(Math.PI / 2);
    const rearTopBar = new THREE.Mesh(rearBarGeo, stanchionMat);
    rearTopBar.position.set(0, gh - 0.04, backZ);
    goalGroup.add(rearTopBar);

    const rearBottomBar = new THREE.Mesh(rearBarGeo, stanchionMat);
    rearBottomBar.position.set(0, 0.05, backZ);
    goalGroup.add(rearBottomBar);
    this.geometries.push(rearBarGeo);

    // Net Material
    const netMat = new THREE.MeshStandardMaterial({
      map: this.netTexture,
      color: 0xf1f5f9,
      emissive: 0xdbeafe,
      emissiveIntensity: 0.22,
      roughness: 0.55,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.materials.push(netMat);

    const panels: NetPanelData[] = [];

    // Helper to build a subdivided net panel and precompute its rest world coordinates & edge weights
    const addNetPanel = (
      width: number,
      height: number,
      segsX: number,
      segsY: number,
      pos: THREE.Vector3,
      rotY: number,
      rotX: number,
      localOutwardNormal: THREE.Vector3
    ) => {
      const geo = new THREE.PlaneGeometry(width, height, segsX, segsY);
      const mesh = new THREE.Mesh(geo, netMat);
      mesh.position.copy(pos);
      mesh.rotation.set(rotX, rotY, 0);
      mesh.updateMatrixWorld(true);
      goalGroup.add(mesh);
      this.geometries.push(geo);

      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      const count = posAttr.count;
      const baseLocalPositions = new Float32Array(posAttr.array.length);
      baseLocalPositions.set(posAttr.array);

      const worldRestPositions = new Float32Array(count * 3);
      const edgeWeights = new Float32Array(count);
      const tempV = new THREE.Vector3();

      for (let i = 0; i < count; i++) {
        tempV.fromBufferAttribute(posAttr, i);
        tempV.applyMatrix4(mesh.matrixWorld);
        worldRestPositions[i * 3] = tempV.x;
        worldRestPositions[i * 3 + 1] = tempV.y;
        worldRestPositions[i * 3 + 2] = tempV.z;

        // Pin vertices along the front goalposts/crossbar and ground so net stays attached
        const distFromGoalMouth = Math.abs(tempV.z - goalZ);
        const mouthPin = THREE.MathUtils.smoothstep(distFromGoalMouth, 0.05, 0.55);
        const groundPin = THREE.MathUtils.smoothstep(tempV.y, 0.04, 0.45);
        const topCornerPin =
          1.0 -
          0.35 *
            THREE.MathUtils.smoothstep(Math.abs(tempV.x), halfW - 0.35, halfW) *
            THREE.MathUtils.smoothstep(tempV.y, gh - 0.35, gh);

        edgeWeights[i] = Math.max(0.08, mouthPin * groundPin * topCornerPin);
      }

      panels.push({
        geometry: geo,
        baseLocalPositions,
        worldRestPositions,
        edgeWeights,
        localNormal: localOutwardNormal.clone().normalize(),
      });
    };

    // 1. Back Net Panel at Z = backZ
    addNetPanel(
      gw,
      gh,
      20,
      10,
      new THREE.Vector3(0, gh / 2, backZ),
      0,
      0,
      new THREE.Vector3(0, 0, outwardSignZ)
    );

    // 2. Top Roof Net Panel at Y = gh
    addNetPanel(
      gw,
      gd,
      18,
      8,
      new THREE.Vector3(0, gh, goalZ + outwardSignZ * (gd / 2)),
      0,
      -Math.PI / 2,
      new THREE.Vector3(0, 0, 1) // local +Z points upward (+Y) when rotated X by -PI/2
    );

    // 3. Left Side Net Panel at X = -halfW
    addNetPanel(
      gd,
      gh,
      10,
      10,
      new THREE.Vector3(-halfW, gh / 2, goalZ + outwardSignZ * (gd / 2)),
      Math.PI / 2,
      0,
      new THREE.Vector3(0, 0, -1) // local -Z points toward -X when rotated Y by +PI/2
    );

    // 4. Right Side Net Panel at X = +halfW
    addNetPanel(
      gd,
      gh,
      10,
      10,
      new THREE.Vector3(halfW, gh / 2, goalZ + outwardSignZ * (gd / 2)),
      Math.PI / 2,
      0,
      new THREE.Vector3(0, 0, 1) // local +Z points toward +X when rotated Y by +PI/2
    );

    this.group.add(goalGroup);

    return {
      defendingTeam,
      goalZ,
      outwardSignZ,
      panels,
      ripples: [],
      ledStripMat,
      baseLedColor,
      flashTimer: 0,
    };
  }

  public triggerGoalNetRipple(side: TeamId, impactPos: Vec3): void {
    // Select goal intelligently: if impactPos.z clearly indicates North (-Z) or South (+Z),
    // ripple that physical goal; otherwise fall back to matching team side.
    let targetGoal: GoalInstance | undefined;
    if (Math.abs(impactPos.z) > 4) {
      const targetSign = impactPos.z < 0 ? -1 : 1;
      targetGoal = this.goals.find((g) => g.outwardSignZ === targetSign);
    }
    if (!targetGoal) {
      targetGoal =
        this.goals.find((g) => g.defendingTeam === side) ?? this.goals[0];
    }

    const halfW = this.config.goalWidth / 2;
    const clampedX = THREE.MathUtils.clamp(impactPos.x, -halfW, halfW);
    const clampedY = THREE.MathUtils.clamp(
      impactPos.y,
      0.3,
      this.config.goalHeight - 0.2
    );
    const netZ =
      targetGoal.goalZ + targetGoal.outwardSignZ * (this.config.goalDepth * 0.78);

    targetGoal.ripples.push({
      origin: new THREE.Vector3(clampedX, clampedY, netZ),
      age: 0,
      duration: 1.75,
      amplitude: 0.78,
    });
    targetGoal.flashTimer = 1.6;
  }

  public update(dt: number, elapsed: number): void {
    for (const goal of this.goals) {
      // Advance and prune active ripples
      for (let r = goal.ripples.length - 1; r >= 0; r--) {
        goal.ripples[r].age += dt;
        if (goal.ripples[r].age >= goal.ripples[r].duration) {
          goal.ripples.splice(r, 1);
        }
      }

      // Goalpost LED collar flash on impact
      if (goal.flashTimer > 0) {
        goal.flashTimer = Math.max(0, goal.flashTimer - dt);
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 22.0);
        goal.ledStripMat.emissiveIntensity = 1.6 + pulse * 3.0;
      } else {
        goal.ledStripMat.emissiveIntensity = 1.6;
      }

      // Displace net panel vertices (ambient night breeze + active goal impact ripples)
      for (const panel of goal.panels) {
        const posAttr = panel.geometry.attributes
          .position as THREE.BufferAttribute;
        const arr = posAttr.array as Float32Array;
        const base = panel.baseLocalPositions;
        const worldRest = panel.worldRestPositions;
        const weights = panel.edgeWeights;
        const nx = panel.localNormal.x;
        const ny = panel.localNormal.y;
        const nz = panel.localNormal.z;

        for (let i = 0; i < posAttr.count; i++) {
          const ix = i * 3;
          const wx = worldRest[ix];
          const wy = worldRest[ix + 1];
          const wz = worldRest[ix + 2];
          const weight = weights[i];

          // Subtle ambient stadium breeze
          let disp =
            Math.sin(elapsed * 2.4 + wx * 0.7 + wy * 1.1 + wz * 0.5) *
            0.022 *
            weight;

          // Sum spring-wave displacements from any active ball impacts
          for (let r = 0; r < goal.ripples.length; r++) {
            const rip = goal.ripples[r];
            const dx = wx - rip.origin.x;
            const dy = wy - rip.origin.y;
            const dz = wz - rip.origin.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            const radialFalloff = Math.exp(-dist * 0.38);
            const timeDecay = Math.exp(-rip.age * 2.55);
            const springWave = Math.sin(rip.age * 24.0 - dist * 2.4);
            const outwardBillow =
              Math.max(0, Math.sin(rip.age * 11.0 - dist * 1.1)) * 0.55;

            disp +=
              (springWave * 0.55 + outwardBillow) *
              rip.amplitude *
              radialFalloff *
              timeDecay *
              weight;
          }

          arr[ix] = base[ix] + nx * disp;
          arr[ix + 1] = base[ix + 1] + ny * disp;
          arr[ix + 2] = base[ix + 2] + nz * disp;
        }

        posAttr.needsUpdate = true;
      }
    }
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries = [];
    this.materials = [];
    this.textures = [];
    this.goals = [];
  }
}
