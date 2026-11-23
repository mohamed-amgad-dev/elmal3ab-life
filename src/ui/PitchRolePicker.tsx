import type { ReactNode } from 'react';
import { Camera, Gamepad2, Lock, Shield } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type {
  CameraMode,
  ControlMode,
  HumanSlotConfig,
  OutfieldPosition,
  RoleType,
  TeamId,
} from '../types/game';
import {
  CAMERA_LABEL,
  TEAM_HEX,
  TEAM_NAMES,
  TEAM_TEXT,
  allowedCamerasFor,
  isRoleAvailable,
} from './uiKit';

interface SlotDef {
  key: string;
  team: TeamId;
  role: RoleType;
  pos?: OutfieldPosition;
  emoji: string;
  label: string;
  /** percentage coordinates inside the pitch (left/top) — null if placed outside */
  at?: { left: number; top: number };
}

// Red defends the right goal (RTL reading order), Blue the left.
const PITCH_SLOTS: SlotDef[] = [
  { key: 'red-gk', team: 'red', role: 'goalkeeper', emoji: '🧤', label: 'حارس مرمى', at: { left: 91, top: 50 } },
  { key: 'red-def', team: 'red', role: 'outfield', pos: 'defender', emoji: '🛡️', label: 'مدافع', at: { left: 74, top: 26 } },
  { key: 'red-st', team: 'red', role: 'outfield', pos: 'striker', emoji: '⚽', label: 'مهاجم', at: { left: 64, top: 74 } },
  { key: 'blue-gk', team: 'blue', role: 'goalkeeper', emoji: '🧤', label: 'حارس مرمى', at: { left: 9, top: 50 } },
  { key: 'blue-def', team: 'blue', role: 'outfield', pos: 'defender', emoji: '🛡️', label: 'مدافع', at: { left: 26, top: 74 } },
  { key: 'blue-st', team: 'blue', role: 'outfield', pos: 'striker', emoji: '⚽', label: 'مهاجم', at: { left: 36, top: 26 } },
  { key: 'ref', team: 'red', role: 'referee', emoji: '🟨', label: 'الحكم', at: { left: 50, top: 50 } },
];

const COACH_SLOTS: SlotDef[] = [
  { key: 'red-coach', team: 'red', role: 'coach', emoji: '🧥', label: 'المدرب' },
  { key: 'blue-coach', team: 'blue', role: 'coach', emoji: '🧥', label: 'المدرب' },
];

const SPECTATOR_SLOT: SlotDef = {
  key: 'spec',
  team: 'red',
  role: 'spectator',
  emoji: '🏟️',
  label: 'المدرجات',
};

function defaultCamera(role: RoleType, cams: CameraMode[]): CameraMode {
  const preferred: Record<RoleType, CameraMode> = {
    outfield: 'player_third',
    goalkeeper: 'gk_first_person',
    referee: 'referee_cam',
    coach: 'coach_touchline',
    spectator: 'stands_cam',
  };
  return cams.includes(preferred[role]) ? preferred[role] : cams[0];
}

function SlotButton({
  def,
  selected,
  disabled,
  onSelect,
  absolute,
  note,
}: {
  def: SlotDef;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  absolute?: boolean;
  note?: ReactNode;
}) {
  const color = def.role === 'referee' ? '#fbbf24' : TEAM_HEX[def.team];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      title={disabled ? 'متاح لما الأدمن يفعّله' : def.label}
      className={`group flex flex-col items-center gap-1 transition ${
        absolute ? 'absolute -translate-x-1/2 -translate-y-1/2' : ''
      } ${disabled ? 'opacity-35 grayscale' : ''}`}
      style={absolute && def.at ? { left: `${def.at.left}%`, top: `${def.at.top}%` } : undefined}
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full border-2 text-xl transition group-hover:scale-110 ${
          selected ? 'scale-110' : ''
        }`}
        style={{
          borderColor: color,
          background: selected ? color : 'rgba(2,6,23,0.8)',
          boxShadow: selected ? `0 0 0 3px rgba(255,255,255,0.85), 0 0 22px ${color}` : `0 0 10px ${color}66`,
        }}
      >
        {def.emoji}
      </span>
      <span
        className={`rounded-md px-1.5 py-0.5 text-[11px] leading-none font-black whitespace-nowrap ${
          selected ? 'bg-white text-slate-900' : 'bg-slate-950/80 text-white'
        }`}
      >
        {def.label}
      </span>
      {note}
    </button>
  );
}

export default function PitchRolePicker() {
  const rules = useGameStore((s) => s.rules);
  const slot = useGameStore((s) => s.humanSlot);
  const setHumanSlot = useGameStore((s) => s.setHumanSlot);

  const choose = (patch: Partial<HumanSlotConfig> & Pick<HumanSlotConfig, 'role'>) => {
    const cams = allowedCamerasFor(patch.role, rules);
    const controlMode: ControlMode =
      patch.role === 'outfield' && rules.allowTeamSwitch ? slot.controlMode : 'locked_player';
    setHumanSlot({
      team: slot.team,
      positionRole: slot.positionRole,
      ...patch,
      controlMode: patch.role === 'outfield' ? controlMode : 'locked_player',
      cameraMode: defaultCamera(patch.role, cams),
      isBenched: false,
    });
  };

  const isSelected = (d: SlotDef) =>
    slot.role === d.role &&
    (d.role === 'referee' ||
      d.role === 'spectator' ||
      (slot.team === d.team && (d.role !== 'outfield' || slot.positionRole === d.pos)));

  const pickSlot = (d: SlotDef) =>
    choose({
      role: d.role,
      team: d.role === 'referee' || d.role === 'spectator' ? slot.team : d.team,
      positionRole: d.pos ?? slot.positionRole,
    });

  const CoachCell = ({ def }: { def: SlotDef }) => (
    <div className="flex items-center gap-2">
      <span className={`text-[11px] font-black ${TEAM_TEXT[def.team]}`}>{TEAM_NAMES[def.team]}</span>
      <SlotButton
        def={def}
        selected={isSelected(def)}
        disabled={!isRoleAvailable('coach', rules)}
        onSelect={() => pickSlot(def)}
      />
    </div>
  );

  const cams = allowedCamerasFor(slot.role, rules, slot.isBenched);
  const isGK = slot.role === 'goalkeeper';
  const controlLocked = slot.role !== 'outfield' || !rules.allowTeamSwitch;

  const roleSummary = (() => {
    const team = TEAM_NAMES[slot.team];
    switch (slot.role) {
      case 'goalkeeper':
        return `حارس مرمى — ${team}`;
      case 'outfield':
        return `${slot.positionRole === 'striker' ? 'مهاجم' : 'مدافع'} — ${team}`;
      case 'coach':
        return `المدرب — ${team}`;
      case 'referee':
        return 'الحكم 🟨';
      case 'spectator':
        return 'المدرجات 🏟️';
    }
  })();

  return (
    <section className="glass flex min-h-0 flex-col rounded-3xl">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield size={20} className="text-emerald-300" />
          <h2 className="text-lg font-black text-white">اختار مكانك في الملعب</h2>
        </div>
        <div className="rounded-full border border-amber-300/60 bg-amber-400/10 px-3 py-1 text-xs font-black text-amber-200">
          مكانك: {roleSummary}
        </div>
      </header>

      <div className="flex flex-col gap-2 p-3">
        {/* mini pitch */}
        <div className="mini-pitch relative mx-auto aspect-[2/1] max-h-[280px] w-full rounded-2xl">
          {/* markings */}
          <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white/50" />
          <div className="absolute top-1/2 left-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/50" />
          <div className="absolute top-1/2 right-0 h-[56%] w-[16%] -translate-y-1/2 rounded-s-md border-2 border-e-0 border-white/50" />
          <div className="absolute top-1/2 left-0 h-[56%] w-[16%] -translate-y-1/2 rounded-e-md border-2 border-s-0 border-white/50" />
          <div className="absolute top-1/2 right-0 h-[26%] w-[6%] -translate-y-1/2 border-2 border-e-0 border-white/60" style={{ background: `${TEAM_HEX.red}33` }} />
          <div className="absolute top-1/2 left-0 h-[26%] w-[6%] -translate-y-1/2 border-2 border-s-0 border-white/60" style={{ background: `${TEAM_HEX.blue}33` }} />

          {/* team banners */}
          <div className={`absolute top-2 right-3 text-[11px] font-black ${TEAM_TEXT.red} rounded bg-slate-950/70 px-2 py-0.5`}>
            🦅 {TEAM_NAMES.red}
          </div>
          <div className={`absolute top-2 left-3 text-[11px] font-black ${TEAM_TEXT.blue} rounded bg-slate-950/70 px-2 py-0.5`}>
            🌊 {TEAM_NAMES.blue}
          </div>

          {PITCH_SLOTS.map((d) => (
            <SlotButton
              key={d.key}
              def={d}
              absolute
              selected={isSelected(d)}
              disabled={!isRoleAvailable(d.role, rules)}
              onSelect={() => pickSlot(d)}
              note={
                d.role === 'goalkeeper' ? (
                  <span className="flex items-center gap-1 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] leading-none font-black whitespace-nowrap text-slate-900">
                    <Lock size={9} /> منظور شخصي فقط 🧤
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>

        {/* coach strip */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-slate-900/40 px-4 py-2">
          <CoachCell def={COACH_SLOTS[0]} />
          <SlotButton
            def={SPECTATOR_SLOT}
            selected={slot.role === 'spectator'}
            onSelect={() => pickSlot(SPECTATOR_SLOT)}
          />
          <CoachCell def={COACH_SLOTS[1]} />
        </div>

        {/* control + camera pills */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl border border-white/8 bg-slate-900/45 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-white">
              <Gamepad2 size={15} className="text-cyan-300" /> وضع التحكم
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                data-active={slot.controlMode === 'team_switch'}
                disabled={controlLocked}
                onClick={() => setHumanSlot({ controlMode: 'team_switch' })}
                className="pill px-3 py-1 text-xs"
              >
                تبديل اللعيبة (Q)
              </button>
              <button
                type="button"
                data-active={slot.controlMode === 'locked_player'}
                onClick={() => setHumanSlot({ controlMode: 'locked_player' })}
                className="pill px-3 py-1 text-xs"
              >
                لاعب واحد مقفول
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/8 bg-slate-900/45 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-white">
              <Camera size={15} className="text-cyan-300" /> وضع الكاميرا
              {isGK && <Lock size={12} className="text-amber-300" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cams.map((c) => (
                <button
                  key={c}
                  type="button"
                  data-active={slot.cameraMode === c}
                  data-tone="cyan"
                  onClick={() => setHumanSlot({ cameraMode: c })}
                  className="pill px-3 py-1 text-xs"
                >
                  {CAMERA_LABEL[c]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
