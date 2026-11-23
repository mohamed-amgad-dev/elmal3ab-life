import * as THREE from 'three';

export type FPDiveState = 'none' | 'left' | 'right' | 'catch';

/**
 * Stylized First-Person oversized padded goalkeeper gloves rendered relative
 * to the active camera during `gk_first_person` mode.
 *
 * Uses camera world transform directly so it renders reliably whether or not
 * the camera itself is mounted in the Three.js scene graph.
 */
export class GoalkeeperGlovesFP {
  public readonly root: THREE.Group;

  private readonly leftGlove: THREE.Group;
  private readonly rightGlove: THREE.Group;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private elapsed = 0;
  private currentBlendLeft = 0;
  private currentBlendRight = 0;
  private currentBlendCatch = 0;

  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();

  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'fp_gk_gloves';
    this.root.visible = false;

    this.leftGlove = this.buildSingleGlove(true);
    this.rightGlove = this.buildSingleGlove(false);

    this.root.add(this.leftGlove);
    this.root.add(this.rightGlove);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildSingleGlove(isLeft: boolean): THREE.Group {
    const sign = isLeft ? -1 : 1; // In camera local space: -X is left, +X is right
    const group = new THREE.Group();

    const latexMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        emissive: 0x0f172a,
        emissiveIntensity: 0.15,
        roughness: 0.45,
        metalness: 0.04,
      })
    );
    const neonBackMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xa3ff12,
        emissive: 0x3b7a00,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.12,
      })
    );
    const strapMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.5,
        metalness: 0.1,
      })
    );
    const gripDotMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
      })
    );

    // Padded palm
    const palmGeo = this.track(new THREE.BoxGeometry(0.17, 0.19, 0.065));
    const palm = new THREE.Mesh(palmGeo, latexMat);
    palm.renderOrder = 45;
    palm.frustumCulled = false;
    group.add(palm);

    // Neon backhand shell
    const backGeo = this.track(new THREE.BoxGeometry(0.18, 0.18, 0.03));
    const back = new THREE.Mesh(backGeo, neonBackMat);
    back.position.z = 0.036;
    back.renderOrder = 45;
    back.frustumCulled = false;
    group.add(back);

    // Grip chevrons on palm (facing viewer/ball)
    const gripGeo = this.track(new THREE.BoxGeometry(0.11, 0.018, 0.008));
    for (let i = 0; i < 3; i++) {
      const strip = new THREE.Mesh(gripGeo, gripDotMat);
      strip.position.set(0, -0.04 + i * 0.045, -0.035);
      strip.renderOrder = 46;
      strip.frustumCulled = false;
      group.add(strip);
    }

    // 4 Chunky padded fingers slightly splayed and curved forward
    const fingerGeo = this.track(new THREE.CapsuleGeometry(0.022, 0.075, 4, 8));
    const fingerOffsets = [-0.06, -0.02, 0.02, 0.06];
    const fingerHeights = [0.135, 0.152, 0.148, 0.128];
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(fingerGeo, latexMat);
      const xPos = fingerOffsets[i] * (isLeft ? 1 : -1);
      f.position.set(xPos, fingerHeights[i], -0.018);
      f.rotation.x = -0.28;
      f.rotation.z = -xPos * 2.2;
      f.renderOrder = 45;
      f.frustumCulled = false;
      group.add(f);
    }

    // Chunky thumb on inner side (pointing toward center of screen)
    const thumbGeo = this.track(new THREE.CapsuleGeometry(0.026, 0.065, 4, 8));
    const thumb = new THREE.Mesh(thumbGeo, neonBackMat);
    thumb.position.set(-sign * 0.105, 0.03, -0.02);
    thumb.rotation.z = sign * 0.68;
    thumb.rotation.x = -0.25;
    thumb.renderOrder = 45;
    thumb.frustumCulled = false;
    group.add(thumb);

    // Wrist cuff + strap
    const cuffGeo = this.track(new THREE.CylinderGeometry(0.078, 0.088, 0.13, 12));
    const cuff = new THREE.Mesh(cuffGeo, strapMat);
    cuff.position.set(0, -0.15, 0.01);
    cuff.renderOrder = 45;
    cuff.frustumCulled = false;
    group.add(cuff);

    const cuffTrimGeo = this.track(new THREE.CylinderGeometry(0.084, 0.084, 0.032, 12));
    const cuffTrim = new THREE.Mesh(cuffTrimGeo, neonBackMat);
    cuffTrim.position.set(0, -0.12, 0.01);
    cuffTrim.renderOrder = 46;
    cuffTrim.frustumCulled = false;
    group.add(cuffTrim);

    return group;
  }

  public update(
    camera: THREE.Camera,
    active: boolean,
    diveState: FPDiveState,
    dt: number
  ): void {
    this.root.visible = active;
    if (!active) {
      return;
    }

    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    this.elapsed += safeDt;

    // Sync root transform cleanly to camera world transform
    camera.updateMatrixWorld();
    camera.matrixWorld.decompose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.root.position.copy(this.tmpPos);
    this.root.quaternion.copy(this.tmpQuat);

    // Smooth blend factors for snappy yet silky transitions
    const lerpRate = 1 - Math.exp(-16 * safeDt);
    this.currentBlendLeft += ((diveState === 'left' ? 1 : 0) - this.currentBlendLeft) * lerpRate;
    this.currentBlendRight += ((diveState === 'right' ? 1 : 0) - this.currentBlendRight) * lerpRate;
    this.currentBlendCatch += ((diveState === 'catch' ? 1 : 0) - this.currentBlendCatch) * lerpRate;

    // Subtle ready-stance breathing sway
    const idleFactor = Math.max(
      0,
      1 - Math.max(this.currentBlendLeft, this.currentBlendRight, this.currentBlendCatch)
    );
    const breathY = Math.sin(this.elapsed * 3.1) * 0.018 * idleFactor;
    const swayX = Math.sin(this.elapsed * 1.8) * 0.012 * idleFactor;

    // Base ready position in camera space (-Z is forward!)
    const baseZ = -0.68;
    const baseY = -0.26 + breathY;
    const baseSpreadX = 0.30;

    // Lateral dive reach (-X = left, +X = right)
    const diveShiftX = -0.34 * this.currentBlendLeft + 0.34 * this.currentBlendRight;
    const diveForwardZ = -0.14 * (this.currentBlendLeft + this.currentBlendRight);
    const diveRaiseY = 0.08 * (this.currentBlendLeft + this.currentBlendRight);
    const diveRollZ = 0.55 * this.currentBlendLeft - 0.55 * this.currentBlendRight;

    // Catch punch: snap inward & forward, cupped tightly together!
    const catchInward = 0.17 * this.currentBlendCatch;
    const catchForwardZ = -0.16 * this.currentBlendCatch;
    const catchRaiseY = 0.12 * this.currentBlendCatch;

    // Left Glove (-X side)
    this.leftGlove.position.set(
      -baseSpreadX + swayX + diveShiftX + catchInward,
      baseY + diveRaiseY + catchRaiseY + 0.05 * this.currentBlendLeft,
      baseZ + diveForwardZ + catchForwardZ
    );
    this.leftGlove.rotation.set(
      -0.25 - 0.35 * this.currentBlendCatch,
      0.38 + 0.45 * this.currentBlendCatch - 0.25 * this.currentBlendLeft,
      -0.16 + diveRollZ + 0.18 * this.currentBlendCatch
    );

    // Right Glove (+X side)
    this.rightGlove.position.set(
      baseSpreadX + swayX + diveShiftX - catchInward,
      baseY + diveRaiseY + catchRaiseY + 0.05 * this.currentBlendRight,
      baseZ + diveForwardZ + catchForwardZ
    );
    this.rightGlove.rotation.set(
      -0.25 - 0.35 * this.currentBlendCatch,
      -0.38 - 0.45 * this.currentBlendCatch + 0.25 * this.currentBlendRight,
      0.16 + diveRollZ - 0.18 * this.currentBlendCatch
    );
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
