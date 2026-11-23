import { SoundEngine } from '../audio/SoundEngine';
import { useGameStore } from '../store/useGameStore';
import { DEFAULT_STADIUM_CONFIG } from '../types/stadium';
import { CharacterSystem } from './entities/CharacterSystem';
import { MatchEngine } from './MatchEngine';
import { BallPhysics } from './physics/BallPhysics';
import { EffectsManager } from './physics/EffectsManager';
import { SceneManager } from './SceneManager';
import { StadiumScene } from './stadium/StadiumScene';

export interface GameBootstrapHandle {
  readonly sceneManager: SceneManager;
  readonly stadium: StadiumScene;
  readonly characters: CharacterSystem;
  readonly ball: BallPhysics;
  readonly effects: EffectsManager;
  readonly sound: SoundEngine;
  readonly engine: MatchEngine;
  dispose(): void;
}

/**
 * Composes and boots the full ElMal3abLife 3D WebGL runtime, wiring
 * SceneManager, StadiumScene, CharacterSystem, BallPhysics, EffectsManager,
 * SoundEngine, and MatchEngine with React StrictMode-safe teardown.
 */
export function createGameBootstrap(container: HTMLElement): GameBootstrapHandle {
  const sceneManager = new SceneManager(container);
  const stadium = new StadiumScene(DEFAULT_STADIUM_CONFIG);
  const characters = new CharacterSystem();
  const ball = new BallPhysics();
  const effects = new EffectsManager();
  const sound = new SoundEngine();

  // Honor any pre-existing mute preference in store
  sound.setMuted(useGameStore.getState().muted);

  const scene = sceneManager.getScene();
  const camera = sceneManager.getCamera();

  // Mount camera and all 3D subsystem groups into the active Three.js scene
  scene.add(camera);
  scene.add(stadium.group);
  scene.add(characters.group);
  scene.add(ball.mesh);
  scene.add(ball.trajectoryLine);
  scene.add(effects.group);

  const engine = new MatchEngine({
    stadium,
    characters,
    ball,
    effects,
    sound,
    camera,
    onRender: () => sceneManager.render(),
  });

  let disposed = false;
  let audioUnlocked = false;

  const removeAudioUnlockListeners = (): void => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', handleFirstGesture, true);
    window.removeEventListener('keydown', handleFirstGesture, true);
    window.removeEventListener('touchstart', handleFirstGesture, true);
  };

  const handleFirstGesture = (): void => {
    if (disposed || audioUnlocked) return;
    audioUnlocked = true;
    sound.unlock();
    removeAudioUnlockListeners();
  };

  const handleOrientationResize = (): void => {
    if (!disposed) {
      sceneManager.resize();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', handleFirstGesture, { capture: true, passive: true });
    window.addEventListener('keydown', handleFirstGesture, { capture: true, passive: true });
    window.addEventListener('touchstart', handleFirstGesture, { capture: true, passive: true });
    window.addEventListener('orientationchange', handleOrientationResize);
  }

  // Ensure initial dimensions match container and launch the simulation loop
  sceneManager.resize();
  engine.start();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    removeAudioUnlockListeners();
    if (typeof window !== 'undefined') {
      window.removeEventListener('orientationchange', handleOrientationResize);
    }

    engine.dispose();

    scene.remove(effects.group);
    scene.remove(ball.trajectoryLine);
    scene.remove(ball.mesh);
    scene.remove(characters.group);
    scene.remove(stadium.group);
    scene.remove(camera);

    effects.dispose();
    ball.dispose();
    characters.dispose();
    stadium.dispose();
    sound.dispose();
    sceneManager.dispose();
  };

  return {
    sceneManager,
    stadium,
    characters,
    ball,
    effects,
    sound,
    engine,
    dispose,
  };
}
