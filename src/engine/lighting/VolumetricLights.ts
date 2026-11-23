import * as THREE from 'three';
import type { Vec3 } from '../../types/game';

const VOLUMETRIC_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  varying float vWorldY;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldY = worldPos.y;

    vec4 mvPosition = viewMatrix * worldPos;
    vViewNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const VOLUMETRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  varying float vWorldY;

  void main() {
    // vUv.y is 1.0 at the floodlight emitter head and 0.0 at the far ground end
    float along = clamp(vUv.y, 0.0, 1.0);

    // Smooth entry near the lamp housing and soft fade out toward the turf
    float topCapFade = smoothstep(1.0, 0.90, along);
    float distanceFade = pow(along, 1.45) * smoothstep(0.0, 0.18, along);
    float groundCutoff = smoothstep(0.5, 4.5, vWorldY);

    // View-angle Fresnel softness so cylinder edges dissolve seamlessly into night air
    float ndotv = abs(dot(normalize(vViewNormal), normalize(vViewDir)));
    float radialSoftness = pow(ndotv, 1.85);

    // Subtle atmospheric stadium mist shimmer
    float mistWave = 0.92 + 0.08 * sin(vUv.x * 18.8495 + uTime * 1.4 + along * 6.0);

    float alpha = topCapFade * distanceFade * groundCutoff * radialSoftness * mistWave * uIntensity;
    gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 0.45));
  }
`;

export class VolumetricLights {
  public readonly group: THREE.Group;
  private materials: THREE.ShaderMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private baseColor = new THREE.Color(0xdceeff);

  constructor(towerPositions: Vec3[], towerHeight = 28.5) {
    this.group = new THREE.Group();
    this.group.name = 'VolumetricLights';

    towerPositions.forEach((tower, idx) => {
      const sourcePos = new THREE.Vector3(
        tower.x * 0.93,
        towerHeight - 0.8,
        tower.z * 0.93
      );
      const targetPos = new THREE.Vector3(
        tower.x * 0.18,
        0,
        tower.z * 0.2
      );

      // Outer wide atmospheric beam + inner concentrated core beam
      this.createConeBeam(sourcePos, targetPos, 1.8, 14.5, 0.15, idx * 1.3);
      this.createConeBeam(sourcePos, targetPos, 0.95, 7.2, 0.19, idx * 1.3 + 0.7);
    });
  }

  private createConeBeam(
    sourcePos: THREE.Vector3,
    targetPos: THREE.Vector3,
    topRadius: number,
    bottomRadius: number,
    baseIntensity: number,
    timeOffset: number
  ): void {
    const length = sourcePos.distanceTo(targetPos) * 0.96;
    const geom = new THREE.CylinderGeometry(
      topRadius,
      bottomRadius,
      length,
      28,
      1,
      true
    );

    // Shift top cap to origin and orient beam down +Z so lookAt(targetPos) aligns it
    geom.translate(0, -length / 2, 0);
    geom.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_VERTEX_SHADER,
      fragmentShader: VOLUMETRIC_FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: this.baseColor.clone() },
        uIntensity: { value: baseIntensity },
        uTime: { value: timeOffset },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(sourcePos);
    mesh.lookAt(targetPos);
    mesh.renderOrder = 2;

    this.geometries.push(geom);
    this.materials.push(mat);
    this.group.add(mesh);
  }

  public update(elapsed: number, celebrationColor?: THREE.Color | null, celebrationPulse = 0): void {
    for (let i = 0; i < this.materials.length; i++) {
      const mat = this.materials[i];
      mat.uniforms.uTime.value = elapsed + i * 0.6;
      const isInner = i % 2 === 1;
      const baseInt = isInner ? 0.19 : 0.15;

      if (celebrationColor && celebrationPulse > 0.01) {
        (mat.uniforms.uColor.value as THREE.Color)
          .copy(this.baseColor)
          .lerp(celebrationColor, celebrationPulse * 0.75);
        mat.uniforms.uIntensity.value = baseInt * (1 + celebrationPulse * 0.55);
      } else {
        (mat.uniforms.uColor.value as THREE.Color).copy(this.baseColor);
        mat.uniforms.uIntensity.value = baseInt;
      }
    }
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
  }
}
