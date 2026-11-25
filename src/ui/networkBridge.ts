import { useState } from 'react';
import type { INetworkManager } from '../types/engine';
import { useGameStore } from '../store/useGameStore';

/** Runtime INetworkManager is published on `window` by the bootstrap (no direct import → zero coupling). */
export const getNet = (): INetworkManager | undefined =>
  (window as unknown as { __ELMAL3AB_NET__?: INetworkManager }).__ELMAL3AB_NET__;

/** Normalises user input into the canonical `ML3B-XXXX` room code. */
export function normalizeRoomCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = cleaned.startsWith('ML3B') ? cleaned.slice(4) : cleaned;
  return body ? `ML3B-${body.slice(0, 4)}` : '';
}

/**
 * Shared voice-chat controls (OnlineRoomPanel + Scoreboard).
 * Voice is OFF and mic is MUTED by default; enabling voice never un-mutes by itself
 * except through `quickToggle` (the single Scoreboard mic button).
 */
export function useVoiceControls() {
  const voiceActive = useGameStore((s) => s.network.voiceActive);
  const micMuted = useGameStore((s) => s.network.micMuted);
  const setNetworkState = useGameStore((s) => s.setNetworkState);
  const [busy, setBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const toggleVoice = async (): Promise<boolean> => {
    const net = getNet();
    if (!net || busy) return voiceActive;
    setBusy(true);
    setVoiceError(null);
    try {
      const active = await net.toggleVoiceChat();
      net.setMicMuted(true);
      setNetworkState({ voiceActive: active, micMuted: true });
      return active;
    } catch {
      setVoiceError('مقدرناش نفتح الميكروفون.. اتأكد من إذن المتصفح 🎤');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleMute = () => {
    const net = getNet();
    if (!net) return;
    const next = !micMuted;
    net.setMicMuted(next);
    setNetworkState({ micMuted: next });
  };

  /** One-button behaviour: first press turns voice on AND opens the mic, then it toggles mute. */
  const quickToggle = async () => {
    if (!voiceActive) {
      const active = await toggleVoice();
      if (active) {
        const net = getNet();
        net?.setMicMuted(false);
        setNetworkState({ micMuted: false });
      }
      return;
    }
    toggleMute();
  };

  return { voiceActive, micMuted, busy, voiceError, toggleVoice, toggleMute, quickToggle };
}
