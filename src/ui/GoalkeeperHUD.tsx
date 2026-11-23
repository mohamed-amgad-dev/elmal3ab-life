import { Crosshair, Hand } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { KeyPill } from './uiKit';

export default function GoalkeeperHUD() {
  const cooldown = useGameStore((s) => s.gkDiveCooldown);
  const ready = cooldown <= 0.05;

  return (
    <>
      {/* subtle reticle in view centre (kept tiny so the pitch stays visible) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className={`relative h-14 w-14 rounded-full border-2 transition ${ready ? 'border-emerald-300/70' : 'border-rose-400/60'}`}>
          <span className={`absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${ready ? 'bg-emerald-300' : 'bg-rose-400'}`} />
          <span className="absolute -left-3 top-1/2 h-0.5 w-2.5 -translate-y-1/2 bg-white/60" />
          <span className="absolute -right-3 top-1/2 h-0.5 w-2.5 -translate-y-1/2 bg-white/60" />
        </div>
      </div>

      <div className="absolute bottom-3 left-1/2 flex w-[760px] max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-amber-300/70 bg-amber-400/15 px-3 py-1 text-xs font-black text-amber-200 backdrop-blur-md">
            <Hand size={14} /> منظور شخصي 🧤 FP
          </span>
          <span
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black whitespace-nowrap backdrop-blur-md ${
              ready
                ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-200 glow-emerald'
                : 'border-rose-400/60 bg-rose-500/15 text-rose-200'
            }`}
          >
            <Crosshair size={14} />
            {ready ? 'جاهز للطيران! ✈️' : `الطيران بيستريح ${cooldown.toFixed(1)}ث`}
          </span>
        </div>

        <div className="glass flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-2xl px-4 py-2.5">
          <span className="text-sm font-black text-white">
            طير يمين/شمال: <span className="text-amber-300">Space + A/D</span> أو الماوس! — تشتيت: <span className="text-amber-300">E</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <KeyPill k="A / D" label="يمين / شمال" />
          <KeyPill k="Space" label="طيران" dim={!ready} />
          <KeyPill k="E" label="تشتيت" />
        </div>
      </div>
    </>
  );
}
