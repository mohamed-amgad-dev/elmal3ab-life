import type { ReactNode } from 'react';
import {
  Camera,
  Clapperboard,
  Clock,
  Flame,
  Laugh,
  RefreshCw,
  Settings2,
  Shield,
  ShieldCheck,
  Shirt,
  Swords,
  Theater,
  Tv,
  Users,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { AdminRules } from '../types/game';

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-slate-900/45 p-3">
      <div className="mb-2 flex items-start gap-2">
        <span className="mt-0.5 text-cyan-300">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-black text-white">{title}</div>
          {desc && <div className="text-[11px] font-semibold text-slate-400">{desc}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Opt({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: 'gold' | 'cyan';
}) {
  return (
    <button
      type="button"
      data-active={active}
      data-tone={tone}
      onClick={onClick}
      className="pill px-3 py-1.5 text-xs"
    >
      {children}
    </button>
  );
}

function Toggle({
  icon,
  title,
  desc,
  value,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-start transition ${
        value
          ? 'border-emerald-400/60 bg-emerald-500/10 shadow-[0_0_16px_rgba(16,185,129,0.25)]'
          : 'border-white/8 bg-slate-900/45 hover:border-cyan-400/40'
      }`}
    >
      <span className={value ? 'text-emerald-300' : 'text-slate-500'}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-black text-white">{title}</span>
        <span className="block text-[11px] leading-snug font-semibold text-slate-400">{desc}</span>
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          value ? 'bg-emerald-500' : 'bg-slate-700'
        }`}
        dir="ltr"
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            value ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  );
}

export default function AdminSettingsPanel() {
  const rules = useGameStore((s) => s.rules);
  const setRules = useGameStore((s) => s.setRules);
  const applyPreset = useGameStore((s) => s.applyPreset);

  const set = (p: Partial<AdminRules>) => setRules(p);

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-3xl">
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Settings2 size={20} className="text-amber-300" />
        <h2 className="text-lg font-black text-white">إعدادات الأدمن</h2>
      </header>

      <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <Row icon={<Clapperboard size={18} />} title="نظام اللعب الجاهز">
          <Opt active={rules.preset === 'chaos'} onClick={() => applyPreset('chaos')}>
            <Flame size={14} /> ملعب الضحك 🔥
          </Opt>
          <Opt active={rules.preset === 'classic'} onClick={() => applyPreset('classic')}>
            <Shield size={14} /> ماتش كلاسيك ⚽
          </Opt>
          <Opt active={rules.preset === 'custom'} tone="gold" onClick={() => set({ preset: 'custom' })}>
            <Settings2 size={14} /> مخصص ⚙️
          </Opt>
        </Row>

        <div className="grid grid-cols-2 gap-2.5">
          <Row icon={<Users size={18} />} title="عدد اللعيبة">
            <Opt active={rules.teamSize === 2} onClick={() => set({ teamSize: 2 })}>
              2 ضد 2
            </Opt>
            <Opt active={rules.teamSize === 3} onClick={() => set({ teamSize: 3 })}>
              3 ضد 3
            </Opt>
          </Row>
          <Row icon={<Clock size={18} />} title="مدة الماتش">
            <Opt active={rules.matchDurationSec === 120} onClick={() => set({ matchDurationSec: 120 })}>
              2 دقايق
            </Opt>
            <Opt active={rules.matchDurationSec === 180} onClick={() => set({ matchDurationSec: 180 })}>
              3 دقايق
            </Opt>
            <Opt active={rules.matchDurationSec === 300} onClick={() => set({ matchDurationSec: 300 })}>
              5 دقايق
            </Opt>
          </Row>
        </div>

        <Row icon={<RefreshCw size={18} />} title="التحكم في اللعيبة">
          <Opt active={rules.allowTeamSwitch} onClick={() => set({ allowTeamSwitch: true })}>
            تبديل اللعيبة (PES)
          </Opt>
          <Opt active={!rules.allowTeamSwitch} onClick={() => set({ allowTeamSwitch: false })}>
            لاعب واحد مقفول 🔒
          </Opt>
        </Row>

        <Row icon={<Camera size={18} />} title="الكاميرات المسموحة">
          <Opt active={rules.allowedCameras === 'both'} tone="cyan" onClick={() => set({ allowedCameras: 'both' })}>
            الاتنين
          </Opt>
          <Opt active={rules.allowedCameras === 'top_only'} tone="cyan" onClick={() => set({ allowedCameras: 'top_only' })}>
            علوي فقط
          </Opt>
          <Opt active={rules.allowedCameras === 'player_only'} tone="cyan" onClick={() => set({ allowedCameras: 'player_only' })}>
            منظور لاعب فقط
          </Opt>
        </Row>

        <Toggle
          icon={<ShieldCheck size={20} />}
          title="حكم بشري"
          desc="واحد من الشلة ياخد الصافرة والكروت"
          value={rules.enableHumanRef}
          onChange={(v) => set({ enableHumanRef: v })}
        />
        <Toggle
          icon={<Laugh size={20} />}
          title="تحكيم مصري حر 😂"
          desc="بلنتيات بمزاجك — الحكم حر!"
          value={rules.freeEgyptianRef}
          onChange={(v) => set({ freeEgyptianRef: v })}
        />
        <Toggle
          icon={<Tv size={20} />}
          title="غرفة الفار VAR"
          desc="مراجعة وإعادة بطيئة قبل القرار"
          value={rules.enableVAR}
          onChange={(v) => set({ enableVAR: v })}
        />
        <Toggle
          icon={<Shirt size={20} />}
          title="المدرب ودكة البدلاء"
          desc="تكتيكات وتبديلات على الدكة"
          value={rules.enableCoachBench}
          onChange={(v) => set({ enableCoachBench: v })}
        />
        <Toggle
          icon={<Theater size={20} />}
          title="التمثيل والغطس والشغب"
          desc="V غطس! و R شغب! شغالين"
          value={rules.enableDivingAndProtests}
          onChange={(v) => set({ enableDivingAndProtests: v })}
        />
        <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold text-slate-500">
          <Swords size={12} /> أي تعديل بيحوّل النظام لـ «مخصص» تلقائيًا
        </div>
      </div>
    </section>
  );
}
