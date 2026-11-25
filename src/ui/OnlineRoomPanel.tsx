import { useEffect, useRef, useState } from 'react';
import { Copy, Globe, Link2, LogOut, Mic, MicOff } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import {
  dismissInviteAutoJoin,
  getNet,
  hasInviteAutoJoined,
  isInviteAutoJoinDismissed,
  markInviteAutoJoined,
  normalizeRoomCode,
  readInviteRoomCode,
  useVoiceControls,
} from './networkBridge';

export default function OnlineRoomPanel() {
  const network = useGameStore((s) => s.network);
  const voice = useVoiceControls();
  const [joinCode, setJoinCode] = useState(() => readInviteRoomCode());
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  const isOnline = network.mode !== 'offline';
  const pending =
    network.status === 'creating' || network.status === 'connecting';
  const codeReady = /^ML3B-[A-Z0-9]{4}$/.test(joinCode);

  // Invite link (?room=ML3B-XXXX): StrictMode-safe deferred auto-join once the surviving
  // PeerNetworkManager is mounted and live.
  useEffect(() => {
    const code = readInviteRoomCode();
    if (!code || isInviteAutoJoinDismissed() || hasInviteAutoJoined(code)) return;

    let cancelled = false;
    let pollTimer: number | undefined;

    const startDelay = window.setTimeout(() => {
      if (cancelled) return;

      const tryAutoJoin = (): boolean => {
        if (cancelled || isInviteAutoJoinDismissed() || hasInviteAutoJoined(code)) return true;
        const net = getNet();
        if (!net) return false;
        const state = useGameStore.getState().network;
        markInviteAutoJoined(code);
        if (state.mode === 'offline' && state.status === 'idle') {
          void net.joinRoom(code).catch(() => undefined);
        }
        return true;
      };

      if (tryAutoJoin()) return;
      let attempts = 0;
      pollTimer = window.setInterval(() => {
        attempts += 1;
        if (tryAutoJoin() || attempts >= 30) {
          window.clearInterval(pollTimer);
        }
      }, 100);
    }, 65);

    return () => {
      cancelled = true;
      window.clearTimeout(startDelay);
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }
    };
  }, []);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const flashCopied = (kind: 'code' | 'link') => {
    setCopied(kind);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1800);
  };

  const copy = async (text: string, kind: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(kind);
    } catch {
      // Clipboard API can be blocked (insecure origin) → legacy fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        flashCopied(kind);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const inviteLink = `${window.location.origin}${window.location.pathname}?room=${network.roomCode}`;

  const statusText = (() => {
    if (network.status === 'creating') return 'بنجهّز الروم...';
    if (network.status === 'connecting') return 'بنوصّل بصاحبك...';
    if (network.peerConnected) return `متصل مع صاحبك ✅ • ${network.pingMs}ms`;
    if (network.mode === 'host') return 'مستني صاحبك يدخل...';
    return 'بنوصّل بالروم...';
  })();

  return (
    <section
      className="glass shrink-0 rounded-3xl border border-violet-400/30 p-3"
      style={{ boxShadow: '0 0 22px rgba(139,92,246,0.18)' }}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe size={18} className="text-violet-300" />
          <h2 className="text-base font-black text-white">أونلاين مع صاحبك</h2>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-black whitespace-nowrap ${
            isOnline
              ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200'
              : 'border-slate-600/60 bg-slate-800/60 text-slate-300'
          }`}
        >
          {isOnline ? (network.mode === 'host' ? 'هوست 👑' : 'ضيف 🎮') : 'أوفلاين'}
        </span>
      </header>

      {network.errorMessage && (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-3 py-2 text-xs leading-snug font-bold text-rose-100"
        >
          ⚠️ {network.errorMessage}
        </div>
      )}

      {!isOnline ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void getNet()?.createRoom()}
            className="btn-cta h-11 gap-2 text-base"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}
          >
            {network.status === 'creating' ? 'بنجهّز الروم... ⏳' : 'إنشاء روم أونلاين 🌐'}
          </button>

          <div className="flex items-center gap-2">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] font-bold text-slate-400">أو</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          <label className="text-[11px] font-black text-slate-300">انضمام بكود الروم</label>
          <div className="flex items-center gap-2">
            <input
              dir="ltr"
              value={joinCode}
              maxLength={9}
              spellCheck={false}
              autoComplete="off"
              placeholder="ML3B-XXXX"
              onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && codeReady && !pending) void getNet()?.joinRoom(joinCode);
              }}
              className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-slate-950/70 px-3 text-center font-mono text-sm font-black tracking-widest text-white outline-none placeholder:text-slate-500 focus:border-violet-400/70"
            />
            <button
              type="button"
              disabled={!codeReady || pending}
              onClick={() => void getNet()?.joinRoom(joinCode)}
              className="btn-ghost h-10 shrink-0 border-violet-400/50 px-4 text-sm font-black text-violet-100"
            >
              {network.status === 'connecting' ? 'بيتصل...' : 'انضم 🚪'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* glowing room code badge */}
          <div
            className="flex flex-col items-center rounded-2xl border border-violet-300/70 bg-slate-950/70 px-3 py-2"
            style={{ boxShadow: '0 0 24px rgba(167,139,250,0.55), inset 0 0 18px rgba(139,92,246,0.25)' }}
          >
            <span className="text-[10px] font-bold text-violet-200/80">كود الروم</span>
            <span
              dir="ltr"
              className="font-mono text-3xl leading-tight font-black tracking-[0.18em] text-white"
              style={{ textShadow: '0 0 16px rgba(167,139,250,0.95)' }}
            >
              {network.roomCode || '—'}
            </span>
          </div>

          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
            <button
              type="button"
              disabled={!network.roomCode}
              onClick={() => void copy(network.roomCode, 'code')}
              className="btn-ghost h-9 gap-1.5 px-3 text-xs font-black whitespace-nowrap"
            >
              <Copy size={13} className="text-cyan-300" />
              {copied === 'code' ? 'تم النسخ! ✅' : 'نسخ الكود 📋'}
            </button>
            <button
              type="button"
              disabled={!network.roomCode}
              onClick={() => void copy(inviteLink, 'link')}
              className="btn-ghost h-9 gap-1.5 px-3 text-xs font-black whitespace-nowrap"
            >
              <Link2 size={13} className="text-cyan-300" />
              {copied === 'link' ? 'تم النسخ! ✅' : 'نسخ رابط الدعوة المباشر 🔗'}
            </button>
          </div>

          {/* live status */}
          <div
            className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-black ${
              network.peerConnected
                ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-300/40 bg-amber-400/10 text-amber-200'
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                network.peerConnected ? 'bg-emerald-400' : 'bg-amber-300 anim-blink'
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{statusText}</span>
          </div>

          {/* voice chat (muted by default) */}
          <div className="flex items-center gap-2">
            {!voice.voiceActive ? (
              <button
                type="button"
                disabled={voice.busy || !network.peerConnected}
                onClick={() => void voice.toggleVoice()}
                className="btn-ghost h-9 min-w-0 flex-1 gap-1.5 px-2 text-xs font-black"
                title="الميك بيبدأ مكتوم لحد ما تفتحه"
              >
                <MicOff size={14} className="text-slate-400" />
                {voice.busy ? 'بنفتح الميك...' : 'تشغيل الشات الصوتي 🎤'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={voice.toggleMute}
                  className={`btn-ghost h-9 min-w-0 flex-1 gap-1.5 px-2 text-xs font-black ${
                    voice.micMuted ? 'text-rose-200' : 'text-emerald-200'
                  }`}
                >
                  {voice.micMuted ? <MicOff size={14} /> : <Mic size={14} />}
                  {voice.micMuted ? 'الميك مكتوم 🔇 — اضغط تتكلم' : 'الميك شغال 🎙️'}
                </button>
                <button
                  type="button"
                  onClick={() => void voice.toggleVoice()}
                  className="btn-ghost h-9 shrink-0 px-2.5 text-[11px] font-black text-slate-300"
                >
                  إيقاف
                </button>
              </>
            )}
          </div>
          {voice.voiceError && (
            <div className="text-[11px] font-bold text-rose-300">{voice.voiceError}</div>
          )}
          {!voice.voiceActive && !voice.voiceError && (
            <div className="text-[10px] font-semibold text-slate-400">
              الميك مكتوم تلقائي — محدش هيسمعك إلا لما تفتحه.
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              dismissInviteAutoJoin();
              getNet()?.disconnect();
            }}
            className="btn-ghost h-9 gap-1.5 border-rose-400/40 text-xs font-black text-rose-200 hover:bg-rose-500/15"
          >
            <LogOut size={14} />
            فصل الأونلاين
          </button>
        </div>
      )}
    </section>
  );
}
