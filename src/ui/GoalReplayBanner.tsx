import { SkipForward } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { TEAM_HEX } from './uiKit';

/** Broadcast-style slow-motion replay pill, shown only during `goal_replay`. */
export default function GoalReplayBanner() {
  const phase = useGameStore((s) => s.phase);
  const replay = useGameStore((s) => s.goalReplayState);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  if (phase !== 'goal_replay') return null;

  const ratio = replay.duration > 0 ? replay.elapsed / replay.duration : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const accent = replay.scoringTeam ? TEAM_HEX[replay.scoringTeam] : '#fbbf24';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
      <div
        className="anim-fade-up w-[560px] max-w-[calc(100vw-24px)] rounded-3xl border-2 bg-slate-950/80 px-5 py-3 backdrop-blur-md"
        style={{ borderColor: `${accent}cc`, boxShadow: `0 0 26px ${accent}66` }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="anim-blink h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-base font-black text-white">🎥 إعادة الهدف — العرض البطيء</div>
              {replay.scorerName && (
                <div className="truncate text-xs font-bold" style={{ color: accent }}>
                  ⚽ سجّله: {replay.scorerName}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: 'skipGoalReplay' })}
            className="pe-auto btn-ghost h-9 shrink-0 gap-1.5 px-3 text-xs font-black whitespace-nowrap text-amber-200"
          >
            <SkipForward size={14} />
            اضغط Space للتخطي ⏭
          </button>
        </div>

        <div
          dir="ltr"
          className="mt-2.5 h-2 overflow-hidden rounded-full border border-white/10 bg-slate-900/90"
        >
          <div
            className="h-full rounded-full transition-[width] duration-100"
            style={{
              width: `${pct}%`,
              background: `linear-gradient(90deg, ${accent}, #fbbf24)`,
              boxShadow: `0 0 10px ${accent}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
