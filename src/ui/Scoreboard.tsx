import { HelpCircle, Mic, MicOff, Pause, Play } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { MatchPhase, TeamId } from '../types/game';
import { useVoiceControls } from './networkBridge';
import { DIFFICULTY_META, MuteButton, STANCE_LABEL, TEAM_HEX, TEAM_NAMES, formatClock } from './uiKit';

const PHASE_LABEL: Partial<Record<MatchPhase, string>> = {
  kickoff: 'ضربة البداية',
  paused_whistle: 'الحكم وقّف اللعب 🛑',
  free_kick_setup: 'ركلة حرة ⚽',
  penalty_setup: 'بلنتي! 🎯',
  penalty_shootout: 'ركلات الترجيح 🥅',
  var_review: 'مراجعة الفار 📺',
  red_card_drama: 'طرد أحمر! 🟥',
  substitution_stoppage: 'تبديل رسمي 🔄',
  goal_celebration: 'جووول! 🎉',
  goal_replay: 'إعادة الهدف 🎥',
};

function TeamBlock({ team }: { team: TeamId }) {
  const score = useGameStore((s) => s.score[team]);
  const stance = useGameStore((s) => s.tactics[team]);
  const hex = TEAM_HEX[team];
  const st = STANCE_LABEL[stance];
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col items-start gap-1">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: hex, boxShadow: `0 0 10px ${hex}` }} />
          <span className="truncate text-sm font-black text-white">{TEAM_NAMES[team]}</span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] leading-tight font-bold whitespace-nowrap ${
            stance === 'balanced'
              ? 'border-slate-600/60 bg-slate-800/60 text-slate-300'
              : 'border-amber-300/60 bg-amber-400/15 text-amber-200'
          }`}
        >
          {st.emoji} {st.label}
        </span>
      </div>
      <span
        key={score}
        className="anim-pop-in min-w-[2.2ch] text-center font-display text-5xl leading-none font-black tabular-nums"
        style={{ color: '#fff', textShadow: `0 0 20px ${hex}` }}
      >
        {score}
      </span>
    </div>
  );
}

export default function Scoreboard() {
  const clockSec = useGameStore((s) => s.clockSec);
  const phase = useGameStore((s) => s.phase);
  const isPaused = useGameStore((s) => s.isPaused);
  const aiDifficulty = useGameStore((s) => s.rules.aiDifficulty);
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const dispatchCommand = useGameStore((s) => s.dispatchCommand);
  const network = useGameStore((s) => s.network);
  const isQuickChatOpen = useGameStore((s) => s.isQuickChatOpen);
  const setQuickChatOpen = useGameStore((s) => s.setQuickChatOpen);
  const voice = useVoiceControls();
  const online = network.mode !== 'offline';
  const pingColor =
    network.pingMs <= 0
      ? 'text-slate-300'
      : network.pingMs < 80
        ? 'text-emerald-300'
        : network.pingMs < 160
          ? 'text-amber-300'
          : 'text-rose-300';

  const low = clockSec <= 15 && clockSec > 0;
  const phaseLabel = PHASE_LABEL[phase];
  const diffMeta = DIFFICULTY_META[aiDifficulty];

  return (
    <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-stretch gap-2">
      <div className="glass flex w-[540px] items-center gap-4 rounded-2xl px-5 py-2" style={{ borderColor: 'rgba(251,191,36,0.25)' }}>
        <TeamBlock team="red" />

        <div className="flex w-[108px] shrink-0 flex-col items-center">
          <div
            className={`rounded-lg border px-3 py-0.5 font-display text-2xl leading-tight font-black tabular-nums ${
              low
                ? 'anim-blink border-rose-400/70 bg-rose-500/20 text-rose-200'
                : 'border-amber-300/40 bg-slate-950/70 text-amber-200'
            }`}
            dir="ltr"
          >
            {formatClock(clockSec)}
          </div>
          <div className="mt-0.5 h-3.5 text-[10px] leading-3.5 font-bold whitespace-nowrap text-cyan-300">
            {phaseLabel ?? (isPaused ? 'إيقاف مؤقت ⏸' : 'مباشر 🔴')}
          </div>
          <span
            className={`mt-0.5 rounded-full border px-1.5 py-[1px] text-[9px] leading-tight font-black whitespace-nowrap ${diffMeta.badgeClass}`}
          >
            {diffMeta.label} {diffMeta.emoji}
          </span>
        </div>

        <TeamBlock team="blue" />
      </div>

      <div className="glass flex flex-col items-center justify-center gap-1 rounded-2xl p-1.5">
        <div className="flex items-center gap-1">
          <MuteButton size="sm" />
          <button
            type="button"
            onClick={() => setControlsOpen(true)}
            title="دليل التحكم"
            aria-label="دليل التحكم"
            className="btn-ghost h-9 w-9 text-cyan-300"
          >
            <HelpCircle size={18} />
          </button>
          <button
            type="button"
            onClick={() => dispatchCommand({ type: 'togglePause' })}
            title="إيقاف مؤقت"
            aria-label="إيقاف مؤقت"
            className="btn-ghost h-9 w-9 text-amber-300"
          >
            {isPaused ? <Play size={18} /> : <Pause size={18} />}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setQuickChatOpen(!isQuickChatOpen)}
            title="شات سريع (B)"
            aria-label="شات سريع"
            aria-pressed={isQuickChatOpen}
            className={`btn-ghost h-9 gap-1 px-2 text-xs font-black whitespace-nowrap ${
              isQuickChatOpen ? 'border-cyan-300/70 bg-cyan-500/20 text-cyan-100' : 'text-cyan-200'
            }`}
          >
            💬 B
          </button>
          {online && (
            <>
              <span
                title="زمن الاستجابة"
                className={`flex h-9 items-center rounded-xl border border-white/10 bg-slate-950/60 px-2 text-[11px] font-black whitespace-nowrap tabular-nums ${pingColor}`}
                dir="ltr"
              >
                {network.pingMs}ms
              </span>
              <button
                type="button"
                disabled={voice.busy || !network.peerConnected}
                onClick={() => void voice.quickToggle()}
                title={voice.voiceActive && !voice.micMuted ? 'اكتم الميك' : 'افتح الميك'}
                aria-label={voice.voiceActive && !voice.micMuted ? 'اكتم الميك' : 'افتح الميك'}
                className={`btn-ghost h-9 w-9 ${
                  voice.voiceActive && !voice.micMuted ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {voice.voiceActive && !voice.micMuted ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
