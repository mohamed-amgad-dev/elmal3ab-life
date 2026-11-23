import { useEffect, useState } from 'react';
import type { ComedyEventTone } from '../types/game';
import { useGameStore } from '../store/useGameStore';

const TONE_STYLE: Record<ComedyEventTone, { border: string; bg: string; label: string; text: string }> = {
  goal: { border: '#10b981', bg: 'rgba(16,185,129,0.18)', label: 'جول', text: '#6ee7b7' },
  card_yellow: { border: '#fbbf24', bg: 'rgba(251,191,36,0.18)', label: 'أصفر', text: '#fde68a' },
  card_red: { border: '#ff2e4c', bg: 'rgba(255,46,76,0.2)', label: 'أحمر', text: '#fda4af' },
  var: { border: '#00c2ff', bg: 'rgba(0,194,255,0.18)', label: 'فار', text: '#7dd3fc' },
  bench: { border: '#a78bfa', bg: 'rgba(167,139,250,0.18)', label: 'دكة', text: '#ddd6fe' },
  dive: { border: '#fb923c', bg: 'rgba(251,146,60,0.18)', label: 'غطس', text: '#fed7aa' },
  tactic: { border: '#38bdf8', bg: 'rgba(56,189,248,0.15)', label: 'تكتيك', text: '#bae6fd' },
  crowd: { border: '#f472b6', bg: 'rgba(244,114,182,0.16)', label: 'جمهور', text: '#fbcfe8' },
};

const VISIBLE_MS = 9000;

export default function ComedyToastFeed() {
  const events = useGameStore((s) => s.events);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const visible = events.filter((e) => now - e.timestamp < VISIBLE_MS).slice(0, 4);
  if (visible.length === 0) return null;

  return (
    <div className="absolute top-3 left-3 flex w-[280px] flex-col gap-2">
      {visible.map((e) => {
        const t = TONE_STYLE[e.tone];
        return (
          <div
            key={e.id}
            className="anim-toast glass flex items-start gap-2.5 rounded-xl px-3 py-2"
            style={{ borderColor: t.border, background: `linear-gradient(90deg, ${t.bg}, rgba(2,6,23,0.78))` }}
          >
            <span className="text-2xl leading-none">{e.icon}</span>
            <div className="min-w-0 flex-1">
              <span
                className="mb-0.5 inline-block rounded-full px-2 py-px text-[10px] leading-4 font-black"
                style={{ background: t.border, color: '#020617' }}
              >
                {t.label}
              </span>
              <p className="text-[13px] leading-snug font-bold break-words text-white">{e.text}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
