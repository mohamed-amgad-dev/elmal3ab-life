import { useGameStore } from '../store/useGameStore';
import { TEAM_HEX, TEAM_NAMES } from './uiKit';

export default function MatchDramaOverlay() {
  const phase = useGameStore((s) => s.phase);
  const dramaState = useGameStore((s) => s.dramaState);
  const pendingSub = useGameStore((s) => s.pendingSub);

  const showQueuedSub = pendingSub !== null && phase === 'playing';
  const showRedCard = phase === 'red_card_drama' && dramaState.kind === 'red_card';
  const showSubBoard = phase === 'substitution_stoppage' && dramaState.kind === 'substitution';

  if (!showQueuedSub && !showRedCard && !showSubBoard) return null;

  const progressPct =
    dramaState.duration > 0
      ? Math.max(0, Math.min(100, (dramaState.elapsed / dramaState.duration) * 100))
      : 0;

  return (
    <div className="pointer-events-none absolute top-[104px] left-1/2 z-20 flex -translate-x-1/2 flex-col items-center">
      {/* a) Queued Substitution Pill during live play */}
      {showQueuedSub && pendingSub && (
        <div
          data-testid="queued-sub-pill"
          className="glass anim-fade-in flex max-w-[440px] flex-wrap items-center justify-center gap-1.5 rounded-full border border-emerald-400/50 bg-slate-950/85 px-3 py-1.5 text-[11px] font-black text-slate-100 shadow-[0_0_20px_rgba(16,185,129,0.22)]"
        >
          <span className="whitespace-nowrap text-amber-300">🪧 تبديل عند أول توقف:</span>
          <span className="whitespace-nowrap text-rose-300">
            #{pendingSub.outPlayerNumber} {pendingSub.outPlayerName} 🔴
          </span>
          <span className="text-slate-400">⟵</span>
          <span className="whitespace-nowrap text-emerald-300">
            #{pendingSub.inPlayerNumber} {pendingSub.inPlayerName} 🟢
          </span>
        </div>
      )}

      {/* b) Red Card Drama Broadcast Card */}
      {showRedCard && (
        <div
          data-testid="red-card-drama-card"
          className="anim-pop-in w-[430px] max-w-[92vw] overflow-hidden rounded-3xl border-2 border-rose-500/80 bg-gradient-to-br from-rose-950/90 via-slate-950/92 to-amber-950/85 shadow-[0_0_38px_rgba(244,63,94,0.45)] backdrop-blur-md"
        >
          <div className="flex items-center gap-3.5 px-5 py-3.5">
            {/* Glowing animated Red Card icon */}
            <div className="relative flex h-14 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-rose-300/90 bg-gradient-to-b from-rose-500 to-red-700 shadow-[0_0_24px_rgba(244,63,94,0.85)] anim-blink">
              <span className="text-2xl leading-none">🟥</span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-xl leading-tight font-black text-rose-200">
                  {dramaState.headline || 'طرد مباشر! برّه الملعب'}
                </span>
                <span className="rounded-full border border-amber-300/60 bg-amber-400/15 px-2.5 py-0.5 text-[10px] font-black whitespace-nowrap text-amber-200">
                  {dramaState.stage === 'confrontation'
                    ? 'المواجهة مع الحكم 🗣️'
                    : 'خارج برّه الخط 🚶‍♂️🟥'}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-2 text-sm font-black text-white">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    background: TEAM_HEX[dramaState.team],
                    boxShadow: `0 0 8px ${TEAM_HEX[dramaState.team]}`,
                  }}
                />
                <span className="text-amber-300">#{dramaState.primaryPlayerNumber}</span>
                <span className="truncate">{dramaState.primaryPlayerName}</span>
                <span className="text-xs font-bold text-slate-400">
                  • {TEAM_NAMES[dramaState.team]}
                </span>
              </div>

              {dramaState.subtext && (
                <p className="mt-1 text-xs font-bold text-rose-100/90">{dramaState.subtext}</p>
              )}
            </div>
          </div>

          {dramaState.duration > 0 && (
            <div className="h-1 w-full bg-slate-900/90">
              <div
                className="h-full bg-gradient-to-r from-rose-500 to-amber-400 transition-[width] duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* c) Official Electronic 4th-Official Substitution Board */}
      {showSubBoard && (
        <div
          data-testid="substitution-drama-board"
          className="anim-pop-in w-[440px] max-w-[92vw] overflow-hidden rounded-3xl border-2 border-emerald-400/70 bg-slate-950/92 shadow-[0_0_34px_rgba(16,185,129,0.35)] backdrop-blur-md"
        >
          <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-slate-900/80 px-4 py-2">
            <span className="text-xs font-black text-amber-300">
              توقف اللعب — تبديل رسمي 🏁🔄
            </span>
            <span className="rounded-full border border-cyan-300/40 bg-cyan-500/15 px-2.5 py-0.5 text-[10px] font-black whitespace-nowrap text-cyan-200">
              {dramaState.stage === 'enter_pitch'
                ? 'نزول البديل للملعب 🏃‍♂️🔥'
                : 'خروج اللاعب للدكة 🚶‍♂️'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 px-4 py-3">
            {/* Outgoing player LED panel */}
            <div className="flex items-center gap-2.5 rounded-2xl border border-rose-500/40 bg-rose-950/35 px-3 py-2">
              <span
                className="font-display text-3xl leading-none font-black tabular-nums text-rose-400"
                style={{ textShadow: '0 0 14px rgba(244,63,94,0.85)' }}
                dir="ltr"
              >
                #{dramaState.primaryPlayerNumber}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-rose-300">🔴 خروج</div>
                <div className="truncate text-sm font-black text-white">
                  {dramaState.primaryPlayerName}
                </div>
              </div>
            </div>

            {/* Incoming player LED panel */}
            <div className="flex items-center gap-2.5 rounded-2xl border border-emerald-400/50 bg-emerald-950/35 px-3 py-2">
              <span
                className="font-display text-3xl leading-none font-black tabular-nums text-emerald-400"
                style={{ textShadow: '0 0 14px rgba(16,185,129,0.85)' }}
                dir="ltr"
              >
                #{dramaState.secondaryPlayerNumber ?? 0}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-emerald-300">🟢 دخول</div>
                <div className="truncate text-sm font-black text-white">
                  {dramaState.secondaryPlayerName || 'البديل'}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-4 pb-2.5 text-[11px] font-bold text-slate-300">
            <span className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: TEAM_HEX[dramaState.team] }}
              />
              {TEAM_NAMES[dramaState.team]}
            </span>
            {dramaState.subtext && <span className="truncate text-slate-400">{dramaState.subtext}</span>}
          </div>

          {dramaState.duration > 0 && (
            <div className="h-1 w-full bg-slate-900/90">
              <div
                className="h-full bg-gradient-to-r from-rose-400 via-amber-300 to-emerald-400 transition-[width] duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
