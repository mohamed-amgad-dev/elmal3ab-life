import * as THREE from 'three';
import type { TeamId } from '../../types/game';
import type { StadiumConfig } from '../../types/stadium';
import { VolumetricLights } from './VolumetricLights';

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform vec3 uHorizonGlow;
  uniform float uTime;

  varying vec3 vWorldPos;

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 dir = normalize(vWorldPos);
    float elevation = clamp(dir.y, 0.0, 1.0);

    // Smooth vertical gradient from horizon indigo to deep night zenith
    float horizonFactor = pow(1.0 - elevation, 2.4);
    vec3 skyColor = mix(uSkyTop, uSkyHorizon, horizonFactor);

    // Subtle warm-magenta/cyan stadium & Cairo night city glow band near the horizon
    float glowBand = exp(-pow((dir.y - 0.06) * 8.5, 2.0));
    skyColor += uHorizonGlow * glowBand * 0.28;

    // Procedural twinkling stars in upper sky dome
    if (dir.y > 0.12) {
      vec3 starCell = floor(dir * 260.0);
      float n = hash13(starCell);
      if (n > 0.9915) {
        float phase = hash13(starCell + 19.7) * 6.2831;
        float twinkle = 0.55 + 0.45 * sin(uTime * (2.2 + fract(n * 53.0) * 3.0) + phase);
        float starMask = smoothstep(0.12, 0.38, dir.y);
        float brightness = smoothstep(0.9915, 0.9995, n) * twinkle * starMask;
        skyColor += vec3(0.85, 0.92, 1.0) * brightness * 1.45;
      }
    }

    gl_FragColor = vec4(skyColor, 1.0);
  }
`;

export class NightLighting {
  public readonly group: THREE.Group;
  private config: StadiumConfig;
  private volumetric: VolumetricLights;
  private skyMaterial: THREE.ShaderMaterial;
  private spotLights: THREE.SpotLight[] = [];
  private ledBankMaterials: THREE.MeshStandardMaterial[] = [];
  private towerAccentMaterials: THREE.MeshStandardMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];

  private baseLedColor = new THREE.Color(0xf0f7ff);
  private baseAccentColor = new THREE.Color(0x00e5ff);
  private tempCelebrationColor = new THREE.Color();

  constructor(config: StadiumConfig) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = 'NightLighting';

    this.skyMaterial = this.createSkyDome();
    this.createAmbientAndDirectionalLights();
    this.createFloodlightTowers();

    this.volumetric = new VolumetricLights(config.floodlightTowers, 28.5);
    this.group.add(this.volumetric.group);
  }

  private createSkyDome(): THREE.ShaderMaterial {
    const skyGeo = new THREE.SphereGeometry(220, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      uniforms: {
        uSkyTop: { value: new THREE.Color(this.config.colors.nightSkyTop) },
        uSkyHorizon: { value: new THREE.Color(this.config.colors.nightSkyHorizon) },
        uHorizonGlow: { value: new THREE.Color(0x3a1c71) },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });

    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.name = 'NightSkyDome';
    this.group.add(skyMesh);

    this.geometries.push(skyGeo);
    this.materials.push(skyMat);
    return skyMat;
  }

  private createAmbientAndDirectionalLights(): void {
    // Cool moonlit sky to rich emerald turf bounce
    const hemiLight = new THREE.HemisphereLight(0x557ce6, 0x0f331d, 0.85);
    hemiLight.position.set(0, 50, 0);
    this.group.add(hemiLight);

    const ambientLight = new THREE.AmbientLight(0x182542, 0.45);
    this.group.add(ambientLight);

    // Overhead stadium key directional light with crisp soft shadows over the entire pitch
    const dirLight = new THREE.DirectionalLight(0xeef5ff, 1.35);
    dirLight.position.set(22, 44, 18);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 6;
    dirLight.shadow.camera.far = 120;
    dirLight.shadow.camera.left = -28;
    dirLight.shadow.camera.right = 28;
    dirLight.shadow.camera.top = 40;
    dirLight.shadow.camera.bottom = -40;
    dirLight.shadow.bias = -0.0004;
    dirLight.shadow.normalBias = 0.02;
    this.group.add(dirLight);
    this.group.add(dirLight.target);
  }

  private createFloodlightTowers(): void {
    const towerHeight = 28.5;

    const pedestalGeo = new THREE.CylinderGeometry(1.55, 1.85, 3.2, 8);
    const mainMastGeo = new THREE.CylinderGeometry(0.48, 0.92, towerHeight, 10);
    const strutGeo = new THREE.CylinderGeometry(0.18, 0.24, towerHeight - 2, 6);
    const braceRingGeo = new THREE.TorusGeometry(0.88, 0.09, 6, 12);
    braceRingGeo.rotateX(Math.PI / 2);

    const headFrameGeo = new THREE.BoxGeometry(5.6, 3.4, 0.9);
    const visorGeo = new THREE.BoxGeometry(5.8, 0.25, 1.35);
    const ledBulbGeo = new THREE.BoxGeometry(1.12, 0.72, 0.18);
    const accentBarGeo = new THREE.BoxGeometry(5.5, 0.18, 0.22);

    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x262e3d,
      roughness: 0.85,
      metalness: 0.15,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x1a2232,
      roughness: 0.42,
      metalness: 0.78,
    });

    this.geometries.push(
      pedestalGeo,
      mainMastGeo,
      strutGeo,
      braceRingGeo,
      headFrameGeo,
      visorGeo,
      ledBulbGeo,
      accentBarGeo
    );
    this.materials.push(concreteMat, steelMat);

    this.config.floodlightTowers.forEach((pos, idx) => {
      const towerGroup = new THREE.Group();
      towerGroup.position.set(pos.x, 0, pos.z);

      // Concrete base pedestal
      const pedestal = new THREE.Mesh(pedestalGeo, concreteMat);
      pedestal.position.y = 1.6;
      pedestal.receiveShadow = true;
      towerGroup.add(pedestal);

      // Slightly inward-leaning main mast + twin structural lattice struts
      const mastCluster = new THREE.Group();
      const inwardAngleX = pos.z > 0 ? -0.05 : 0.05;
      const inwardAngleZ = pos.x > 0 ? 0.05 : -0.05;
      mastCluster.rotation.set(inwardAngleX, 0, inwardAngleZ);

      const mainMast = new THREE.Mesh(mainMastGeo, steelMat);
      mainMast.position.y = towerHeight / 2;
      mastCluster.add(mainMast);

      const leftStrut = new THREE.Mesh(strutGeo, steelMat);
      leftStrut.position.set(-0.65, towerHeight / 2, 0);
      mastCluster.add(leftStrut);

      const rightStrut = new THREE.Mesh(strutGeo, steelMat);
      rightStrut.position.set(0.65, towerHeight / 2, 0);
      mastCluster.add(rightStrut);

      // Horizontal structural lattice rings along the mast
      for (let h = 6; h <= 24; h += 4.5) {
        const ring = new THREE.Mesh(braceRingGeo, steelMat);
        ring.position.y = h;
        const scale = 1.15 - (h / towerHeight) * 0.35;
        ring.scale.set(scale, scale, 1);
        mastCluster.add(ring);
      }

      towerGroup.add(mastCluster);

      // Floodlight LED bank housing at top facing center pitch
      const headGroup = new THREE.Group();
      headGroup.position.set(
        -Math.sign(pos.x) * 1.4,
        towerHeight - 0.4,
        -Math.sign(pos.z) * 1.4
      );
      headGroup.lookAt(0, 2, 0);

      const frameMesh = new THREE.Mesh(headFrameGeo, steelMat);
      headGroup.add(frameMesh);

      const visorMesh = new THREE.Mesh(visorGeo, steelMat);
      visorMesh.position.set(0, 1.72, 0.35);
      headGroup.add(visorMesh);

      const ledMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: this.baseLedColor.clone(),
        emissiveIntensity: 3.1,
        roughness: 0.15,
      });
      this.ledBankMaterials.push(ledMat);
      this.materials.push(ledMat);

      // 4x3 high-intensity LED matrix
      const cols = 4;
      const rows = 3;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const bulb = new THREE.Mesh(ledBulbGeo, ledMat);
          const bx = (c - (cols - 1) / 2) * 1.28;
          const by = (r - (rows - 1) / 2) * 0.96;
          bulb.position.set(bx, by, 0.46);
          headGroup.add(bulb);
        }
      }

      const accentMat = new THREE.MeshStandardMaterial({
        color: 0x00e5ff,
        emissive: this.baseAccentColor.clone(),
        emissiveIntensity: 2.2,
        roughness: 0.2,
      });
      this.towerAccentMaterials.push(accentMat);
      this.materials.push(accentMat);

      const accentBar = new THREE.Mesh(accentBarGeo, accentMat);
      accentBar.position.set(0, -1.78, 0.42);
      headGroup.add(accentBar);

      towerGroup.add(headGroup);
      this.group.add(towerGroup);

      // Focused stadium SpotLight illuminating pitch quadrant
      const spot = new THREE.SpotLight(0xf3f8ff, 90);
      spot.position.set(
        pos.x * 0.94,
        towerHeight - 0.8,
        pos.z * 0.94
      );
      spot.target.position.set(pos.x * 0.18, 0, pos.z * 0.2);
      spot.angle = Math.PI / 3.0;
      spot.penumbra = 0.68;
      spot.decay = 1.15;
      spot.distance = 135;

      // Enable shadows on two diagonal towers for dramatic multi-shadow depth without GPU overload
      if (idx === 0 || idx === 3) {
        spot.castShadow = true;
        spot.shadow.mapSize.width = 1024;
        spot.shadow.mapSize.height = 1024;
        spot.shadow.camera.near = 10;
        spot.shadow.camera.far = 115;
        spot.shadow.bias = -0.0005;
      }

      this.spotLights.push(spot);
      this.group.add(spot);
      this.group.add(spot.target);
    });
  }

  public update(
    _dt: number,
    elapsed: number,
    celebrationTeam: TeamId | null = null,
    celebrationTimer = 0
  ): void {
    this.skyMaterial.uniforms.uTime.value = elapsed;

    if (celebrationTeam && celebrationTimer > 0) {
      const teamHex =
        celebrationTeam === 'red'
          ? this.config.colors.redTeam
          : this.config.colors.blueTeam;
      this.tempCelebrationColor.setHex(teamHex);

      // Rhythmic stadium show strobe pulse
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 14.0);

      for (let i = 0; i < this.spotLights.length; i++) {
        const spot = this.spotLights[i];
        const altPulse = i % 2 === 0 ? pulse : 1 - pulse * 0.6;
        spot.color
          .copy(this.baseLedColor)
          .lerp(this.tempCelebrationColor, altPulse * 0.65);
        spot.intensity = 90 + altPulse * 35;
      }

      for (const ledMat of this.ledBankMaterials) {
        ledMat.emissive
          .copy(this.baseLedColor)
          .lerp(this.tempCelebrationColor, pulse * 0.85);
        ledMat.emissiveIntensity = 3.1 + pulse * 1.8;
      }

      for (const accMat of this.towerAccentMaterials) {
        accMat.emissive.copy(this.tempCelebrationColor);
        accMat.emissiveIntensity = 2.4 + pulse * 2.0;
      }

      this.volumetric.update(elapsed, this.tempCelebrationColor, pulse);
    } else {
      for (const spot of this.spotLights) {
        spot.color.copy(this.baseLedColor);
        spot.intensity = 90;
      }
      for (const ledMat of this.ledBankMaterials) {
        ledMat.emissive.copy(this.baseLedColor);
        ledMat.emissiveIntensity = 3.1;
      }
      for (const accMat of this.towerAccentMaterials) {
        accMat.emissive.copy(this.baseAccentColor);
        accMat.emissiveIntensity = 2.2;
      }
      this.volumetric.update(elapsed, null, 0);
    }
  }

  public dispose(): void {
    this.volumetric.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
  }
}
