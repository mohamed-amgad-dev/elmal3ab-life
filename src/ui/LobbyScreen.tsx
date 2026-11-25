import { useEffect, useRef } from 'react';
import { ArrowRight, Keyboard, Rocket } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import AdminSettingsPanel from './AdminSettingsPanel';
import OnlineRoomPanel from './OnlineRoomPanel';
import PitchRolePicker from './PitchRolePicker';
import { dismissInviteAutoJoin, getNet } from './networkBridge';
import { MuteButton, sanitizeSlot } from './uiKit';

export default function LobbyScreen() {
  const rules = useGameStore((s) => s.rules);
  const slot = useGameStore((s) => s.humanSlot);
  const hostSlot = useGameStore((s) => s.hostSlot);
  const network = useGameStore((s) => s.network);
  const setHumanSlot = useGameStore((s) => s.setHumanSlot);
  const setPhase = useGameStore((s) => s.setPhase);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const dispatchCommand = useGameStore((s) => s.dispatchCommand);

  const isGuest = network.mode === 'guest';
  const isHost = network.mode === 'host';
  const linked = network.peerConnected || network.status === 'connected';

  // Keep the human slot legal whenever the Admin rules (cameras / switch / ref / coach) change.
  useEffect(() => {
    const patch = sanitizeSlot(slot, rules);
    if (patch) setHumanSlot(patch);
  }, [rules, slot, setHumanSlot]);

  // Host → Guest: push rules / slots whenever they change while a peer is connected.
  const lastHostSync = useRef('');
  useEffect(() => {
    if (!isHost || !linked) {
      lastHostSync.current = '';
      return;
    }
    const packet = { rules, hostSlot, guestSlot: network.guestSlot, phase: 'lobby' as const };
    const key = JSON.stringify(packet);
    if (key === lastHostSync.current) return;
    lastHostSync.current = key;
    getNet()?.sendLobbySync(packet);
  }, [isHost, linked, rules, hostSlot, network.guestSlot]);

  // Guest → Host: send the local slot choice whenever it changes.
  const lastGuestSlot = useRef('');
  useEffect(() => {
    if (!isGuest || !linked) {
      lastGuestSlot.current = '';
      return;
    }
    const key = JSON.stringify(slot);
    if (key === lastGuestSlot.current) return;
    lastGuestSlot.current = key;
    getNet()?.sendGuestSlotUpdate(slot);
  }, [isGuest, linked, slot]);

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
        <div className="thin-scroll flex min-h-0 flex-col gap-3 overflow-y-auto pe-1">
          <OnlineRoomPanel />
          <div className="flex min-h-[460px] flex-1 flex-col">
            {isGuest && (
              <div className="mb-1.5 flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-400/15 px-3 py-1 text-xs font-black text-amber-200">
                إعدادات الهوست 👑
                <span className="text-[10px] font-bold text-amber-100/80">• للعرض بس</span>
              </div>
            )}
            <div
              className={`flex min-h-0 flex-1 flex-col ${isGuest ? 'pointer-events-none opacity-75' : ''}`}
              aria-disabled={isGuest}
            >
              <AdminSettingsPanel />
            </div>
          </div>
        </div>
        <div className="thin-scroll min-h-0 overflow-y-auto">
          <PitchRolePicker />
        </div>
      </main>

      {/* bottom action bar */}
      <footer className="glass-strong flex shrink-0 items-center justify-between gap-4 rounded-none border-x-0 border-b-0 px-6 py-3">
        <button
          type="button"
          onClick={() => {
            dismissInviteAutoJoin();
            setPhase('menu');
          }}
          className="btn-ghost h-14 gap-2 px-6 text-base"
        >
          <ArrowRight size={20} />
          رجوع للقائمة
        </button>

        {isGuest ? (
          <div className="flex h-16 min-w-[340px] items-center justify-center rounded-2xl border border-violet-300/50 bg-violet-500/15 px-8 text-xl font-black whitespace-nowrap text-violet-100">
            مستني الهوست يصفّر البداية... ⏳
          </div>
        ) : (
          <button
            type="button"
            onClick={() => dispatchCommand({ type: 'startMatch' })}
            className="btn-cta anim-cta-pulse h-16 min-w-[340px] px-10 text-3xl"
          >
            <Rocket size={28} />
            صفّارة البداية! 🚀
          </button>
        )}

        <div className="hidden w-[170px] text-end text-xs font-bold text-slate-400 md:block">
          {rules.teamSize} ضد {rules.teamSize} • {Math.round(rules.matchDurationSec / 60)} دقايق
        </div>
      </footer>
    </div>
  );
}
