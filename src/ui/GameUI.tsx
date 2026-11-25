import { useGameStore } from '../store/useGameStore';
import type { MatchPhase } from '../types/game';
import MainMenu from './MainMenu';
import LobbyScreen from './LobbyScreen';
import GameHUD from './GameHUD';
import FullTimeModal from './FullTimeModal';
import PauseModal from './PauseModal';
import ControlsHelpModal from './ControlsHelpModal';

const MATCH_PHASES: MatchPhase[] = [
  'kickoff',
  'playing',
  'paused_whistle',
  'penalty_setup',
  'var_review',
  'goal_celebration',
  'goal_replay',
];

/**
 * Top-level React overlay rendered above the 3D canvas.
 * The wrapper never captures pointer events; only interactive panels opt in,
 * so clicks / drags fall through to the WebGL canvas.
 */
export function GameUI() {
  const phase = useGameStore((s) => s.phase);
  const isPaused = useGameStore((s) => s.isPaused);
  const isControlsOpen = useGameStore((s) => s.isControlsOpen);

  const inMatch = MATCH_PHASES.includes(phase);

  return (
    <div className="ui-root" dir="rtl">
      {phase === 'menu' && <MainMenu />}
      {phase === 'lobby' && <LobbyScreen />}
      {inMatch && <GameHUD />}
      {inMatch && isPaused && <PauseModal />}
      {phase === 'full_time' && <FullTimeModal />}
      {isControlsOpen && <ControlsHelpModal />}
    </div>
  );
}

export default GameUI;
