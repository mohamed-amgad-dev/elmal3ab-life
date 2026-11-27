import { Peer, type DataConnection, type MediaConnection } from 'peerjs';
import { useGameStore } from '../store/useGameStore';
import {
  DEFAULT_NETWORK_STATE,
  type GuestInputPacket,
  type LobbySyncPacket,
  type PeerWireMessage,
  type WorldSnapshotPacket,
} from '../types/network';
import type { INetworkManager, QuickChatNetworkEvent } from '../types/network';
import type { HumanSlotConfig } from '../types/game';
import { HttpMatchRelay, type RelayWirePacket } from './HttpMatchRelay';

/* ───────────────────────── Constants ───────────────────────── */

const ROOM_PREFIX = 'ML3B-';
const PEER_ID_PREFIX = 'elmal3ab-v3-ml3b-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;
const PING_INTERVAL_MS = 1500;
const RELAY_PEER_TIMEOUT_MS = 20_000;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const MSG_ROOM_NOT_FOUND = 'ملقيناش الروم دي — اتأكد إن صاحبك فاتح اللوبي والكود صح!';
const MSG_BAD_CODE = 'الكود مش مظبوط — لازم يبقى شكله ML3B-XXXX';
const MSG_GENERIC = 'حصلت مشكلة في الاتصال — جرّب تاني!';
const MSG_CREATE_FAILED = 'معرفناش نفتح الروم — اتأكد من النت وجرّب تاني!';
const MSG_HOST_LEFT = 'صاحبك قفل الروم أو النت فصل عنده.';
const MSG_MIC_DENIED = 'المايك مش متاح — اسمح للمتصفح باستخدام الميكروفون وجرّب تاني!';
const MSG_ROOM_FULL = 'الروم دي فيها لاعب تاني بالفعل!';

type Listener<T> = (value: T) => void;

type PeerErrorLike = Error & { type?: string };

function randomRoomSuffix(): string {
  const out: string[] = [];
  const cryptoObj: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(ROOM_CODE_LENGTH);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      out.push(ROOM_CODE_ALPHABET[buf[i] % ROOM_CODE_ALPHABET.length]);
    }
  } else {
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      out.push(ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]);
    }
  }
  return out.join('');
}

function generatePlayerId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Accepts `XXXX`, `ML3B-XXXX`, `ml3bxxxx` or a full URL containing `?room=ML3B-XXXX`. */
export function parseRoomSuffix(raw: string): string | null {
  let text = (raw ?? '').trim();
  if (!text) return null;
  if (/[?&]room=/i.test(text) || /^https?:\/\//i.test(text)) {
    let fromQuery: string | null = null;
    try {
      fromQuery = new URL(text).searchParams.get('room');
    } catch {
      const m = /[?&]room=([^&#\s]+)/i.exec(text);
      fromQuery = m ? decodeURIComponent(m[1]) : null;
    }
    if (fromQuery) text = fromQuery;
  }
  text = text.trim().toUpperCase();
  const m = /^(?:ML3B-?)?([A-Z0-9]{4})$/.exec(text);
  return m ? m[1] : null;
}

/* ───────────────────────── Manager ───────────────────────── */

export class PeerNetworkManager implements INetworkManager {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private relay: HttpMatchRelay | null = null;
  private relayPeerConnected = false;
  private lastRelayPeerSeenAt = 0;
  private session = 0;
  private manualClose = false;
  private readonly localPlayerId = generatePlayerId('ml');

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;

  private remotePeerId: string | null = null;
  private localStream: MediaStream | null = null;
  private outgoingCall: MediaConnection | null = null;
  private incomingCall: MediaConnection | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private beforeUnloadHandler: (() => void) | null = null;

  private readonly guestInputSubs = new Set<Listener<GuestInputPacket>>();
  private readonly snapshotSubs = new Set<Listener<WorldSnapshotPacket>>();
  private readonly lobbySyncSubs = new Set<Listener<LobbySyncPacket>>();
  private readonly guestSlotSubs = new Set<Listener<HumanSlotConfig>>();
  private readonly quickChatSubs = new Set<Listener<QuickChatNetworkEvent>>();

  constructor() {
    if (typeof window !== 'undefined') {
      (window as unknown as { __ELMAL3AB_NET__?: INetworkManager }).__ELMAL3AB_NET__ = this;
      this.beforeUnloadHandler = () => {
        this.relay?.leave();
      };
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  /* ───────────── Room creation (Host) ───────────── */

  async createRoom(): Promise<string> {
    this.teardown(true);
    const session = ++this.session;
    this.manualClose = false;

    const store = useGameStore.getState();
    store.setNetworkState({
      mode: 'host',
      status: 'creating',
      roomCode: '',
      peerConnected: false,
      pingMs: 0,
      errorMessage: null,
    });

    const suffix = randomRoomSuffix();
    const displayCode = `${ROOM_PREFIX}${suffix}`;
    const relayRoomCode = `M${suffix}`;
    const peerId = `${PEER_ID_PREFIX}${suffix.toLowerCase()}`;

    // 1. Primary guaranteed transport: Vercel HTTPS port-443 relay
    const relay = new HttpMatchRelay(relayRoomCode, this.localPlayerId, true, {
      onEnvelope: (env) => {
        if (session !== this.session || this.relay !== relay) return;
        this.lastRelayPeerSeenAt = Date.now();
        if (!this.relayPeerConnected) {
          this.markRelayPeerConnected(true);
        }
        this.handleMessage(env.packet, true);
      },
      onSyncMeta: ({ peerAlive, rttMs }) => {
        if (session !== this.session || this.relay !== relay) return;
        const now = Date.now();
        if (peerAlive) {
          this.lastRelayPeerSeenAt = now;
          if (!this.relayPeerConnected) {
            this.markRelayPeerConnected(true);
          }
        } else if (
          this.relayPeerConnected &&
          !this.conn?.open &&
          this.lastRelayPeerSeenAt > 0 &&
          now - this.lastRelayPeerSeenAt > RELAY_PEER_TIMEOUT_MS
        ) {
          this.handleRelayGuestLeft();
        }

        if (this.relayPeerConnected && !this.conn?.open) {
          useGameStore.getState().setNetworkState({ pingMs: rttMs });
        }
      },
      onDisconnected: () => {
        if (session !== this.session || this.relay !== relay) return;
        if (!this.conn?.open) {
          this.failHost(session, MSG_CREATE_FAILED);
        }
      },
    });
    this.relay = relay;

    const created = await relay.create();
    if (session !== this.session) return '';

    if (!created.ok) {
      this.failHost(session, MSG_CREATE_FAILED);
      return '';
    }

    useGameStore.getState().setNetworkState({
      mode: 'host',
      status: 'waiting_peer',
      roomCode: displayCode,
      peerConnected: false,
      errorMessage: null,
    });

    // 2. Opportunistic background PeerJS P2P upgrade (for lower latency when NAT allows + voice)
    this.startHostPeerBackground(peerId, session);

    return displayCode;
  }

  private startHostPeerBackground(peerId: string, session: number): void {
    try {
      const peer = new Peer(peerId, { config: { iceServers: ICE_SERVERS } });
      this.peer = peer;

      peer.on('connection', (incoming) => {
        if (session !== this.session) {
          incoming.close();
          return;
        }
        if (this.conn && this.conn.open) {
          incoming.on('open', () => {
            try {
              incoming.send({ type: 'room_full', message: MSG_ROOM_FULL });
            } catch {
              /* ignore */
            }
            setTimeout(() => incoming.close(), 100);
          });
          return;
        }
        this.attachConnection(incoming, session, true);
      });

      peer.on('call', (call) => this.handleIncomingCall(call, session));

      peer.on('disconnected', () => {
        if (session !== this.session || this.manualClose || peer.destroyed) return;
        try {
          peer.reconnect();
        } catch {
          /* ignore */
        }
      });

      peer.on('error', (_err: PeerErrorLike) => {
        // Non-fatal: Vercel HTTPS relay keeps the room 100% online.
      });
    } catch {
      // Non-fatal: Vercel HTTPS relay keeps the room 100% online.
    }
  }

  private failHost(session: number, message: string): void {
    if (session !== this.session) return;
    this.teardown(false);
    useGameStore.getState().setNetworkState({
      mode: 'host',
      status: 'error',
      roomCode: '',
      peerConnected: false,
      errorMessage: message,
    });
  }

  /* ───────────── Join (Guest) ───────────── */

  async joinRoom(rawCode: string): Promise<void> {
    this.teardown(true);
    const session = ++this.session;
    this.manualClose = false;
    const suffix = parseRoomSuffix(rawCode);
    const store = useGameStore.getState();

    if (!suffix) {
      store.setNetworkState({
        mode: 'guest',
        status: 'error',
        roomCode: '',
        peerConnected: false,
        errorMessage: MSG_BAD_CODE,
      });
      return;
    }

    const displayCode = `${ROOM_PREFIX}${suffix}`;
    const relayRoomCode = `M${suffix}`;
    const hostPeerId = `${PEER_ID_PREFIX}${suffix.toLowerCase()}`;

    store.setNetworkState({
      mode: 'guest',
      status: 'connecting',
      roomCode: displayCode,
      peerConnected: false,
      pingMs: 0,
      errorMessage: null,
    });

    // 1. Primary guaranteed join over Vercel HTTPS port-443 relay
    const relay = new HttpMatchRelay(relayRoomCode, this.localPlayerId, false, {
      onEnvelope: (env) => {
        if (session !== this.session || this.relay !== relay) return;
        this.lastRelayPeerSeenAt = Date.now();
        this.handleMessage(env.packet, false);
      },
      onSyncMeta: ({ rttMs }) => {
        if (session !== this.session || this.relay !== relay) return;
        if (!this.conn?.open) {
          useGameStore.getState().setNetworkState({ pingMs: rttMs });
        }
      },
      onDisconnected: (reason) => {
        if (session !== this.session || this.relay !== relay) return;
        if (this.conn?.open) return;
        this.teardown(false);
        useGameStore.getState().setNetworkState({
          mode: 'guest',
          status: 'error',
          roomCode: displayCode,
          peerConnected: false,
          pingMs: 0,
          errorMessage: reason === 'host_left' ? MSG_HOST_LEFT : MSG_GENERIC,
        });
      },
    });
    this.relay = relay;

    const joined = await relay.join({ type: 'guest_hello' });
    if (session !== this.session) return;

    if (!joined.ok) {
      this.teardown(false);
      const errMsg =
        joined.reason === 'room_not_found'
          ? MSG_ROOM_NOT_FOUND
          : joined.reason === 'room_full'
            ? MSG_ROOM_FULL
            : MSG_GENERIC;
      useGameStore.getState().setNetworkState({
        mode: 'guest',
        status: 'error',
        roomCode: displayCode,
        peerConnected: false,
        pingMs: 0,
        errorMessage: errMsg,
      });
      return;
    }

    this.markRelayPeerConnected(false);

    // 2. Opportunistic background PeerJS P2P upgrade (for direct low-latency + voice)
    this.startGuestPeerBackground(hostPeerId, session);
  }

  private startGuestPeerBackground(hostPeerId: string, session: number): void {
    try {
      const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
      this.peer = peer;
      this.remotePeerId = hostPeerId;

      peer.on('open', () => {
        if (session !== this.session) return;
        try {
          const conn = peer.connect(hostPeerId, {
            reliable: true,
            serialization: 'json',
            label: 'elmal3ab-v3',
          });
          this.attachConnection(conn, session, false);
        } catch {
          // Non-fatal: Vercel HTTPS relay handles all match traffic
        }
      });

      peer.on('call', (call) => this.handleIncomingCall(call, session));

      peer.on('error', (_err: PeerErrorLike) => {
        // Non-fatal: Vercel HTTPS relay handles all match traffic
      });
    } catch {
      // Non-fatal: Vercel HTTPS relay handles all match traffic
    }
  }

  private markRelayPeerConnected(isHost: boolean): void {
    this.relayPeerConnected = true;
    this.lastRelayPeerSeenAt = Date.now();
    useGameStore.getState().setNetworkState({
      status: 'connected',
      peerConnected: true,
      errorMessage: null,
    });
    if (isHost) {
      this.sendLobbySync(this.buildLobbyPacket());
    } else {
      this.send({ type: 'guest_slot', slot: { ...useGameStore.getState().humanSlot } });
    }
  }

  private handleRelayGuestLeft(): void {
    this.relayPeerConnected = false;
    this.lastRelayPeerSeenAt = 0;
    if (this.manualClose) return;
    useGameStore.getState().setNetworkState({
      status: 'waiting_peer',
      peerConnected: false,
      pingMs: 0,
      errorMessage: null,
    });
  }

  /* ───────────── DataConnection wiring ───────────── */

  private attachConnection(
    conn: DataConnection,
    session: number,
    isHost: boolean,
  ): void {
    this.conn = conn;
    this.remotePeerId = conn.peer;

    conn.on('open', () => {
      if (session !== this.session || this.conn !== conn) return;
      const store = useGameStore.getState();
      store.setNetworkState({
        status: 'connected',
        peerConnected: true,
        errorMessage: null,
      });
      this.startPing();
      if (isHost) {
        this.sendLobbySync(this.buildLobbyPacket());
      } else {
        this.send({ type: 'guest_slot', slot: { ...useGameStore.getState().humanSlot } });
      }
    });

    conn.on('data', (raw) => {
      if (session !== this.session || this.conn !== conn) return;
      this.handleMessage(raw, isHost);
    });

    const onGone = () => {
      if (session !== this.session || this.conn !== conn) return;
      this.handleConnectionLost(isHost);
    };
    conn.on('close', onGone);
    conn.on('error', onGone);
  }

  private handleConnectionLost(isHost: boolean): void {
    this.stopPing();
    this.conn = null;
    this.stopVoice(false);
    if (this.manualClose) return;

    // If Vercel HTTPS relay is still connected, keep the match running seamlessly!
    if (this.relay?.isActive() && this.relayPeerConnected) {
      return;
    }

    const store = useGameStore.getState();
    if (isHost) {
      store.setNetworkState({
        status: 'waiting_peer',
        peerConnected: false,
        pingMs: 0,
        errorMessage: null,
      });
    } else {
      const peer = this.peer;
      this.peer = null;
      try {
        peer?.destroy();
      } catch {
        /* ignore */
      }
      store.setNetworkState({
        status: 'error',
        peerConnected: false,
        pingMs: 0,
        errorMessage: MSG_HOST_LEFT,
      });
    }
  }

  private handleMessage(raw: unknown, isHost: boolean): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as RelayWirePacket;
    const store = useGameStore.getState();

    switch (msg.type) {
      case 'guest_hello':
        if (isHost) {
          this.markRelayPeerConnected(true);
        }
        break;
      case 'peer_left':
        if (isHost) {
          this.handleRelayGuestLeft();
        } else if (!this.conn?.open) {
          this.teardown(false);
          store.setNetworkState({
            mode: 'guest',
            status: 'error',
            peerConnected: false,
            pingMs: 0,
            errorMessage: MSG_HOST_LEFT,
          });
        }
        break;
      case 'ping':
        this.send({ type: 'pong', seq: msg.seq, sentAt: msg.sentAt });
        break;
      case 'pong': {
        const rtt = Math.max(0, Math.round(performance.now() - msg.sentAt));
        useGameStore.getState().setNetworkState({ pingMs: rtt });
        break;
      }
      case 'guest_input':
        if (isHost) this.guestInputSubs.forEach((cb) => cb(msg.packet));
        break;
      case 'world_snapshot':
        if (!isHost) this.snapshotSubs.forEach((cb) => cb(msg.snapshot));
        break;
      case 'guest_slot': {
        if (!isHost) break;
        store.setGuestSlot(msg.slot);
        const resolved = useGameStore.getState().network.guestSlot;
        this.guestSlotSubs.forEach((cb) => cb(resolved));
        this.sendLobbySync(this.buildLobbyPacket());
        break;
      }
      case 'lobby_sync': {
        if (isHost) break;
        const packet = msg.packet;
        store.setRules({ ...packet.rules, preset: packet.rules.preset });
        store.setHostSlot(packet.hostSlot);
        store.setGuestSlot(packet.guestSlot);
        const after = useGameStore.getState();
        if (after.phase === 'menu' && packet.phase === 'lobby') {
          after.setPhase('lobby');
        }
        this.lobbySyncSubs.forEach((cb) => cb(packet));
        break;
      }
      case 'quick_chat':
        this.quickChatSubs.forEach((cb) =>
          cb({ phraseId: msg.phraseId, sender: msg.sender, playerId: msg.playerId }),
        );
        break;
      case 'room_full':
        if (!isHost) {
          this.teardown(false);
          useGameStore.getState().setNetworkState({
            mode: 'guest',
            status: 'error',
            peerConnected: false,
            errorMessage: msg.message ?? MSG_ROOM_FULL,
          });
        }
        break;
      default:
        break;
    }
  }

  private buildLobbyPacket(): LobbySyncPacket {
    const s = useGameStore.getState();
    return {
      rules: { ...s.rules },
      hostSlot: { ...s.hostSlot },
      guestSlot: { ...s.network.guestSlot },
      phase: s.phase,
    };
  }

  private send(msg: PeerWireMessage): void {
    const c = this.conn;
    if (c && c.open) {
      try {
        c.send(msg);
        return;
      } catch {
        /* fall through to HTTPS relay */
      }
    }
    if (this.relay?.isActive()) {
      this.relay.send(msg);
    }
  }

  /* ───────────── Ping / RTT ───────────── */

  private startPing(): void {
    this.stopPing();
    const tick = () => this.send({ type: 'ping', seq: ++this.pingSeq, sentAt: performance.now() });
    tick();
    this.pingTimer = setInterval(tick, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /* ───────────── Outbound API ───────────── */

  sendGuestInput(packet: GuestInputPacket): void {
    if (useGameStore.getState().network.mode !== 'guest') return;
    this.send({ type: 'guest_input', packet });
  }

  sendLobbySync(packet: LobbySyncPacket): void {
    if (useGameStore.getState().network.mode !== 'host') return;
    this.send({ type: 'lobby_sync', packet });
  }

  sendGuestSlotUpdate(slot: HumanSlotConfig): void {
    if (useGameStore.getState().network.mode !== 'guest') return;
    this.send({ type: 'guest_slot', slot });
  }

  broadcastSnapshot(snapshot: WorldSnapshotPacket): void {
    if (useGameStore.getState().network.mode !== 'host') return;
    this.send({ type: 'world_snapshot', snapshot });
  }

  sendQuickChat(phraseId: string, playerId?: string | null): void {
    const mode = useGameStore.getState().network.mode;
    if (mode === 'offline') return;
    this.send({ type: 'quick_chat', phraseId, sender: mode, playerId });
  }

  /* ───────────── Subscriptions ───────────── */

  private subscribe<T>(set: Set<Listener<T>>, cb: Listener<T>): () => void {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  onGuestInput(cb: (packet: GuestInputPacket) => void): () => void {
    return this.subscribe(this.guestInputSubs, cb);
  }

  onSnapshot(cb: (snapshot: WorldSnapshotPacket) => void): () => void {
    return this.subscribe(this.snapshotSubs, cb);
  }

  onLobbySync(cb: (packet: LobbySyncPacket) => void): () => void {
    return this.subscribe(this.lobbySyncSubs, cb);
  }

  onGuestSlotUpdate(cb: (slot: HumanSlotConfig) => void): () => void {
    return this.subscribe(this.guestSlotSubs, cb);
  }

  onQuickChat(cb: (event: QuickChatNetworkEvent) => void): () => void {
    return this.subscribe(this.quickChatSubs, cb);
  }

  /* ───────────── Opt-in voice chat ───────────── */

  async toggleVoiceChat(): Promise<boolean> {
    const store = useGameStore.getState();
    if (store.network.voiceActive) {
      this.stopVoice(true);
      return false;
    }
    if (!this.peer || !this.conn?.open || !this.remotePeerId) {
      store.setNetworkState({ errorMessage: MSG_MIC_DENIED });
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      store.setNetworkState({ errorMessage: MSG_MIC_DENIED });
      return false;
    }

    const session = this.session;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      useGameStore.getState().setNetworkState({
        voiceActive: false,
        micMuted: true,
        errorMessage: MSG_MIC_DENIED,
      });
      return false;
    }

    if (session !== this.session || !this.peer || !this.conn?.open || !this.remotePeerId) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    this.localStream = stream;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });

    try {
      const call = this.peer.call(this.remotePeerId, stream);
      this.outgoingCall = call;
      call.on('stream', (remote) => this.playRemoteAudio(remote));
      call.on('close', () => {
        if (this.outgoingCall === call) this.outgoingCall = null;
      });
      call.on('error', () => {
        if (this.outgoingCall === call) this.outgoingCall = null;
      });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
      useGameStore.getState().setNetworkState({
        voiceActive: false,
        micMuted: true,
        errorMessage: MSG_GENERIC,
      });
      return false;
    }

    useGameStore.getState().setNetworkState({
      voiceActive: true,
      micMuted: false,
      errorMessage: null,
    });
    return true;
  }

  setMicMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    useGameStore.getState().setNetworkState({ micMuted: muted });
  }

  private handleIncomingCall(call: MediaConnection, session: number): void {
    if (session !== this.session) {
      call.close();
      return;
    }
    call.answer(this.localStream ?? undefined);
    this.incomingCall?.close();
    this.incomingCall = call;
    call.on('stream', (remote) => this.playRemoteAudio(remote));
    call.on('close', () => {
      if (this.incomingCall === call) this.incomingCall = null;
    });
    call.on('error', () => {
      if (this.incomingCall === call) this.incomingCall = null;
    });
  }

  private playRemoteAudio(stream: MediaStream): void {
    if (typeof document === 'undefined') return;
    if (!this.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.style.display = 'none';
      this.audioEl = el;
    }
    if (this.audioEl.srcObject !== stream) this.audioEl.srcObject = stream;
    void this.audioEl.play().catch(() => {
      /* autoplay blocked until next user gesture */
    });
  }

  private stopVoice(syncStore: boolean): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    try {
      this.outgoingCall?.close();
    } catch {
      /* ignore */
    }
    try {
      this.incomingCall?.close();
    } catch {
      /* ignore */
    }
    this.outgoingCall = null;
    this.incomingCall = null;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    const s = useGameStore.getState();
    if (syncStore || s.network.voiceActive) {
      s.setNetworkState({ voiceActive: false, micMuted: true });
    }
  }

  /* ───────────── Teardown ───────────── */

  private teardown(resetStore: boolean): void {
    this.manualClose = true;
    this.stopPing();
    this.stopVoice(false);
    const conn = this.conn;
    const peer = this.peer;
    const relay = this.relay;
    this.conn = null;
    this.peer = null;
    this.relay = null;
    this.relayPeerConnected = false;
    this.lastRelayPeerSeenAt = 0;
    this.remotePeerId = null;

    try {
      relay?.leave();
    } catch {
      /* ignore */
    }
    try {
      conn?.close();
    } catch {
      /* ignore */
    }
    try {
      peer?.destroy();
    } catch {
      /* ignore */
    }
    if (resetStore) {
      useGameStore.getState().setNetworkState({ ...DEFAULT_NETWORK_STATE });
    }
  }

  disconnect(): void {
    this.session++;
    this.teardown(true);
  }

  dispose(): void {
    const hadSession =
      this.session > 0 ||
      this.peer !== null ||
      this.conn !== null ||
      this.relay !== null;
    this.session++;
    this.teardown(hadSession);
    this.guestInputSubs.clear();
    this.snapshotSubs.clear();
    this.lobbySyncSubs.clear();
    this.guestSlotSubs.clear();
    this.quickChatSubs.clear();
    if (this.beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __ELMAL3AB_NET__?: INetworkManager };
      if (w.__ELMAL3AB_NET__ === this) delete w.__ELMAL3AB_NET__;
    }
  }
}
