import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const HUMANOID_MODEL_URL = '/models/player_humanoid.glb';
const TARGET_PLAYER_HEIGHT_M = 1.82;

export interface LoadedHumanoidTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  targetScale: number;
  groundOffsetY: number;
}

export interface ClonedHumanoidInstance {
  /** Normalized root group: feet at y = 0, facing +Z, height ≈ 1.82m. */
  root: THREE.Group;
  /** The cloned GLTF scene inside root (shifted & scaled). */
  modelRoot: THREE.Object3D;
  /** Cloned animation clips (referenced from template). */
  animations: THREE.AnimationClip[];
  /** All cloned SkinnedMeshes with independent cloned materials. */
  skinnedMeshes: THREE.SkinnedMesh[];
  /** Resilient normalized bone map: keys stripped of `mixamorig:` / `mixamorig`. */
  bones: Map<string, THREE.Bone>;
  /** Bind-time local rest quaternions keyed by normalized bone name. */
  restQuats: Map<string, THREE.Quaternion>;
  /** Bind-time local rest positions keyed by normalized bone name. */
  restPositions: Map<string, THREE.Vector3>;
  /** Scale multiplier to convert meter-sized props into bone-local space (Mixamo Armature uses 0.01). */
  bonePropScale: number;
  /** Cloned per-instance materials that must be disposed when removing the character. */
  materialDisposables: THREE.Material[];
}

export interface FallbackHumanoidResult {
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
}

let cachedTemplate: LoadedHumanoidTemplate | null = null;
let loadingPromise: Promise<LoadedHumanoidTemplate> | null = null;
let loadFailed = false;
const readyListeners = new Set<(template: LoadedHumanoidTemplate) => void>();

/**
 * Strips Mixamo prefixes (`mixamorig:` or Three.js-sanitized `mixamorig`)
 * so bone lookups succeed identically across GLTFLoader versions.
 */
export function normalizeMixamoBoneName(rawName: string): string {
  return rawName.replace(/^mixamorig:?/i, '');
}

/**
 * Loads `/models/player_humanoid.glb` once via GLTFLoader, computes normalized
 * height (~1.82m) and ground offset (feet at y = 0), and caches the result.
 */
export function preloadHumanoidModel(): Promise<LoadedHumanoidTemplate> {
  if (cachedTemplate) {
    return Promise.resolve(cachedTemplate);
  }
  if (loadingPromise) {
    return loadingPromise;
  }

  const loader = new GLTFLoader();
  loadingPromise = loader
    .loadAsync(HUMANOID_MODEL_URL)
    .then((gltf) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);

      // Compute true mesh bounding box in scene space to ground feet at y = 0 and scale to 1.82m
      const box = new THREE.Box3();
      let foundMesh = false;
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          if (!mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox();
          }
          if (mesh.geometry.boundingBox) {
            const meshBox = mesh.geometry.boundingBox.clone();
            meshBox.applyMatrix4(mesh.matrixWorld);
            if (!foundMesh) {
              box.copy(meshBox);
              foundMesh = true;
            } else {
              box.union(meshBox);
            }
          }
        }
      });

      let targetScale = 1.0;
      let groundOffsetY = 0;

      if (foundMesh && !box.isEmpty()) {
        const rawHeight = box.max.y - box.min.y;
        if (rawHeight > 0.25 && rawHeight < 500) {
          targetScale = TARGET_PLAYER_HEIGHT_M / rawHeight;
          groundOffsetY = -box.min.y * targetScale;
        }
      }

      const template: LoadedHumanoidTemplate = {
        scene,
        animations: gltf.animations ?? [],
        targetScale,
        groundOffsetY,
      };

      cachedTemplate = template;
      loadFailed = false;

      for (const listener of Array.from(readyListeners)) {
        try {
          listener(template);
        } catch {
          // Isolate per-character swap errors
        }
      }
      readyListeners.clear();

      return template;
    })
    .catch((err) => {
      loadFailed = true;
      loadingPromise = null;
      console.warn('[HumanoidModelLoader] Failed to load humanoid GLB, keeping fallback:', err);
      throw err;
    });

  return loadingPromise;
}

/**
 * Synchronous accessor returning the cached template if already resolved.
 */
export function getCachedHumanoidTemplate(): LoadedHumanoidTemplate | null {
  return cachedTemplate;
}

/**
 * Returns true if the GLB load previously failed (so callers can skip waiting).
 */
export function hasHumanoidLoadFailed(): boolean {
  return loadFailed;
}

/**
 * Registers a callback invoked as soon as the GLB template finishes loading.
 * Triggers preload automatically if not yet started. Returns an unsubscribe handle.
 */
export function onHumanoidModelReady(
  cb: (template: LoadedHumanoidTemplate) => void
): () => void {
  if (cachedTemplate) {
    cb(cachedTemplate);
    return () => {};
  }

  readyListeners.add(cb);
  if (!loadingPromise && !loadFailed) {
    preloadHumanoidModel().catch(() => {
      // Fallback remains active if network/asset fails
    });
  }

  return () => {
    readyListeners.delete(cb);
  };
}

/**
 * Creates an independent rigged humanoid instance using `SkeletonUtils.clone`,
 * cloning materials per character, enabling shadow casting/receiving, normalizing
 * height to ~1.82m with feet at y = 0, and caching normalized Mixamo bones + rest poses.
 */
export function cloneHumanoidFromTemplate(
  template: LoadedHumanoidTemplate
): ClonedHumanoidInstance {
  const root = new THREE.Group();
  root.name = 'humanoid_root';

  const clonedScene = SkeletonUtils.clone(template.scene);
  clonedScene.scale.setScalar(template.targetScale);
  clonedScene.position.set(0, template.groundOffsetY, 0);
  root.add(clonedScene);
  root.updateMatrixWorld(true);

  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  const bones = new Map<string, THREE.Bone>();
  const restQuats = new Map<string, THREE.Quaternion>();
  const restPositions = new Map<string, THREE.Vector3>();
  const materialDisposables: THREE.Material[] = [];

  let armatureScale = 1;

  clonedScene.traverse((obj) => {
    if (obj.name === 'Armature') {
      armatureScale = Math.max(0.001, Math.abs(obj.scale.x));
    }

    if ((obj as THREE.Bone).isBone) {
      const bone = obj as THREE.Bone;
      const key = normalizeMixamoBoneName(bone.name);
      if (!bones.has(key)) {
        bones.set(key, bone);
        restQuats.set(key, bone.quaternion.clone());
        restPositions.set(key, bone.position.clone());
      }
    }

    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
      const skinned = obj as THREE.SkinnedMesh;
      skinned.castShadow = true;
      skinned.receiveShadow = true;
      // Prevent frustum-culling pops when diving, flipping, or sliding away from bind bounds
      skinned.frustumCulled = false;

      if (Array.isArray(skinned.material)) {
        const clonedMats = skinned.material.map((m) => {
          const clone = m.clone();
          materialDisposables.push(clone);
          return clone;
        });
        skinned.material = clonedMats;
      } else if (skinned.material) {
        const clone = skinned.material.clone();
        materialDisposables.push(clone);
        skinned.material = clone;
      }

      skinnedMeshes.push(skinned);
    } else if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // Compute inverse scale so meter-sized props attached to bones render at true world scale
  const effectiveScale = Math.max(0.001, armatureScale * template.targetScale);
  const bonePropScale = 1 / effectiveScale;

  return {
    root,
    modelRoot: clonedScene,
    animations: template.animations,
    skinnedMeshes,
    bones,
    restQuats,
    restPositions,
    bonePropScale,
    materialDisposables,
  };
}

/**
 * Lightweight temporary 1.82m silhouette shown only during the ~100ms while
 * `/models/player_humanoid.glb` streams in, then cleanly swapped out in-place.
 */
export function buildFallbackHumanoidPlaceholder(
  primaryColor: number,
  secondaryColor: number
): FallbackHumanoidResult {
  const group = new THREE.Group();
  group.name = 'humanoid_fallback_placeholder';

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const primaryMat = track(
    new THREE.MeshStandardMaterial({
      color: primaryColor,
      roughness: 0.45,
      metalness: 0.1,
    })
  );
  const secondaryMat = track(
    new THREE.MeshStandardMaterial({
      color: secondaryColor,
      roughness: 0.55,
      metalness: 0.12,
    })
  );

  // Lower body / legs capsule
  const legsGeo = track(new THREE.CapsuleGeometry(0.18, 0.52, 6, 10));
  const legs = new THREE.Mesh(legsGeo, secondaryMat);
  legs.position.y = 0.44;
  legs.castShadow = true;
  legs.receiveShadow = true;
  group.add(legs);

  // Athletic torso capsule
  const torsoGeo = track(new THREE.CapsuleGeometry(0.24, 0.44, 6, 12));
  const torso = new THREE.Mesh(torsoGeo, primaryMat);
  torso.position.y = 1.14;
  torso.castShadow = true;
  torso.receiveShadow = true;
  group.add(torso);

  // Head sphere (~1.66m center -> ~1.82m top)
  const headGeo = track(new THREE.SphereGeometry(0.16, 12, 10));
  const head = new THREE.Mesh(headGeo, primaryMat);
  head.position.y = 1.66;
  head.castShadow = true;
  head.receiveShadow = true;
  group.add(head);

  return { group, disposables };
}
