import { Flame, Gamepad2, Keyboard, Sparkles, Trophy } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { DEFAULT_HUMAN_SLOT } from '../types/game';
import { MuteButton } from './uiKit';

export default function MainMenu() {
  const setPhase = useGameStore((s) => s.setPhase);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const applyPreset = useGameStore((s) => s.applyPreset);
  const setHumanSlot = useGameStore((s) => s.setHumanSlot);
  const dispatchCommand = useGameStore((s) => s.dispatchCommand);

  const quickPlay = () => {
    applyPreset('chaos');
    setHumanSlot({ ...DEFAULT_HUMAN_SLOT });
    dispatchCommand({ type: 'startMatch' });
  };

  return (
    <div className="absolute inset-0 anim-fade-in">
      <div className="hero-vignette absolute inset-0" />

      {/* corner utilities */}
      <div className="absolute top-5 left-5 flex items-center gap-2">
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

      <div className="absolute top-5 right-5 flex items-center gap-2 rounded-full glass px-4 py-2 text-xs font-bold text-slate-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400 anim-blink" />
        بث مباشر من الاستاد 🌙
      </div>

      {/* hero */}
      <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center text-center">
          <div className="anim-float mb-5 flex items-center gap-2 rounded-full border border-amber-300/50 bg-amber-400/10 px-4 py-1.5 text-sm font-black text-amber-300 backdrop-blur-md">
            <Trophy size={16} />
            كأس الضحك والفار — الموسم الأول
          </div>

          <h1
            className="anim-glow-breathe text-center font-display text-[88px] leading-[1.1] font-black text-white"
            style={{ textShadow: '0 4px 0 #065f46, 0 0 40px rgba(16,185,129,0.65)' }}
          >
            الملعب <span className="text-amber-300 text-glow-gold">لايف</span>
            <span className="mx-2 inline-block">⚽🌙</span>
          </h1>

          <p className="mt-3 rounded-2xl glass px-6 py-2 text-2xl font-bold text-emerald-200">
            كورة.. ضحك.. وفار على مزاجك!
          </p>
        </div>

        <div className="mt-10 flex w-full max-w-md flex-col gap-4">
          <button
            type="button"
            onClick={() => setPhase('lobby')}
            className="btn-cta anim-cta-pulse h-16 px-6 text-2xl"
          >
            <Gamepad2 size={28} />
            ادخل الملعب / إعداد الروم
          </button>

          <button
            type="button"
            onClick={quickPlay}
            className="btn-cta btn-fire h-14 px-6 text-xl"
          >
            <Flame size={24} />
            ماتش ضحك سريع! 🔥
          </button>

          <div className="flex items-center justify-center gap-2 text-xs font-semibold text-slate-300/80">
            <Sparkles size={14} className="text-amber-300" />
            حكم بشري • غرفة فار • غطس وشغب • مدرب ودكة
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 inset-x-0 text-center text-[11px] font-semibold text-slate-400/80">
        ElMal3abLife © الملعب لايف — اللعب على مسؤوليتك الضحكية
      </div>
    </div>
  );
}
