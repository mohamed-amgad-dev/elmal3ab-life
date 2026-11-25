import { Keyboard, LogOut, MousePointer, Play, RotateCcw, Sparkles, Users } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import {
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  type GraphicsQuality,
} from '../types/game';
import { dismissInviteAutoJoin, getNet } from './networkBridge';
import { ModalShell } from './uiKit';

const QUALITY_OPTIONS: ReadonlyArray<{ id: GraphicsQuality; label: string }> = [
  { id: 'high', label: 'عالي' },
  { id: 'medium', label: 'متوسط' },
  { id: 'low', label: 'خفيف' },
];

export default function PauseModal() {
  const dispatch = useGameStore((s) => s.dispatchCommand);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const mouseSensitivity = useGameStore((s) => s.mouseSensitivity);
  const setMouseSensitivity = useGameStore((s) => s.setMouseSensitivity);
  const graphicsQuality = useGameStore((s) => s.graphicsQuality);
  const setGraphicsQuality = useGameStore((s) => s.setGraphicsQuality);
  const network = useGameStore((s) => s.network);
  const isGuest = network.mode === 'guest';

  const resume = () => dispatch({ type: 'togglePause' });

  const handleLeaveGuestToLobby = () => {
    dismissInviteAutoJoin();
    getNet()?.disconnect();
    dispatch({ type: 'returnToLobby' });
  };

  const handleSensitivity = (value: number) => {
    setMouseSensitivity(value);
    dispatch({ type: 'setMouseSensitivity', value });
  };

  const handleQuality = (quality: GraphicsQuality) => {
    setGraphicsQuality(quality);
    dispatch({ type: 'setGraphicsQuality', quality });
  };

  return (
    <ModalShell maxWidth="max-w-md" onBackdrop={resume}>
      <div className="p-6">
        <div className="mb-4 text-center">
          <div className="text-5xl">⏸️</div>
          <h2 className="mt-1 font-display text-3xl font-black text-white text-glow-gold">الماتش واقف</h2>
          <p className="text-sm font-bold text-slate-400">خد نفسك يا كابتن.. الجمهور مستني ☕</p>
        </div>

        {/* Settings: Mouse Sensitivity & Graphics Quality */}
        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/55 p-3.5">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs font-black text-white">
              <span className="flex items-center gap-1.5">
                <MousePointer size={14} className="text-cyan-300" />
                حساسية الماوس
              </span>
              <span dir="ltr" className="rounded-md bg-slate-950/80 px-2 py-0.5 font-mono text-amber-300 tabular-nums">
                {mouseSensitivity.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              dir="ltr"
              min={MIN_MOUSE_SENSITIVITY}
              max={MAX_MOUSE_SENSITIVITY}
              step={0.1}
              value={mouseSensitivity}
              aria-label="حساسية الماوس"
              onChange={(e) => handleSensitivity(parseFloat(e.target.value))}
              className="h-2 w-full cursor-pointer accent-cyan-400"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-white">
              <Sparkles size={14} className="text-amber-300" />
              جودة الجرافيك
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {QUALITY_OPTIONS.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  data-active={graphicsQuality === q.id}
                  data-tone="cyan"
                  onClick={() => handleQuality(q.id)}
                  className="pill py-1.5 text-xs"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <button type="button" onClick={resume} className="btn-cta h-12 text-lg">
            <Play size={20} /> كمّل الماتش ▶️
          </button>
          {isGuest ? (
            <button
              type="button"
              onClick={handleLeaveGuestToLobby}
              className="btn-ghost h-11 border-rose-400/40 text-sm text-rose-200 hover:bg-rose-500/15"
            >
              <LogOut size={18} /> خروج من الروم للّوبي
            </button>
          ) : (
            <button
              type="button"
              onClick={() => dispatch({ type: 'returnToLobby' })}
              className="btn-ghost h-11 text-sm"
            >
              <Users size={18} className="text-cyan-300" /> غيّر الدور / رجوع للّوبي
            </button>
          )}
          <button type="button" onClick={() => setControlsOpen(true)} className="btn-ghost h-11 text-sm">
            <Keyboard size={18} className="text-amber-300" /> دليل التحكم
          </button>
          {!isGuest && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'restartMatch' })}
              className="btn-ghost h-11 border-rose-400/40 text-sm text-rose-200 hover:bg-rose-500/15"
            >
              <RotateCcw size={18} /> ابدأ الماتش من الأول 🔄
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
