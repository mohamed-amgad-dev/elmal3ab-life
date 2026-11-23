import type { ReactNode } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type {
  AdminRules,
  CameraMode,
  HumanSlotConfig,
  RoleType,
  TacticalStance,
  TeamId,
} from '../types/game';

/* ─────────────── shared labels ─────────────── */

export const TEAM_NAMES: Record<TeamId, string> = {
  red: 'النسور الحمر',
  blue: 'موج بحري',
};

export const TEAM_TEXT: Record<TeamId, string> = {
  red: 'text-[#ff5d75]',
  blue: 'text-[#4cc9ff]',
};

export const TEAM_HEX: Record<TeamId, string> = {
  red: '#ff2e4c',
  blue: '#00c2ff',
};

export const STANCE_LABEL: Record<TacticalStance, { label: string; emoji: string }> = {
  balanced: { label: 'متوازن', emoji: '⚖️' },
  all_out_attack: { label: 'هجوم كاسح', emoji: '🔥' },
  park_the_bus: { label: 'أتوبيس دفاعي', emoji: '🚌' },
  high_press: { label: 'ضغط عالي', emoji: '⚡' },
};

export const CAMERA_LABEL: Record<CameraMode, string> = {
  broadcast_top: 'علوي',
  player_third: 'منظور لاعب',
  gk_first_person: 'منظور شخصي',
  referee_cam: 'كاميرا الحكم',
  coach_touchline: 'خط التماس',
  bench_cam: 'كاميرا الدكة',
  stands_cam: 'المدرج',
  var_replay_cam: 'إعادة الفار',
};

export const ROLE_LABEL: Record<RoleType, string> = {
  outfield: 'لاعب ميدان',
  goalkeeper: 'حارس مرمى',
  referee: 'حكم',
  coach: 'مدرب',
  spectator: 'مشجع',
};

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

/* ─────────────── lobby slot sanitising ─────────────── */

/** Cameras a given role can legally use under the Admin rules. */
export function allowedCamerasFor(
  role: RoleType,
  rules: AdminRules,
  benched = false,
): CameraMode[] {
  if (benched) return ['bench_cam'];
  switch (role) {
    case 'goalkeeper':
      return ['gk_first_person'];
    case 'outfield':
      if (rules.allowedCameras === 'top_only') return ['broadcast_top'];
      if (rules.allowedCameras === 'player_only') return ['player_third'];
      return ['broadcast_top', 'player_third'];
    case 'referee':
      return rules.allowedCameras === 'player_only'
        ? ['referee_cam']
        : ['referee_cam', 'broadcast_top'];
    case 'coach':
      return rules.allowedCameras === 'player_only'
        ? ['coach_touchline']
        : ['coach_touchline', 'broadcast_top'];
    case 'spectator':
      return ['stands_cam', 'broadcast_top'];
  }
}

export function isRoleAvailable(role: RoleType, rules: AdminRules): boolean {
  if (role === 'referee') return rules.enableHumanRef;
  if (role === 'coach') return rules.enableCoachBench;
  return true;
}

/** Returns a patch that makes the slot legal for the current rules (or null if already legal). */
export function sanitizeSlot(
  slot: HumanSlotConfig,
  rules: AdminRules,
): Partial<HumanSlotConfig> | null {
  const patch: Partial<HumanSlotConfig> = {};
  let role = slot.role;
  if (!isRoleAvailable(role, rules)) {
    role = 'outfield';
    patch.role = 'outfield';
    patch.positionRole = 'striker';
  }
  const cams = allowedCamerasFor(role, rules, false);
  if (!cams.includes(slot.cameraMode) || patch.role) {
    if (!cams.includes(slot.cameraMode)) patch.cameraMode = cams[0];
  }
  if (role === 'goalkeeper' && slot.cameraMode !== 'gk_first_person') {
    patch.cameraMode = 'gk_first_person';
  }
  const wantedControl = role !== 'outfield' || !rules.allowTeamSwitch ? 'locked_player' : null;
  if (wantedControl && slot.controlMode !== wantedControl) {
    patch.controlMode = wantedControl;
  }
  if (slot.isBenched) patch.isBenched = false;
  return Object.keys(patch).length > 0 ? patch : null;
}

/* ─────────────── small shared components ─────────────── */

export function useToggleMute() {
  const muted = useGameStore((s) => s.muted);
  const dispatch = useGameStore((s) => s.dispatchCommand);
  return { muted, toggle: () => dispatch({ type: 'toggleMute' }) };
}

export function MuteButton({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { muted, toggle } = useToggleMute();
  const dim = size === 'sm' ? 'h-9 w-9' : 'h-11 w-11';
  return (
    <button
      type="button"
      onClick={toggle}
      title={muted ? 'تشغيل الصوت' : 'كتم الصوت'}
      aria-label={muted ? 'تشغيل الصوت' : 'كتم الصوت'}
      className={`btn-ghost ${dim} shrink-0 ${muted ? 'text-rose-300' : 'text-emerald-300'}`}
    >
      {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
    </button>
  );
}

export function KeyPill({
  k,
  label,
  dim = false,
  active = false,
  hint,
}: {
  k: string;
  label: string;
  dim?: boolean;
  active?: boolean;
  hint?: string;
}) {
  return (
    <div
      title={hint}
      className={`flex items-center gap-1.5 rounded-xl border px-2 py-1 text-xs font-bold whitespace-nowrap transition ${
        dim
          ? 'border-slate-700/60 bg-slate-900/50 text-slate-500 opacity-45 line-through decoration-slate-500/60'
          : active
            ? 'border-amber-300/80 bg-amber-400/20 text-amber-100 shadow-[0_0_14px_rgba(251,191,36,0.5)]'
            : 'border-slate-600/50 bg-slate-900/70 text-slate-100'
      }`}
    >
      <span className="kbd">{k}</span>
      <span>{label}</span>
    </div>
  );
}

export function Bar({
  value,
  max = 100,
  from,
  to,
  glow,
  label,
  icon,
  right,
}: {
  value: number;
  max?: number;
  from: string;
  to: string;
  glow?: boolean;
  label: string;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-slate-300">
        <span className="flex items-center gap-1">
          {icon}
          {label}
        </span>
        <span className="tabular-nums text-slate-200">{right ?? `${Math.round(pct)}%`}</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-slate-950/80">
        <div
          className="h-full rounded-full transition-[width] duration-100"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${from}, ${to})`,
            boxShadow: glow ? `0 0 14px ${to}` : undefined,
          }}
        />
      </div>
    </div>
  );
}

export function ModalShell({
  children,
  onBackdrop,
  maxWidth = 'max-w-xl',
}: {
  children: ReactNode;
  onBackdrop?: () => void;
  maxWidth?: string;
}) {
  return (
    <div
      className="pe-auto absolute inset-0 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm anim-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdrop?.();
      }}
    >
      <div
        className={`glass-strong anim-pop-in w-full ${maxWidth} max-h-[92vh] overflow-y-auto rounded-3xl thin-scroll`}
      >
        {children}
      </div>
    </div>
  );
}
