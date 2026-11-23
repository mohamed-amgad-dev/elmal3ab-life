import { Keyboard, Play, RotateCcw, Users } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { ModalShell } from './uiKit';

export default function PauseModal() {
  const dispatch = useGameStore((s) => s.dispatchCommand);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const resume = () => dispatch({ type: 'togglePause' });

  return (
    <ModalShell maxWidth="max-w-md" onBackdrop={resume}>
      <div className="p-6">
        <div className="mb-5 text-center">
          <div className="text-5xl">⏸️</div>
          <h2 className="mt-1 font-display text-3xl font-black text-white text-glow-gold">الماتش واقف</h2>
          <p className="text-sm font-bold text-slate-400">خد نفسك يا كابتن.. الجمهور مستني ☕</p>
        </div>

        <div className="flex flex-col gap-3">
          <button type="button" onClick={resume} className="btn-cta h-14 text-xl">
            <Play size={22} /> كمّل الماتش ▶️
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'returnToLobby' })}
            className="btn-ghost h-12 text-base"
          >
            <Users size={18} className="text-cyan-300" /> غيّر الدور / رجوع للّوبي
          </button>
          <button type="button" onClick={() => setControlsOpen(true)} className="btn-ghost h-12 text-base">
            <Keyboard size={18} className="text-amber-300" /> دليل التحكم
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'restartMatch' })}
            className="btn-ghost h-12 border-rose-400/40 text-base text-rose-200 hover:bg-rose-500/15"
          >
            <RotateCcw size={18} /> ابدأ الماتش من الأول 🔄
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
