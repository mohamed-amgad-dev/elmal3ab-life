import { useEffect, useRef } from 'react';
import { Award, Crosshair, Flame, Hand, Home, RotateCcw, Shield, Target, Trophy, Zap } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { PenaltyKickOutcome, TeamId } from '../types/game';
import { TEAM_HEX, TEAM_NAMES } from './uiKit';

function KickDots({ outcomes, team }: { outcomes: PenaltyKickOutcome[]; team: TeamId }) {
  const hex = TEAM_HEX[team];
  return (
    <div className="flex items-center gap-1.5" dir="ltr">
      {outcomes.map((outcome, idx) => {
        const dotClass =
          outcome === 'scored'
            ? 'border-emerald-200 bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.85)]'
            : outcome === 'saved' || outcome === 'missed'
              ? 'border-rose-300 bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)]'
              : 'border-slate-500/75 bg-slate-900/60';
        const title =
          outcome === 'scored'
            ? 'هدف'
            : outcome === 'saved'
              ? 'تصدي الحارس'
              : outcome === 'missed'
                ? 'ضائعة'
                : 'قادمة';
        return (
          <span
            key={`${team}-dot-${idx}`}
            title={title}
            className={`h-3.5 w-3.5 rounded-full border-2 transition-all duration-200 ${dotClass}`}
            style={outcome === 'pending' ? { borderColor: `${hex}66` } : undefined}
          />
        );
      })}
    </div>
  );
}

function FreeKickBanner() {
  const freeKick = useGameStore((s) => s.freeKick);
  const dispatch = useGameStore((s) => s.dispatchCommand);
  const shootTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shootTimerRef.current !== null) {
        window.clearTimeout(shootTimerRef.current);
      }
    };
  }, []);

  const handleQuickShoot = () => {
    if (shootTimerRef.current !== null) {
      window.clearTimeout(shootTimerRef.current);
    }
    dispatch({ type: 'shootStart' });
    shootTimerRef.current = window.setTimeout(() => {
      dispatch({ type: 'shootRelease' });
      shootTimerRef.current = null;
    }, 180);
  };

  const hex = TEAM_HEX[freeKick.awardedTeam];
  const stageLabel =
    freeKick.stage === 'whistle_freeze'
      ? 'صفّارة الفاول 📢'
      : freeKick.stage === 'wall_setup'
        ? 'تجهيز حائط الصد 🧱'
        : 'جاهز للتنفيذ! ⚡';

  const cardBadge =
    freeKick.cardShown === 'red'
      ? '🟥 طرد'
      : freeKick.cardShown === 'yellow'
        ? '🟨 إنذار'
        : null;

  return (
    <div
      data-testid="free-kick-banner"
      className="pointer-events-none absolute top-[94px] left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2"
    >
      <div
        className="glass anim-pop-in flex max-w-[92vw] flex-wrap items-center justify-center gap-2.5 rounded-2xl border px-4 py-2 shadow-[0_0_26px_rgba(249,115,22,0.28)]"
        style={{ borderColor: `${hex}88` }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: hex, boxShadow: `0 0 10px ${hex}` }}
          />
          <span className="font-display text-sm font-black text-amber-300">ركلة حرة ⚽</span>
          <span className="text-xs font-black text-white">{TEAM_NAMES[freeKick.awardedTeam]}</span>
        </div>

        <span className="h-4 w-px bg-white/15" />

        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
          <Target size={13} className="text-cyan-300" />
          <span className="tabular-nums">{Math.max(1, Math.round(freeKick.distanceToGoalM))}م</span>
          <span className="rounded-full border border-white/15 bg-slate-900/75 px-2 py-0.5 text-[10px] font-black text-cyan-200">
            {freeKick.isDirectRange ? 'تسديد مباشر 🎯' : 'تمريرة / عرضية'}
          </span>
          {freeKick.wallSize > 0 && (
            <span className="flex items-center gap-1 rounded-full border border-amber-300/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-200">
              <Shield size={11} /> حائط ({freeKick.wallSize})
            </span>
          )}
          {cardBadge && (
            <span className="rounded-full border border-rose-400/50 bg-rose-500/20 px-2 py-0.5 text-[10px] font-black text-rose-200">
              {cardBadge}
            </span>
          )}
        </div>

        <span className="h-4 w-px bg-white/15" />

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-black text-emerald-300">{stageLabel}</span>
          {freeKick.countdownSec > 0.05 && (
            <span
              dir="ltr"
              className="rounded-md border border-amber-300/50 bg-slate-950/85 px-2 py-0.5 font-display text-xs font-black tabular-nums text-amber-300"
            >
              {Math.ceil(freeKick.countdownSec)}s
            </span>
          )}
        </div>
      </div>

      {freeKick.reason && (
        <div className="rounded-full border border-white/10 bg-slate-950/80 px-3 py-0.5 text-[11px] font-bold text-slate-300 backdrop-blur-md">
          {freeKick.reason}
          {freeKick.takerName ? ` • المنفّذ: ${freeKick.takerName}` : ''}
        </div>
      )}

      {freeKick.isHumanTaker && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="fk-pass-btn"
            onClick={() => dispatch({ type: 'pass' })}
            className="pointer-events-auto btn-ghost h-9 gap-2 border-cyan-400/60 bg-slate-950/85 px-3.5 text-xs font-black text-cyan-100 shadow-[0_0_16px_rgba(0,194,255,0.28)] hover:bg-cyan-500/20"
          >
            <span className="kbd">E</span>
            تمريرة سريعة
          </button>
          <button
            type="button"
            data-testid="fk-shoot-btn"
            onClick={handleQuickShoot}
            className="pointer-events-auto btn-cta h-9 gap-2 px-4 text-xs font-black"
          >
            <span className="kbd">Space</span>
            تسديدة صاروخية 🚀
          </button>
        </div>
      )}
    </div>
  );
}

function PenaltyShootoutOverlay() {
  const shootout = useGameStore((s) => s.penaltyShootout);
  const dispatch = useGameStore((s) => s.dispatchCommand);
  const setPhase = useGameStore((s) => s.setPhase);

  const canHumanKick =
    shootout.stage === 'awaiting_kick' && shootout.humanTurnRole === 'kicker';
  const canHumanDive =
    (shootout.stage === 'awaiting_kick' || shootout.stage === 'ball_in_flight') &&
    shootout.humanTurnRole === 'goalkeeper';
  const isFinished = shootout.stage === 'finished';

  const handleReturnMenu = () => {
    dispatch({ type: 'returnToLobby' });
    setPhase('menu');
  };

  return (
    <div
      data-testid="shootout-overlay"
      className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between"
    >
      {/* Top Broadcast Shootout Scoreboard (positioned below main Scoreboard to avoid overlap) */}
      <div className="pointer-events-none absolute top-[94px] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        <div className="glass-strong anim-pop-in flex w-[600px] max-w-[94vw] flex-col gap-2 rounded-2xl border border-amber-300/45 px-4 py-2.5 shadow-[0_0_32px_rgba(251,191,36,0.22)]">
          {/* Header Row: Round / Sudden Death Badge */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
            <span className="flex items-center gap-1.5 text-xs font-black text-amber-300">
              <Award size={14} />
              ركلات الترجيح — الجولة {shootout.round}
            </span>

            {shootout.isSuddenDeath ? (
              <span className="anim-blink flex items-center gap-1 rounded-full border border-rose-400/80 bg-rose-500/25 px-2.5 py-0.5 text-[11px] font-black text-rose-100 shadow-[0_0_16px_rgba(244,63,94,0.65)]">
                <Flame size={12} /> الموت المفاجئ! ⚡
              </span>
            ) : (
              <span className="rounded-full border border-cyan-400/40 bg-cyan-500/15 px-2.5 py-0.5 text-[10px] font-black text-cyan-200">
                {shootout.kickingTeam === 'red' ? 'دور النسور الحمر 🔴' : 'دور موج بحري 🔵'}
              </span>
            )}

            {shootout.stage === 'awaiting_kick' && shootout.shotTimerSec > 0.05 ? (
              <span
                dir="ltr"
                className={`rounded-md border px-2 py-0.5 font-display text-xs font-black tabular-nums ${
                  shootout.shotTimerSec <= 3
                    ? 'anim-blink border-rose-400/70 bg-rose-500/20 text-rose-200'
                    : 'border-amber-300/50 bg-slate-950/80 text-amber-200'
                }`}
              >
                {Math.ceil(shootout.shotTimerSec)}s
              </span>
            ) : (
              <span className="text-[10px] font-bold text-slate-400">
                {shootout.humanTurnRole === 'kicker'
                  ? 'أنت المسدّد 🎯'
                  : shootout.humanTurnRole === 'goalkeeper'
                    ? 'أنت الحارس 🧤'
                    : 'مشاهدة 👀'}
              </span>
            )}
          </div>

          {/* Teams + Score + Kick Dots */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            {/* Red Team */}
            <div className="flex flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: TEAM_HEX.red, boxShadow: `0 0 8px ${TEAM_HEX.red}` }}
                />
                <span className="text-xs font-black text-white">{TEAM_NAMES.red}</span>
                {shootout.kickingTeam === 'red' && !isFinished && (
                  <span className="text-[10px] font-black text-amber-300">⚽</span>
                )}
              </div>
              <KickDots outcomes={shootout.rounds.red} team="red" />
            </div>

            {/* Central Shootout Score */}
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-slate-950/80 px-3.5 py-1 font-display text-3xl leading-none font-black tabular-nums">
              <span style={{ color: '#fff', textShadow: `0 0 16px ${TEAM_HEX.red}` }}>
                {shootout.shootoutScore.red}
              </span>
              <span className="text-lg text-slate-500">-</span>
              <span style={{ color: '#fff', textShadow: `0 0 16px ${TEAM_HEX.blue}` }}>
                {shootout.shootoutScore.blue}
              </span>
            </div>

            {/* Blue Team */}
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                {shootout.kickingTeam === 'blue' && !isFinished && (
                  <span className="text-[10px] font-black text-amber-300">⚽</span>
                )}
                <span className="text-xs font-black text-white">{TEAM_NAMES.blue}</span>
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: TEAM_HEX.blue, boxShadow: `0 0 8px ${TEAM_HEX.blue}` }}
                />
              </div>
              <KickDots outcomes={shootout.rounds.blue} team="blue" />
            </div>
          </div>

          {/* Live Matchup / Headline Strip */}
          {(shootout.headline || shootout.shooterName) && !isFinished && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-900/75 px-3 py-1 text-xs font-black text-slate-100">
              <span>{shootout.headline || `${shootout.shooterName} في مواجهة ${shootout.gkName}`}</span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom-Center Interactive Controls */}
      {canHumanKick && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
          <div className="glass-strong anim-fade-up flex flex-col items-center gap-2.5 rounded-3xl border border-emerald-400/50 px-5 py-3.5 shadow-[0_0_32px_rgba(16,185,129,0.3)]">
            <div className="flex items-center gap-2 text-sm font-black text-emerald-200">
              <Crosshair size={16} className="text-amber-300" />
              اختار زاوية التسديد يا كابتن! 🎯
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                data-testid="shootout-kick-right"
                onClick={() => dispatch({ type: 'shootoutKick', dirX: 1, power: 0.86 })}
                className="pointer-events-auto btn-cta h-12 min-w-[126px] px-4 text-base font-black"
              >
                <span className="kbd">D</span>
                يمين ➡️
              </button>
              <button
                type="button"
                data-testid="shootout-kick-center"
                onClick={() => dispatch({ type: 'shootoutKick', dirX: 0, power: 0.86 })}
                className="pointer-events-auto btn-cta h-12 min-w-[126px] px-4 text-base font-black"
                style={{
                  background: 'linear-gradient(135deg, #fbbf24, #f59e0b 55%, #d97706)',
                  boxShadow: '0 0 22px rgba(251,191,36,0.45), 0 6px 0 -2px #92400e',
                }}
              >
                <span className="kbd">W</span>
                وسط ⬆️
              </button>
              <button
                type="button"
                data-testid="shootout-kick-left"
                onClick={() => dispatch({ type: 'shootoutKick', dirX: -1, power: 0.86 })}
                className="pointer-events-auto btn-cta h-12 min-w-[126px] px-4 text-base font-black"
              >
                <span className="kbd">A</span>
                يسار ⬅️
              </button>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300">
              <Zap size={12} className="text-amber-300" />
              كيبورد: <span className="kbd">A</span> / <span className="kbd">W</span> /{' '}
              <span className="kbd">D</span> أو <span className="kbd">Space</span>
            </div>
          </div>
        </div>
      )}

      {canHumanDive && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
          <div className="glass-strong anim-fade-up flex flex-col items-center gap-2.5 rounded-3xl border border-amber-300/60 px-5 py-3.5 shadow-[0_0_32px_rgba(251,191,36,0.3)]">
            <div className="flex items-center gap-2 text-sm font-black text-amber-200">
              <Hand size={16} className="text-cyan-300" />
              توقّع زاوية الكورة وغطس! 🧤
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                data-testid="shootout-dive-right"
                onClick={() => dispatch({ type: 'gkDive', dir: 'right' })}
                className="pointer-events-auto btn-ghost h-12 min-w-[132px] border-cyan-400/70 bg-cyan-500/20 px-4 text-sm font-black text-cyan-100 shadow-[0_0_18px_rgba(0,194,255,0.3)] hover:bg-cyan-500/35"
              >
                <span className="kbd">D</span>
                غطس يمين 🧤
              </button>
              <button
                type="button"
                data-testid="shootout-dive-center"
                onClick={() => dispatch({ type: 'gkDive', dir: 'center' })}
                className="pointer-events-auto btn-ghost h-12 min-w-[132px] border-amber-300/70 bg-amber-500/20 px-4 text-sm font-black text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.3)] hover:bg-amber-500/35"
              >
                <span className="kbd">Space</span>
                ثبات وسط 🧱
              </button>
              <button
                type="button"
                data-testid="shootout-dive-left"
                onClick={() => dispatch({ type: 'gkDive', dir: 'left' })}
                className="pointer-events-auto btn-ghost h-12 min-w-[132px] border-cyan-400/70 bg-cyan-500/20 px-4 text-sm font-black text-cyan-100 shadow-[0_0_18px_rgba(0,194,255,0.3)] hover:bg-cyan-500/35"
              >
                <span className="kbd">A</span>
                غطس يسار 🧤
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dramatic Finished Winner Card */}
      {isFinished && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
          <div
            data-testid="shootout-winner-card"
            className="glass-strong anim-goal-pop flex w-full max-w-lg flex-col items-center rounded-3xl border-2 border-amber-300/80 p-6 text-center shadow-[0_0_48px_rgba(251,191,36,0.4)]"
          >
            <div className="anim-float mb-2 flex items-center gap-2 rounded-full border border-amber-300/70 bg-amber-400/15 px-4 py-1 text-xs font-black text-amber-200">
              <Trophy size={15} /> بطل ركلات الترجيح! 🏆
            </div>

            <h2
              className="font-display text-4xl font-black text-white text-glow-gold"
              style={
                shootout.winner
                  ? { textShadow: `0 0 26px ${TEAM_HEX[shootout.winner]}` }
                  : undefined
              }
            >
              {shootout.winner
                ? `${TEAM_NAMES[shootout.winner]} حسموا الترجيح!`
                : 'نهاية ركلات الترجيح!'}
            </h2>

            {shootout.headline && (
              <p className="mt-1.5 text-sm font-bold text-slate-200">{shootout.headline}</p>
            )}

            <div className="my-4 flex items-center gap-6 font-display text-6xl leading-none font-black tabular-nums">
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs font-black" style={{ color: TEAM_HEX.red }}>
                  {TEAM_NAMES.red}
                </span>
                <span style={{ color: '#fff', textShadow: `0 0 24px ${TEAM_HEX.red}` }}>
                  {shootout.shootoutScore.red}
                </span>
              </div>
              <span className="text-3xl text-slate-500">-</span>
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs font-black" style={{ color: TEAM_HEX.blue }}>
                  {TEAM_NAMES.blue}
                </span>
                <span style={{ color: '#fff', textShadow: `0 0 24px ${TEAM_HEX.blue}` }}>
                  {shootout.shootoutScore.blue}
                </span>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                data-testid="shootout-rematch-btn"
                onClick={() => dispatch({ type: 'startPenaltyShootout', fromDraw: false })}
                className="pointer-events-auto btn-cta h-12 px-6 text-base font-black"
              >
                <RotateCcw size={18} />
                إعادة الترجيح 🔁
              </button>
              <button
                type="button"
                data-testid="shootout-menu-btn"
                onClick={handleReturnMenu}
                className="pointer-events-auto btn-ghost h-12 gap-2 px-5 text-sm font-black"
              >
                <Home size={18} />
                القائمة الرئيسية
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SetPieceHUD() {
  const phase = useGameStore((s) => s.phase);

  if (phase === 'free_kick_setup') {
    return <FreeKickBanner />;
  }

  if (phase === 'penalty_shootout') {
    return <PenaltyShootoutOverlay />;
  }

  return null;
}
