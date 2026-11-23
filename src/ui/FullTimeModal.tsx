import { Home, RotateCcw, Trophy } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { ModalShell, TEAM_HEX, TEAM_NAMES } from './uiKit';

export default function FullTimeModal() {
  const score = useGameStore((s) => s.score);
  const awards = useGameStore((s) => s.awards);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  const draw = score.red === score.blue;
  const winner = score.red > score.blue ? 'red' : 'blue';
  const headline = draw ? 'تعادل.. محدش فاز ولا خسر 🤝' : `${TEAM_NAMES[winner]} كسبوا الماتش! 🏆`;
  const sub = draw ? 'الفار نفسه مش عارف يحكم 😂' : 'مبروك للفايزين.. والخسرانين: الحكم كان ضدكم! 😅';

  return (
    <ModalShell maxWidth="max-w-3xl">
      <div className="relative overflow-hidden rounded-3xl p-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background: draw
              ? 'radial-gradient(circle at 50% 0%, rgba(251,191,36,0.25), transparent 60%)'
              : `radial-gradient(circle at 50% 0%, ${TEAM_HEX[winner]}44, transparent 60%)`,
          }}
        />

        <div className="relative flex flex-col items-center text-center">
          <div className="anim-float mb-2 flex items-center gap-2 rounded-full border border-amber-300/60 bg-amber-400/10 px-4 py-1 text-sm font-black text-amber-200">
            <Trophy size={16} /> صفّارة النهاية! 🏁
          </div>
          <h2 className="font-display text-3xl font-black text-white text-glow-gold">{headline}</h2>
          <p className="mt-1 text-sm font-bold text-slate-300">{sub}</p>

          <div className="mt-4 flex items-center justify-center gap-6">
            {(['red', 'blue'] as const).map((t, i) => (
              <div key={t} className="flex items-center gap-6">
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-black" style={{ color: TEAM_HEX[t] }}>{TEAM_NAMES[t]}</span>
                  <span
                    className="anim-goal-pop font-display text-7xl leading-none font-black tabular-nums"
                    style={{ color: '#fff', textShadow: `0 0 30px ${TEAM_HEX[t]}` }}
                  >
                    {score[t]}
                  </span>
                </div>
                {i === 0 && <span className="font-display text-4xl font-black text-slate-500">:</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="relative mt-5">
          <h3 className="mb-2 flex items-center gap-2 text-base font-black text-amber-300">
            🏅 جوايز الضحك والكوميديا
          </h3>
          {awards.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 text-center text-sm font-bold text-slate-400">
              الماتش كان محترم زيادة عن اللزوم.. مفيش جوايز 😴
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {awards.map((a, i) => (
                <div
                  key={`${a.title}-${i}`}
                  className="anim-fade-up flex items-start gap-3 rounded-2xl border border-amber-300/30 bg-slate-900/60 p-3"
                  style={{ animationDelay: `${i * 80}ms` }}
                >
                  <span className="text-3xl leading-none">{a.emoji}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-black text-amber-200">{a.title}</div>
                    <div className="text-sm font-black text-white">{a.playerName}</div>
                    <div className="text-[12px] leading-snug font-semibold text-slate-400">{a.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="relative mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => dispatch({ type: 'restartMatch' })}
            className="btn-cta h-14 px-8 text-xl"
          >
            <RotateCcw size={22} /> ماتش كمان! 🔄
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'returnToLobby' })}
            className="btn-ghost h-14 gap-2 px-6 text-base"
          >
            <Home size={20} /> رجوع للّوبي 🏟️
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
