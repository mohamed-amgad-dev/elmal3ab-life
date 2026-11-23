import { Armchair, Shirt } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { TacticalStance } from '../types/game';
import { STANCE_LABEL, TEAM_HEX, TEAM_NAMES } from './uiKit';

const STANCES: TacticalStance[] = ['balanced', 'all_out_attack', 'park_the_bus', 'high_press'];

export default function CoachBenchPanel() {
  const team = useGameStore((s) => s.humanSlot.team);
  const players = useGameStore((s) => s.players);
  const tactics = useGameStore((s) => s.tactics);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  const squad = players.filter((p) => p.team === team && p.role !== 'coach');
  const active = squad.filter((p) => !p.isBenched && !p.isSentOff);
  const benched = squad.filter((p) => p.isBenched);
  const hex = TEAM_HEX[team];

  return (
    <div className="absolute top-[92px] right-3 w-[258px]">
      <div className="glass rounded-2xl" style={{ borderColor: `${hex}66` }}>
        <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <Shirt size={18} style={{ color: hex }} />
          <div className="leading-tight">
            <div className="text-sm font-black text-white">غرفة المدرب 🧥</div>
            <div className="text-[11px] font-bold" style={{ color: hex }}>{TEAM_NAMES[team]}</div>
          </div>
        </header>

        <div className="flex flex-col gap-1.5 p-2.5">
          <div className="text-[11px] font-black text-slate-400">اللعيبة في الملعب</div>
          {active.length === 0 && (
            <div className="rounded-lg bg-slate-900/60 p-2 text-center text-xs font-bold text-slate-500">مفيش لعيبة دلوقتي</div>
          )}
          {active.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-slate-900/55 px-2 py-1.5">
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[13px] font-black text-white">
                  <span className="text-slate-400">#{p.number}</span> {p.name}
                </div>
                <div className="mt-0.5 h-1 w-20 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.max(0, Math.min(100, p.stamina))}%` }} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'coachSubToBench', playerId: p.id })}
                className="btn-ghost shrink-0 gap-1 border-violet-400/50 px-2 py-1 text-[11px] text-violet-200 hover:bg-violet-500/20"
              >
                <Armchair size={13} />
                طلّع دكة! 🪑
              </button>
            </div>
          ))}

          {benched.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] font-bold text-slate-400">
              على الدكة:
              {benched.map((p) => (
                <span key={p.id} className="rounded-full bg-violet-500/20 px-2 py-0.5 text-violet-200">
                  {p.name}
                </span>
              ))}
            </div>
          )}

          <div className="mt-1 text-[11px] font-black text-slate-400">التكتيك</div>
          <div className="grid grid-cols-2 gap-1.5">
            {STANCES.map((st) => (
              <button
                key={st}
                type="button"
                data-active={tactics[team] === st}
                data-tone="gold"
                onClick={() => dispatch({ type: 'coachTactic', team, stance: st })}
                className="pill justify-center px-2 py-1.5 text-[11px]"
              >
                {STANCE_LABEL[st].emoji} {STANCE_LABEL[st].label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
