import { X } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { QUICK_CHAT_PHRASES } from '../types/game';

/** 8-phrase Egyptian quick-chat card. Toggled with `B` / HUD button; phrases also map to keys 1..8. */
export default function QuickChatWheel() {
  const open = useGameStore((s) => s.isQuickChatOpen);
  const setOpen = useGameStore((s) => s.setQuickChatOpen);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  if (!open) return null;

  const say = (phraseId: string) => {
    dispatch({ type: 'quickChat', phraseId });
    setOpen(false);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[172px] flex justify-center">
      <div
        role="dialog"
        aria-label="شات سريع"
        className="pe-auto glass-strong anim-pop-in w-[640px] max-w-[calc(100vw-24px)] rounded-3xl border border-cyan-300/40 p-3"
        style={{ boxShadow: '0 0 28px rgba(34,211,238,0.28)' }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-black text-white">
            💬 شات سريع <span className="text-[11px] font-bold text-slate-400">• اضغط رقم الجملة أو كليك عليها</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="إغلاق الشات السريع"
            className="btn-ghost h-7 w-7 shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {QUICK_CHAT_PHRASES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => say(p.id)}
              className="group relative flex h-[74px] flex-col items-center justify-center gap-1 rounded-2xl border border-white/12 bg-slate-900/70 px-1.5 text-center transition hover:-translate-y-0.5 hover:border-cyan-300/70 hover:bg-cyan-500/15"
            >
              <span className="kbd absolute top-1.5 start-1.5">{p.key}</span>
              <span className="text-2xl leading-none">{p.emoji}</span>
              <span className="text-[12px] leading-tight font-black text-slate-100">{p.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
