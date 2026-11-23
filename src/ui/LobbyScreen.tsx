import { useEffect } from 'react';
import { ArrowRight, Keyboard, Rocket } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import AdminSettingsPanel from './AdminSettingsPanel';
import PitchRolePicker from './PitchRolePicker';
import { MuteButton, sanitizeSlot } from './uiKit';

export default function LobbyScreen() {
  const rules = useGameStore((s) => s.rules);
  const slot = useGameStore((s) => s.humanSlot);
  const setHumanSlot = useGameStore((s) => s.setHumanSlot);
  const setPhase = useGameStore((s) => s.setPhase);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const dispatchCommand = useGameStore((s) => s.dispatchCommand);

  // Keep the human slot legal whenever the Admin rules (cameras / switch / ref / coach) change.
  useEffect(() => {
    const patch = sanitizeSlot(slot, rules);
    if (patch) setHumanSlot(patch);
  }, [rules, slot, setHumanSlot]);

  return (
    <div className="pe-auto absolute inset-0 flex flex-col bg-slate-950/55 backdrop-blur-[3px] anim-fade-in">
      {/* top bar */}
      <header className="flex shrink-0 items-center justify-between gap-4 px-6 pt-4 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-3xl font-black text-white">
            لوبي <span className="text-amber-300 text-glow-gold">الملعب لايف</span> ⚽
          </h1>
          <span className="text-sm font-bold text-slate-400">جهّز الروم واختار مكانك قبل الصافرة</span>
        </div>
        <div className="flex items-center gap-2">
          <MuteButton />
          <button
            type="button"
            onClick={() => setControlsOpen(true)}
            className="btn-ghost h-11 gap-2 px-4 text-sm"
          >
            <Keyboard size={18} className="text-cyan-300" />
            دليل التحكم
          </button>
        </div>
      </header>

      {/* body */}
      <main className="grid min-h-0 flex-1 grid-cols-[400px_minmax(0,1fr)] gap-5 px-6 pb-3">
        <AdminSettingsPanel />
        <div className="thin-scroll min-h-0 overflow-y-auto">
          <PitchRolePicker />
        </div>
      </main>

      {/* bottom action bar */}
      <footer className="glass-strong flex shrink-0 items-center justify-between gap-4 rounded-none border-x-0 border-b-0 px-6 py-3">
        <button
          type="button"
          onClick={() => setPhase('menu')}
          className="btn-ghost h-14 gap-2 px-6 text-base"
        >
          <ArrowRight size={20} />
          رجوع للقائمة
        </button>

        <button
          type="button"
          onClick={() => dispatchCommand({ type: 'startMatch' })}
          className="btn-cta anim-cta-pulse h-16 min-w-[340px] px-10 text-3xl"
        >
          <Rocket size={28} />
          صفّارة البداية! 🚀
        </button>

        <div className="hidden w-[170px] text-end text-xs font-bold text-slate-400 md:block">
          {rules.teamSize} ضد {rules.teamSize} • {Math.round(rules.matchDurationSec / 60)} دقايق
        </div>
      </footer>
    </div>
  );
}
