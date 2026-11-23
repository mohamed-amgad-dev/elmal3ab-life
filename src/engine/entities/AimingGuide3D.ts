import * as THREE from 'three';
import type { AimingGuideParams, IAimingGuide } from '../../types/engine';

const ARC_POINTS = 28;
const GRAVITY = 26.0;
const AIR_DRAG = 0.34;
const MAGNUS_PREVIEW = 0.042;
const BALL_RADIUS = 0.42;

/**
 * 3D precision aiming indicator:
 * - Ground directional arrow extending from the active player's feet along `aimDir`
 * - Live 3D curved Magnus-spin shot preview arc + landing reticle while charging LMB/E
 * - Pass-target highlight ring under the aimed teammate
 */
export class AimingGuide3D implements IAimingGuide {
  public readonly group: THREE.Group;

  private readonly arrowPivot: THREE.Group;
  private readonly shaftMesh: THREE.Mesh;
  private readonly shaftMat: THREE.MeshBasicMaterial;
  private readonly headMesh: THREE.Mesh;
  private readonly headMat: THREE.MeshBasicMaterial;
  private readonly baseRingMesh: THREE.Mesh;
  private readonly baseRingMat: THREE.MeshBasicMaterial;

  private readonly arcPositions: Float32Array;
  private readonly arcGeo: THREE.BufferGeometry;
  private readonly arcLine: THREE.Line;
  private readonly arcMat: THREE.LineBasicMaterial;
  private readonly impactRing: THREE.Mesh;
  private readonly impactRingMat: THREE.MeshBasicMaterial;

  private readonly passRing: THREE.Mesh;
  private readonly passRingMat: THREE.MeshBasicMaterial;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'aiming_guide_3d';
    this.group.visible = false;

    this.arrowPivot = new THREE.Group();
    this.arrowPivot.position.y = 0.065;
    this.group.add(this.arrowPivot);

    // Subtle directional foot ring
    const baseRingGeo = this.track(new THREE.RingGeometry(0.68, 0.84, 32));
    baseRingGeo.rotateX(-Math.PI / 2);
    this.baseRingMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.baseRingMesh = new THREE.Mesh(baseRingGeo, this.baseRingMat);
    this.baseRingMesh.renderOrder = 5;
    this.arrowPivot.add(this.baseRingMesh);

    // Shaft along +Z (unit length 1 so scaling Z extends cleanly)
    const shaftGeo = this.track(new THREE.PlaneGeometry(0.36, 1));
    shaftGeo.rotateX(-Math.PI / 2);
    shaftGeo.translate(0, 0, 0.5);
    this.shaftMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x00f5ff,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.shaftMesh = new THREE.Mesh(shaftGeo, this.shaftMat);
    this.shaftMesh.renderOrder = 6;
    this.arrowPivot.add(this.shaftMesh);

    // Sharp chevron arrowhead pointing +Z
    const headShape = new THREE.Shape();
    headShape.moveTo(0, 0.82);
    headShape.lineTo(0.62, -0.24);
    headShape.lineTo(0.22, -0.06);
    headShape.lineTo(0, -0.15);
    headShape.lineTo(-0.22, -0.06);
    headShape.lineTo(-0.62, -0.24);
    headShape.closePath();

    const headGeo = this.track(new THREE.ShapeGeometry(headShape));
    headGeo.rotateX(Math.PI / 2);
    this.headMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x00f5ff,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.headMesh = new THREE.Mesh(headGeo, this.headMat);
    this.headMesh.renderOrder = 6;
    this.arrowPivot.add(this.headMesh);

    // Live 3D curved shot trajectory arc
    this.arcPositions = new Float32Array(ARC_POINTS * 3);
    this.arcGeo = this.track(new THREE.BufferGeometry());
    this.arcGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.arcPositions, 3)
    );
    this.arcMat = this.track(
      new THREE.LineBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      })
    );
    this.arcLine = new THREE.Line(this.arcGeo, this.arcMat);
    this.arcLine.frustumCulled = false;
    this.arcLine.visible = false;
    this.arcLine.renderOrder = 7;
    this.group.add(this.arcLine);

    // Endpoint / impact target ring
    const impactGeo = this.track(new THREE.RingGeometry(0.32, 0.54, 24));
    impactGeo.rotateX(-Math.PI / 2);
    this.impactRingMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.impactRing = new THREE.Mesh(impactGeo, this.impactRingMat);
    this.impactRing.visible = false;
    this.impactRing.renderOrder = 7;
    this.group.add(this.impactRing);

    // Pass target teammate ring
    const passGeo = this.track(new THREE.RingGeometry(0.65, 0.9, 28));
    passGeo.rotateX(-Math.PI / 2);
    this.passRingMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.passRing = new THREE.Mesh(passGeo, this.passRingMat);
    this.passRing.visible = false;
    this.passRing.renderOrder = 6;
    this.group.add(this.passRing);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  update(params: AimingGuideParams): void {
    if (!params.visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const dirLen = Math.hypot(params.aimDir.x, params.aimDir.z);
    const nx = dirLen > 1e-4 ? params.aimDir.x / dirLen : 0;
    const nz = dirLen > 1e-4 ? params.aimDir.z / dirLen : 1;
    const yaw = Math.atan2(nx, nz);

    this.arrowPivot.position.set(params.playerPos.x, 0.065, params.playerPos.z);
    this.arrowPivot.rotation.y = yaw;

    // Color & scale by charge precision zone
    const c = Math.max(0, Math.min(1, params.charge));
    let colorHex = 0x00e5ff;
    let pulseScale = 1.0;

    if (params.isCharging) {
      if (c >= 0.72 && c <= 0.88) {
        // Sweet Spot: glowing emerald-gold!
        colorHex = 0x34d399;
        pulseScale = 1.15 + Math.sin(params.elapsed * 24) * 0.08;
      } else if (c > 0.88) {
        // Overcharge: hot crimson warning
        colorHex = 0xff2e4c;
        pulseScale = 1.06 + Math.sin(params.elapsed * 30) * 0.06;
      } else {
        // Building power: warm gold
        colorHex = 0xfbbf24;
      }
    }

    const totalLen = params.isCharging ? 7.2 + c * 4.0 : 6.6;
    const shaftStart = 0.96;
    const shaftLen = Math.max(2.0, totalLen - shaftStart - 0.72);

    this.shaftMesh.position.set(0, 0, shaftStart);
    this.shaftMesh.scale.set(params.isCharging ? 1.28 * pulseScale : 1.0, 1, shaftLen);
    this.headMesh.position.set(0, 0.005, shaftStart + shaftLen + 0.15);
    this.headMesh.scale.setScalar((params.isCharging ? 1.25 : 0.95) * pulseScale);

    this.shaftMat.color.setHex(colorHex);
    this.headMat.color.setHex(colorHex);
    this.baseRingMat.color.setHex(params.isCharging ? colorHex : params.teamColor);
    this.baseRingMat.opacity = params.isCharging ? 0.85 : 0.55;

    // Pass target highlight ring
    if (params.passTargetPos && !params.isCharging) {
      this.passRing.visible = true;
      const ringPulse = 1 + Math.sin(params.elapsed * 7) * 0.1;
      this.passRing.position.set(params.passTargetPos.x, 0.07, params.passTargetPos.z);
      this.passRing.scale.set(ringPulse, ringPulse, 1);
      this.passRingMat.opacity = 0.65 + Math.sin(params.elapsed * 7) * 0.2;
    } else {
      this.passRing.visible = false;
    }

    // Live 3D curved shot trajectory preview while charging!
    if (params.isCharging) {
      const isSweet = c >= 0.72 && c <= 0.88;
      const isOver = c > 0.88;
      const speedMult = isSweet ? 1.22 : 1.0;
      const speed = (18 + c * 18) * speedMult;
      const liftVel = 3.2 + c * 5.8 + (isOver ? 5.2 : 0);
      const curlSpinY = (isSweet ? 22 : 14) * params.curl;

      let sx = params.ballPos.x;
      let sy = Math.max(BALL_RADIUS, params.ballPos.y);
      let sz = params.ballPos.z;
      let vx = nx * speed;
      let vy = liftVel;
      let vz = nz * speed;
      let spy = curlSpinY;

      const simDt = 0.036;
      let endX = sx;
      let endY = sy;
      let endZ = sz;

      for (let i = 0; i < ARC_POINTS; i++) {
        this.arcPositions[i * 3] = sx;
        this.arcPositions[i * 3 + 1] = Math.max(0.09, sy);
        this.arcPositions[i * 3 + 2] = sz;
        endX = sx;
        endY = sy;
        endZ = sz;

        vy -= GRAVITY * simDt;
        // Magnus lateral bend from spin.y
        vx += spy * vz * MAGNUS_PREVIEW * simDt;
        vz += -spy * vx * MAGNUS_PREVIEW * simDt;

        const airF = Math.exp(-AIR_DRAG * simDt);
        vx *= airF;
        vz *= airF;
        spy *= Math.exp(-0.9 * simDt);

        sx += vx * simDt;
        sy += vy * simDt;
        sz += vz * simDt;

        if (sy < BALL_RADIUS) {
          sy = BALL_RADIUS;
          vy = Math.abs(vy) * 0.58;
        }
      }

      this.arcLine.visible = true;
      this.arcGeo.setDrawRange(0, ARC_POINTS);
      (this.arcGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.arcMat.color.setHex(colorHex);

      this.impactRing.visible = true;
      this.impactRing.position.set(endX, Math.max(0.08, endY * 0.15 + 0.08), endZ);
      this.impactRing.scale.setScalar(1.1 * pulseScale);
      this.impactRingMat.color.setHex(colorHex);
    } else {
      this.arcLine.visible = false;
      this.impactRing.visible = false;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
