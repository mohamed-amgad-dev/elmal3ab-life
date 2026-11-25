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

/* ───────────────────────── Constants ───────────────────────── */

const ROOM_PREFIX = 'ML3B-';
const PEER_ID_PREFIX = 'elmal3ab-v3-ml3b-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;
const MAX_CREATE_ATTEMPTS = 5; // first try + 4 retries on `unavailable-id`
const JOIN_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 1500;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const MSG_ROOM_NOT_FOUND = 'ملقيناش الروم دي — اتأكد إن صاحبك فاتح اللوبي والكود صح!';
const MSG_BAD_CODE = 'الكود مش مظبوط — لازم يبقى شكله ML3B-XXXX';
const MSG_TIMEOUT = 'الاتصال أخد وقت طويل — اتأكد من النت وجرّب تاني!';
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
  private session = 0;
  private manualClose = false;

  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;

  private remotePeerId: string | null = null;
  private localStream: MediaStream | null = null;
  private outgoingCall: MediaConnection | null = null;
  private incomingCall: MediaConnection | null = null;
  private audioEl: HTMLAudioElement | null = null;

  private readonly guestInputSubs = new Set<Listener<GuestInputPacket>>();
  private readonly snapshotSubs = new Set<Listener<WorldSnapshotPacket>>();
  private readonly lobbySyncSubs = new Set<Listener<LobbySyncPacket>>();
  private readonly guestSlotSubs = new Set<Listener<HumanSlotConfig>>();
  private readonly quickChatSubs = new Set<Listener<QuickChatNetworkEvent>>();

  constructor() {
    if (typeof window !== 'undefined') {
      (window as unknown as { __ELMAL3AB_NET__?: INetworkManager }).__ELMAL3AB_NET__ = this;
    }
  }

  /* ───────────── Room creation (Host) ───────────── */

  createRoom(): Promise<string> {
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

    return new Promise<string>((resolve) => {
      let attempt = 0;
      const tryCreate = () => {
        if (session !== this.session) {
          resolve('');
          return;
        }
        attempt++;
        const suffix = randomRoomSuffix();
        const displayCode = `${ROOM_PREFIX}${suffix}`;
        const peerId = `${PEER_ID_PREFIX}${suffix.toLowerCase()}`;
        let peer: Peer;
        try {
          peer = new Peer(peerId, { config: { iceServers: ICE_SERVERS } });
        } catch {
          this.failHost(session, MSG_CREATE_FAILED);
          resolve('');
          return;
        }
        this.peer = peer;
        let opened = false;

        peer.on('open', () => {
          if (session !== this.session) return;
          opened = true;
          useGameStore.getState().setNetworkState({
            mode: 'host',
            status: 'waiting_peer',
            roomCode: displayCode,
            peerConnected: false,
            errorMessage: null,
          });
          resolve(displayCode);
        });

        peer.on('connection', (incoming) => {
          if (session !== this.session) {
            incoming.close();
            return;
          }
          if (this.conn && this.conn.open) {
            // Room is full: politely refuse the extra visitor.
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

        peer.on('error', (err: PeerErrorLike) => {
          if (session !== this.session) return;
          if (err.type === 'unavailable-id' && !opened) {
            try {
              peer.destroy();
            } catch {
              /* ignore */
            }
            if (this.peer === peer) this.peer = null;
            if (attempt < MAX_CREATE_ATTEMPTS) {
              tryCreate();
            } else {
              this.failHost(session, MSG_CREATE_FAILED);
              resolve('');
            }
            return;
          }
          if (!opened) {
            this.failHost(session, MSG_CREATE_FAILED);
            resolve('');
            return;
          }
          // Post-open errors (e.g. signalling hiccups) must not kill a live room.
          if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            try {
              if (!peer.destroyed) peer.reconnect();
            } catch {
              /* ignore */
            }
          }
        });
      };
      tryCreate();
    });
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

  joinRoom(rawCode: string): Promise<void> {
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
      return Promise.resolve();
    }

    const displayCode = `${ROOM_PREFIX}${suffix}`;
    const hostPeerId = `${PEER_ID_PREFIX}${suffix.toLowerCase()}`;
    store.setNetworkState({
      mode: 'guest',
      status: 'connecting',
      roomCode: displayCode,
      peerConnected: false,
      pingMs: 0,
      errorMessage: null,
    });

    // Never rejects: failures surface through `network.status === 'error'`.
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        this.clearJoinTimer();
        resolve();
      };
      const fail = (message: string) => {
        if (session !== this.session) {
          settle();
          return;
        }
        this.teardown(false);
        useGameStore.getState().setNetworkState({
          mode: 'guest',
          status: 'error',
          roomCode: displayCode,
          peerConnected: false,
          pingMs: 0,
          errorMessage: message,
        });
        settle();
      };

      this.joinTimer = setTimeout(() => {
        if (!settled) fail(MSG_TIMEOUT);
      }, JOIN_TIMEOUT_MS);

      let peer: Peer;
      try {
        peer = new Peer({ config: { iceServers: ICE_SERVERS } });
      } catch {
        fail(MSG_GENERIC);
        return;
      }
      this.peer = peer;
      this.remotePeerId = hostPeerId;

      peer.on('open', () => {
        if (session !== this.session) return;
        let conn: DataConnection;
        try {
          conn = peer.connect(hostPeerId, {
            reliable: true,
            serialization: 'json',
            label: 'elmal3ab-v3',
          });
        } catch {
          fail(MSG_GENERIC);
          return;
        }
        this.attachConnection(conn, session, false, () => settle());
      });

      peer.on('call', (call) => this.handleIncomingCall(call, session));

      peer.on('error', (err: PeerErrorLike) => {
        if (session !== this.session) return;
        if (err.type === 'peer-unavailable') {
          fail(MSG_ROOM_NOT_FOUND);
        } else if (!this.conn?.open) {
          fail(MSG_GENERIC);
        }
      });

      peer.on('disconnected', () => {
        // Signalling socket dropped: an open DataConnection survives, so do nothing.
      });
    });
  }

  /* ───────────── DataConnection wiring ───────────── */

  private attachConnection(
    conn: DataConnection,
    session: number,
    isHost: boolean,
    onOpen?: () => void,
  ): void {
    this.conn = conn;
    this.remotePeerId = conn.peer;

    conn.on('open', () => {
      if (session !== this.session || this.conn !== conn) return;
      this.clearJoinTimer();
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
      onOpen?.();
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
    const store = useGameStore.getState();
    if (isHost) {
      // Keep the room alive so the friend can rejoin with the same code.
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
    const msg = raw as PeerWireMessage | { type: 'room_full'; message?: string };
    const store = useGameStore.getState();

    switch (msg.type) {
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
        // Echo the (possibly conflict-resolved) slots back so both peers stay in sync.
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
    if (!c || !c.open) return;
    try {
      c.send(msg);
    } catch {
      /* connection is closing; the close handler will clean up */
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

  private clearJoinTimer(): void {
    if (this.joinTimer !== null) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
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
    if (!this.peer || !this.conn?.open || !this.remotePeerId) return false;
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

    // Session ended (or connection dropped) while the permission prompt was open.
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
    // Answer with our mic if voice is on; otherwise listen-only (no getUserMedia).
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
      /* autoplay blocked until next user gesture; `autoplay` attribute retries */
    });
  }

  /** Stops mic + calls. `syncStore` also flips `voiceActive`/`micMuted` back to defaults. */
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
    this.clearJoinTimer();
    this.stopPing();
    this.stopVoice(false);
    const conn = this.conn;
    const peer = this.peer;
    this.conn = null;
    this.peer = null;
    this.remotePeerId = null;
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
    this.session++; // invalidate every pending callback
    this.teardown(true);
  }

  dispose(): void {
    this.disconnect();
    this.guestInputSubs.clear();
    this.snapshotSubs.clear();
    this.lobbySyncSubs.clear();
    this.guestSlotSubs.clear();
    this.quickChatSubs.clear();
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __ELMAL3AB_NET__?: INetworkManager };
      if (w.__ELMAL3AB_NET__ === this) delete w.__ELMAL3AB_NET__;
    }
  }
}
