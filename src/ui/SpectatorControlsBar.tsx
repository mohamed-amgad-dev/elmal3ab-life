import { Flame, Megaphone, Sparkles } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';

export default function SpectatorControlsBar() {
  const activeCamera = useGameStore((s) => s.activeCamera);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
      <div className="glass flex items-center gap-3 rounded-2xl px-3 py-2.5">
        <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/60 p-1">
          <button
            type="button"
            data-active={activeCamera === 'stands_cam'}
            data-tone="cyan"
            onClick={() => dispatch({ type: 'switchCamera', camera: 'stands_cam' })}
            className="pill px-3 py-1.5 text-xs"
          >
            🏟️ المدرج
          </button>
          <button
            type="button"
            data-active={activeCamera === 'broadcast_top'}
            data-tone="cyan"
            onClick={() => dispatch({ type: 'switchCamera', camera: 'broadcast_top' })}
            className="pill px-3 py-1.5 text-xs"
          >
            📹 علوي
          </button>
        </div>

        <span className="h-8 w-px bg-white/15" />

        <button
          type="button"
          onClick={() => dispatch({ type: 'spectatorCheer' })}
          className="btn-ghost h-11 gap-2 border-emerald-400/60 px-4 text-sm text-emerald-200 hover:bg-emerald-500/20"
        >
          <Flame size={18} /> تشجيع 🎉
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'spectatorBoo' })}
          className="btn-ghost h-11 gap-2 border-rose-400/60 px-4 text-sm text-rose-200 hover:bg-rose-500/20"
        >
          <Megaphone size={18} /> تصفير واستهجان 📣
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'spectatorFireworks' })}
          className="btn-ghost h-11 gap-2 border-amber-300/60 px-4 text-sm text-amber-200 hover:bg-amber-400/20"
        >
          <Sparkles size={18} /> ألعاب نارية 🎆
        </button>
      </div>
    </div>
  );
}
