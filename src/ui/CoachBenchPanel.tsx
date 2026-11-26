import { Armchair, Clock, Shirt } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { TacticalStance } from '../types/game';
import { STANCE_LABEL, TEAM_HEX, TEAM_NAMES } from './uiKit';

const STANCES: TacticalStance[] = ['balanced', 'all_out_attack', 'park_the_bus', 'high_press'];

export default function CoachBenchPanel() {
  const team = useGameStore((s) => s.humanSlot.team);
  const players = useGameStore((s) => s.players);
  const tactics = useGameStore((s) => s.tactics);
  const pendingSub = useGameStore((s) => s.pendingSub);
  const coachDiscipline = useGameStore((s) => s.coachDiscipline);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  const squad = players.filter((p) => p.team === team && p.role !== 'coach');
  const active = squad.filter((p) => p.role === 'outfield' && !p.isBenched && !p.isSentOff);
  const benched = squad.filter((p) => p.isBenched);
  const hex = TEAM_HEX[team];
  const teamPendingSub = pendingSub && pendingSub.team === team ? pendingSub : null;
  const disc = coachDiscipline[team];
  const subsExhausted = disc.subsUsed >= disc.maxSubs;
  const onCooldown = disc.cooldownRemainingSec > 0.5;
  const subBlocked = subsExhausted || onCooldown;

  return (
    <div className="pe-auto thin-scroll absolute top-[106px] right-3 max-h-[calc(100vh-318px)] w-[258px] overflow-y-auto rounded-2xl">
      <div className="glass rounded-2xl" style={{ borderColor: `${hex}66` }}>
        <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <Shirt size={18} style={{ color: hex }} />
            <div className="leading-tight">
              <div className="text-sm font-black text-white">غرفة المدرب 🧥</div>
              <div className="text-[11px] font-bold" style={{ color: hex }}>{TEAM_NAMES[team]}</div>
            </div>
          </div>
          <span
            data-testid="coach-subs-badge"
            className={`rounded-full border px-2 py-0.5 text-[10px] font-black whitespace-nowrap tabular-nums ${
              subsExhausted
                ? 'border-rose-400/60 bg-rose-500/20 text-rose-200'
                : onCooldown
                  ? 'border-amber-300/60 bg-amber-500/20 text-amber-200'
                  : 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
            }`}
          >
            التبديلات: {disc.subsUsed}/{disc.maxSubs}
          </span>
        </header>

        <div className="flex flex-col gap-1.5 p-2.5">
          {(subsExhausted || onCooldown) && (
            <div
              className={`flex items-center justify-between gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-black ${
                subsExhausted
                  ? 'border-rose-400/50 bg-rose-500/15 text-rose-200'
                  : 'border-amber-300/50 bg-amber-500/15 text-amber-200'
              }`}
            >
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {subsExhausted
                  ? `خلصت التبديلات (${disc.subsUsed}/${disc.maxSubs}) 🚫`
                  : `انتظار ${Math.ceil(disc.cooldownRemainingSec)}s`}
              </span>
              {!subsExhausted && <span className="text-[10px] text-amber-300/90">تهدئة</span>}
            </div>
          )}
          {teamPendingSub && (
            <div className="mb-1 rounded-xl border border-amber-300/60 bg-gradient-to-br from-emerald-500/15 via-slate-900/80 to-amber-500/15 p-2 shadow-[0_0_16px_rgba(251,191,36,0.2)]">
              <div className="flex items-center justify-between text-[11px] font-black text-amber-200">
                <span>تبديل في الانتظار ⏳</span>
                <span className="h-2 w-2 rounded-full bg-emerald-400 anim-blink" />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs font-black text-white">
                <span className="text-rose-300">#{teamPendingSub.outPlayerNumber} {teamPendingSub.outPlayerName}</span>
                <span className="text-slate-400">←</span>
                <span className="text-emerald-300">#{teamPendingSub.inPlayerNumber} {teamPendingSub.inPlayerName}</span>
              </div>
              <div className="mt-0.5 text-[10px] leading-snug font-bold text-slate-300">
                مستني أول توقف للعب أو خروج الكورة 🪧
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'triggerQueuedSubNow' })}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-amber-300/60 bg-amber-400/20 px-2 py-1 text-[11px] font-black text-amber-100 transition hover:bg-amber-400/30"
              >
                أوقف اللعب للتبديل الآن 🏁
              </button>
            </div>
          )}

          <div className="text-[11px] font-black text-slate-400">اللعيبة في الملعب</div>
          {active.length === 0 && (
            <div className="rounded-lg bg-slate-900/60 p-2 text-center text-xs font-bold text-slate-500">مفيش لعيبة دلوقتي</div>
          )}
          {active.map((p) => {
            const isQueuedOut = teamPendingSub?.outPlayerId === p.id;
            return (
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
                  disabled={isQueuedOut || subBlocked}
                  onClick={() => dispatch({ type: 'coachSubToBench', playerId: p.id })}
                  className={`btn-ghost shrink-0 gap-1 px-2 py-1 text-[11px] ${
                    isQueuedOut
                      ? 'cursor-not-allowed border-amber-400/40 bg-amber-500/10 text-amber-200 opacity-75'
                      : subBlocked
                        ? 'cursor-not-allowed border-slate-700/60 bg-slate-900/50 text-slate-500 opacity-55'
                        : 'border-violet-400/50 text-violet-200 hover:bg-violet-500/20'
                  }`}
                >
                  <Armchair size={13} />
                  {isQueuedOut
                    ? 'في الانتظار 🪧'
                    : subsExhausted
                      ? 'لا تبديلات'
                      : onCooldown
                        ? `انتظار ${Math.ceil(disc.cooldownRemainingSec)}s`
                        : 'طلّع دكة! 🪑'}
                </button>
              </div>
            );
          })}

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
