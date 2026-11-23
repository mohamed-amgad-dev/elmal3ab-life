import { useGameStore } from './store/useGameStore';

export default function App() {
  const phase = useGameStore((s) => s.phase);
  const rules = useGameStore((s) => s.rules);

  return (
    <main className="flex h-full w-full flex-col items-center justify-center bg-[#050918] p-6 text-center text-white">
      <div className="rounded-2xl border border-emerald-400/30 bg-slate-900/80 px-8 py-6 shadow-2xl">
        <h1 className="text-4xl font-black tracking-tight text-amber-400">
          الملعب لايف — ElMal3abLife
        </h1>
        <p className="mt-2 text-base font-semibold text-emerald-300">
          جاري تجهيز الاستاد الليلي...
        </p>
        <p className="mt-3 text-xs text-slate-400">
          Phase: {phase} | Preset: {rules.preset}
        </p>
      </div>
    </main>
  );
}
