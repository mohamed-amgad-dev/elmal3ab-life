import type { ReactNode } from 'react';
import { CheckCircle2, Target, Theater, Tv, Goal } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { VARVerdict } from '../types/game';

const VERDICTS: { verdict: VARVerdict; label: string; icon: ReactNode; cls: string }[] = [
  { verdict: 'goal_valid', label: 'احتساب الهدف ⚽', icon: <Goal size={18} />, cls: 'border-emerald-400/70 text-emerald-200 hover:bg-emerald-500/20' },
  { verdict: 'penalty_awarded', label: 'ركلة جزاء 🎯', icon: <Target size={18} />, cls: 'border-rose-400/70 text-rose-200 hover:bg-rose-500/20' },
  { verdict: 'play_on', label: 'العب مفيش حاجة ✅', icon: <CheckCircle2 size={18} />, cls: 'border-sky-400/70 text-sky-200 hover:bg-sky-500/20' },
  { verdict: 'yellow_for_dive', label: 'كارت أصفر للغطس! 🎭🟨', icon: <Theater size={18} />, cls: 'border-amber-300/70 text-amber-200 hover:bg-amber-400/20' },
];

export default function VAROverlay() {
  const varState = useGameStore((s) => s.varState);
  const phase = useGameStore((s) => s.phase);
  const role = useGameStore((s) => s.humanSlot.role);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  if (!varState.active && phase !== 'var_review') return null;

  const pct = Math.max(0, Math.min(100, (varState.progress > 1 ? varState.progress : varState.progress * 100)));
  const isRef = role === 'referee';

  return (
    <div className="absolute inset-0 anim-fade-in">
      {/* broadcast frame + scanlines */}
      <div className="var-scanlines absolute inset-0" />
      <div
        className="anim-var-pulse absolute inset-2 rounded-3xl border-2 border-cyan-300/70"
        style={{ boxShadow: 'inset 0 0 90px rgba(0,194,255,0.22)' }}
      />
      <div className="anim-var-scan absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-transparent via-cyan-300/25 to-transparent" />

      {/* top banner */}
      <div className="absolute top-[104px] left-1/2 -translate-x-1/2">
        <div className="anim-var-pulse flex items-center gap-3 rounded-2xl border border-cyan-300/70 bg-slate-950/85 px-6 py-2.5 backdrop-blur-md">
          <span className="rounded-md bg-cyan-400 px-2 py-0.5 font-display text-xl leading-tight font-black text-slate-950">VAR</span>
          <Tv size={22} className="text-cyan-300" />
          <span className="text-xl font-black text-white text-glow-cyan">📺 جاري مراجعة الفار — إعادة بطيئة</span>
          <span className="flex items-center gap-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-[11px] font-black text-white">
            <span className="h-1.5 w-1.5 rounded-full bg-white anim-blink" /> REPLAY
          </span>
        </div>
      </div>

      {/* bottom decision panel */}
      <div className="pe-auto absolute bottom-4 left-1/2 w-[780px] max-w-[calc(100vw-24px)] -translate-x-1/2">
        <div className="glass-strong rounded-2xl border-cyan-300/50 p-4" style={{ borderColor: 'rgba(0,194,255,0.5)' }}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="min-w-0 text-base font-black text-white">
              <span className="text-cyan-300">سبب المراجعة: </span>
              {varState.reason || 'لحظة مشكوك فيها.. والحكم بيبص في الشاشة 👀'}
            </p>
            <span className="shrink-0 font-display text-lg font-black text-cyan-300 tabular-nums" dir="ltr">
              {Math.round(pct)}%
            </span>
          </div>

          <div className="mb-3 h-3 overflow-hidden rounded-full border border-cyan-300/30 bg-slate-950/80">
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#0891b2,#00c2ff,#7dd3fc)', boxShadow: '0 0 14px #00c2ff' }}
            />
          </div>

          <div className="mb-2 text-xs font-bold text-slate-400">
            {isRef ? 'القرار قرارك يا حكم! اختار:' : 'الحكم بيقرر.. أو أي حد متحمس يضغط 😂'}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {VERDICTS.map((v) => (
              <button
                key={v.verdict}
                type="button"
                onClick={() => dispatch({ type: 'refVARVerdict', verdict: v.verdict })}
                className={`btn-ghost min-h-[3.25rem] flex-col gap-1 px-2 py-2 text-center text-[13px] leading-tight ${v.cls}`}
              >
                {v.icon}
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
