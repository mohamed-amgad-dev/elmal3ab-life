import { Droplets, Megaphone, Flame, PersonStanding } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';

const EMOTES = [
  { kind: 'rage' as const, label: 'تشويح وغضب 🤬', icon: <Flame size={18} />, cls: 'border-rose-400/60 text-rose-200 hover:bg-rose-500/20' },
  { kind: 'water' as const, label: 'اشرب مية 💧', icon: <Droplets size={18} />, cls: 'border-sky-400/60 text-sky-200 hover:bg-sky-500/20' },
  { kind: 'shout' as const, label: 'زعق للمدرب 📢', icon: <Megaphone size={18} />, cls: 'border-amber-300/60 text-amber-200 hover:bg-amber-400/20' },
];

export default function BenchEmoteBar() {
  const dispatch = useGameStore((s) => s.dispatchCommand);

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
      <div className="glass anim-pop-in flex flex-col items-center gap-2.5 rounded-2xl px-5 py-3" style={{ borderColor: 'rgba(167,139,250,0.5)' }}>
        <div className="text-center">
          <div className="text-lg font-black text-white">أنت على الدكة يا كابتن 🪑</div>
          <div className="text-xs font-bold text-slate-400">اتفرّج.. اتنرفز.. أو اطلب ترجع تلعب</div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {EMOTES.map((e) => (
            <button
              key={e.kind}
              type="button"
              onClick={() => dispatch({ type: 'benchEmote', kind: e.kind })}
              className={`btn-ghost h-11 gap-2 px-4 text-sm ${e.cls}`}
            >
              {e.icon}
              {e.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => dispatch({ type: 'benchRequestReturn' })}
            className="btn-cta h-11 gap-2 px-5 text-sm"
          >
            <PersonStanding size={18} />
            اطلب الرجوع للملعب 🏃
          </button>
        </div>
      </div>
    </div>
  );
}
