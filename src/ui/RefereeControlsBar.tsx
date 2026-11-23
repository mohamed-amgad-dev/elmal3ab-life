import type { ReactNode } from 'react';
import { Crosshair, Megaphone, Tv } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { GameCommand } from '../types/game';
import { TEAM_HEX, TEAM_NAMES } from './uiKit';

function RefBtn({
  k,
  label,
  cmd,
  tone,
  disabled,
  icon,
}: {
  k: string;
  label: string;
  cmd: GameCommand;
  tone: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const dispatch = useGameStore((s) => s.dispatchCommand);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => dispatch(cmd)}
      className="btn-ghost h-11 gap-2 px-3 text-sm whitespace-nowrap disabled:opacity-40"
      style={{ borderColor: `${tone}88`, boxShadow: disabled ? undefined : `0 0 14px ${tone}33` }}
    >
      <span className="kbd">{k}</span>
      {icon}
      {label}
    </button>
  );
}

export default function RefereeControlsBar() {
  const targetId = useGameStore((s) => s.nearestRefTargetId);
  const players = useGameStore((s) => s.players);
  const rules = useGameStore((s) => s.rules);
  const target = targetId ? players.find((p) => p.id === targetId) : undefined;

  return (
    <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
      <div
        className={`glass flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-black ${target ? 'glow-gold' : ''}`}
      >
        <Crosshair size={16} className={target ? 'text-amber-300' : 'text-slate-500'} />
        {target ? (
          <>
            <span className="text-slate-300">أقرب لاعب ليك:</span>
            <span
              className="rounded-md px-2 py-0.5 text-slate-950"
              style={{ background: target.team === 'red' || target.team === 'blue' ? TEAM_HEX[target.team] : '#fbbf24' }}
            >
              #{target.number} {target.name}
            </span>
            {(target.team === 'red' || target.team === 'blue') && (
              <span className="text-xs text-slate-400">({TEAM_NAMES[target.team]})</span>
            )}
          </>
        ) : (
          <span className="text-slate-400">قرّب من لاعب علشان تدّيله كارت 👀</span>
        )}
      </div>

      <div className="glass flex items-center gap-2 rounded-2xl p-2">
        <RefBtn k="Space" label="صافرة" cmd={{ type: 'refWhistle' }} tone="#e2e8f0" icon={<Megaphone size={16} />} />
        <RefBtn k="1" label="كارت أصفر 🟨" cmd={{ type: 'refYellowCard' }} tone="#fbbf24" disabled={!target} />
        <RefBtn k="2" label="طرد أحمر 🟥" cmd={{ type: 'refRedCard' }} tone="#ff2e4c" disabled={!target} />
        <RefBtn k="3" label="بلنتي بمزاجك! 🎯" cmd={{ type: 'refPenalty' }} tone="#10b981" />
        <RefBtn
          k="4"
          label="مراجعة VAR 📺"
          cmd={{ type: 'refStartVAR', reason: 'الحكم طلب مراجعة الفار' }}
          tone="#00c2ff"
          disabled={!rules.enableVAR}
          icon={<Tv size={16} />}
        />
      </div>
    </div>
  );
}
