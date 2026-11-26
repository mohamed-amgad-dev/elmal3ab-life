import { useGameStore } from '../store/useGameStore';
import { TEAM_HEX, TEAM_NAMES } from './uiKit';
import Scoreboard from './Scoreboard';
import ComedyToastFeed from './ComedyToastFeed';
import OutfieldHUD from './OutfieldHUD';
import GoalkeeperHUD from './GoalkeeperHUD';
import RefereeControlsBar from './RefereeControlsBar';
import VAROverlay from './VAROverlay';
import CoachBenchPanel from './CoachBenchPanel';
import BenchEmoteBar from './BenchEmoteBar';
import SpectatorControlsBar from './SpectatorControlsBar';
import QuickRoleSwitcher from './QuickRoleSwitcher';
import GoalReplayBanner from './GoalReplayBanner';
import QuickChatWheel from './QuickChatWheel';
import MatchDramaOverlay from './MatchDramaOverlay';

function GoalBanner() {
  const phase = useGameStore((s) => s.phase);
  const score = useGameStore((s) => s.score);
  const lastGoal = useGameStore((s) => s.events.find((e) => e.tone === 'goal'));
  if (phase !== 'goal_celebration') return null;

  return (
    <div className="absolute top-[24%] left-1/2 -translate-x-1/2">
      <div
        key={`${score.red}-${score.blue}`}
        className="anim-goal-pop flex flex-col items-center rounded-3xl border-2 border-amber-300/80 bg-slate-950/70 px-12 py-4 text-center backdrop-blur-md glow-gold"
      >
        <div className="font-display text-7xl leading-none font-black text-amber-300 text-glow-gold">جووووول! ⚽</div>
        <div className="mt-2 flex items-center gap-4 font-display text-3xl font-black tabular-nums text-white">
          <span style={{ color: TEAM_HEX.red }}>{TEAM_NAMES.red} {score.red}</span>
          <span className="text-slate-500">-</span>
          <span style={{ color: TEAM_HEX.blue }}>{score.blue} {TEAM_NAMES.blue}</span>
        </div>
        {lastGoal && <div className="mt-1 max-w-[520px] text-sm font-bold text-slate-200">{lastGoal.icon} {lastGoal.text}</div>}
      </div>
    </div>
  );
}

export default function GameHUD() {
  const role = useGameStore((s) => s.humanSlot.role);
  const benched = useGameStore((s) => s.humanSlot.isBenched);
  const phase = useGameStore((s) => s.phase);
  const varActive = useGameStore((s) => s.varState.active);
  const inVAR = varActive || phase === 'var_review';

  const roleHUD = (() => {
    if (inVAR || phase === 'goal_replay' || phase === 'penalty_shootout') return null; // keep replay & shootout clean
    if (benched) return <BenchEmoteBar />;
    switch (role) {
      case 'outfield':
        return <OutfieldHUD />;
      case 'goalkeeper':
        return <GoalkeeperHUD />;
      case 'referee':
        return <RefereeControlsBar />;
      case 'coach':
        return null; // coach panel is a side card, rendered below
      case 'spectator':
        return <SpectatorControlsBar />;
    }
  })();

  return (
    <div className="absolute inset-0">
      <Scoreboard />
      <MatchDramaOverlay />
      <ComedyToastFeed />
      {roleHUD}
      {role === 'coach' && !benched && phase !== 'goal_replay' && phase !== 'penalty_shootout' && <CoachBenchPanel />}
      <GoalReplayBanner />
      <QuickChatWheel />
      <GoalBanner />
      {phase !== 'goal_replay' && phase !== 'penalty_shootout' && <QuickRoleSwitcher />}
      <VAROverlay />
    </div>
  );
}
