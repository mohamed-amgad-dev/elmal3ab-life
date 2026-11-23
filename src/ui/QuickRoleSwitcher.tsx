import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Repeat } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { GameCommand, RoleType } from '../types/game';

interface QuickRole {
  key: string;
  label: string;
  emoji: string;
  role: RoleType;
  benchSelf?: boolean;
}

const QUICK_ROLES: QuickRole[] = [
  { key: 'outfield', label: 'لاعب ميدان', emoji: '⚽', role: 'outfield' },
  { key: 'gk', label: 'حارس (منظور شخصي)', emoji: '🧤', role: 'goalkeeper' },
  { key: 'ref', label: 'الحكم', emoji: '🟨', role: 'referee' },
  { key: 'coach', label: 'المدرب', emoji: '🧥', role: 'coach' },
  { key: 'bench', label: 'مشاهدة من الدكة', emoji: '🪑', role: 'outfield', benchSelf: true },
  { key: 'spec', label: 'المدرجات', emoji: '🏟️', role: 'spectator' },
];

export default function QuickRoleSwitcher() {
  const [open, setOpen] = useState(false);
  const slot = useGameStore((s) => s.humanSlot);
  const dispatch = useGameStore((s) => s.dispatchCommand);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isCurrent = (r: QuickRole) =>
    slot.role === r.role && (r.role !== 'outfield' || !!r.benchSelf === slot.isBenched);

  const pick = (r: QuickRole) => {
    const cmd: GameCommand = { type: 'sandboxSwitchRole', role: r.role, team: slot.team };
    if (r.benchSelf) cmd.benchSelf = true;
    dispatch(cmd);
    setOpen(false);
  };

  return (
    <div className="absolute right-3 bottom-3 flex w-[224px] flex-col items-stretch gap-2">
      {open && (
        <div className="glass anim-pop-in flex flex-col gap-1 rounded-2xl p-2" style={{ transformOrigin: 'bottom right' }}>
          {QUICK_ROLES.map((r) => (
            <button
              key={r.key}
              type="button"
              data-active={isCurrent(r)}
              onClick={() => pick(r)}
              className="pill w-full justify-start rounded-xl px-3 py-2 text-[13px]"
            >
              <span className="text-lg leading-none">{r.emoji}</span>
              {r.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="btn-ghost glass h-11 justify-between gap-2 rounded-full px-4 text-[13px]"
      >
        <span className="flex items-center gap-1.5">
          <Repeat size={16} className="text-cyan-300" />
          تبديل الدور السريع (M)
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </div>
  );
}
