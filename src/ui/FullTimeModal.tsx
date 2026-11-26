import { Home, LogOut, RotateCcw, Trophy } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { dismissInviteAutoJoin, getNet } from './networkBridge';
import { ModalShell, TEAM_HEX, TEAM_NAMES } from './uiKit';

export default function FullTimeModal() {
  const score = useGameStore((s) => s.score);
  const awards = useGameStore((s) => s.awards);
  const network = useGameStore((s) => s.network);
  const dispatch = useGameStore((s) => s.dispatchCommand);
  const isGuest = network.mode === 'guest';

  const handleGuestLeaveRoom = () => {
    dismissInviteAutoJoin();
    getNet()?.disconnect();
    dispatch({ type: 'returnToLobby' });
  };

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

        <div className="relative mt-6 flex flex-wrap items-center justify-center gap-3">
          {isGuest ? (
            <>
              {network.peerConnected && (
                <div className="flex h-14 items-center justify-center rounded-2xl border border-violet-300/50 bg-violet-500/15 px-6 text-base font-black text-violet-100">
                  مستني الهوست يبدأ ماتش جديد أو يرجع للّوبي... ⏳
                </div>
              )}
              <button
                type="button"
                onClick={handleGuestLeaveRoom}
                className="btn-ghost h-14 gap-2 border-rose-400/40 px-6 text-base text-rose-200 hover:bg-rose-500/15"
              >
                <LogOut size={20} /> خروج من الروم 🚪
              </button>
            </>
          ) : (
            <>
              {draw && (
                <button
                  type="button"
                  data-testid="fulltime-shootout-btn"
                  onClick={() => dispatch({ type: 'startPenaltyShootout', fromDraw: true })}
                  className="btn-cta anim-cta-pulse h-14 px-7 text-lg"
                  style={{
                    color: '#1e1b4b',
                    background: 'linear-gradient(135deg, #fde047, #f59e0b 55%, #d97706)',
                    boxShadow:
                      '0 0 0 1px rgba(253,224,71,0.65), 0 0 28px rgba(245,158,11,0.55), 0 8px 0 -2px #92400e',
                  }}
                >
                  <Trophy size={22} /> حسم بالتعادل: ركلات الترجيح 🥅
                </button>
              )}
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
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
