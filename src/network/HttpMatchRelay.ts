import type {
  GuestInputPacket,
  PeerWireMessage,
  WorldSnapshotPacket,
} from '../types/network';

/**
 * Guaranteed HTTPS port-443 match relay backed by Vercel (`elmal3ab-life-relay`).
 *
 * Runs alongside PeerJS WebRTC P2P so Egyptian ISPs, 4G/5G mobile data, and CGNAT
 * routers NEVER block room creation or joining. Coalesces high-frequency snapshots
 * and inputs while preserving every discrete command, event, and SFX trigger.
 */

const RELAY_API_URL = 'https://elmal3ab-life-relay.vercel.app/api/coop';
const SYNC_INTERVAL_MS = 100; // ~10 Hz smooth HTTPS sync
const FLUSH_DEBOUNCE_MS = 18;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONSECUTIVE_ERRORS = 12;

export type RelayWirePacket =
  | PeerWireMessage
  | { type: 'guest_hello' }
  | { type: 'room_full'; message?: string }
  | { type: 'peer_left' };

export interface RelayEnvelope {
  fromId: string;
  toId?: string;
  packet: RelayWirePacket;
}

export interface HttpMatchRelayHandlers {
  onEnvelope: (envelope: RelayEnvelope) => void;
  onSyncMeta?: (meta: {
    peerAlive: boolean;
    closed: boolean;
    rttMs: number;
  }) => void;
  onDisconnected?: (reason: 'host_left' | 'network_error') => void;
}

interface OutgoingItem {
  toId?: string;
  packet: RelayWirePacket;
}

interface RelayApiResponse {
  ok: boolean;
  reason?: string;
  closed?: boolean;
  peerAlive?: boolean;
  envelopes?: RelayEnvelope[];
  nextCursors?: Record<string, number>;
  nextRealtimeCursors?: Record<string, number>;
}

function coalesceGuestInput(
  prev: GuestInputPacket,
  next: GuestInputPacket,
): GuestInputPacket {
  if (prev.commands.length === 0) return next;
  return {
    ...next,
    commands: [...prev.commands, ...next.commands],
  };
}

function coalesceWorldSnapshot(
  prev: WorldSnapshotPacket,
  next: WorldSnapshotPacket,
): WorldSnapshotPacket {
  const mergedEvents =
    prev.events && prev.events.length > 0
      ? [...prev.events, ...(next.events ?? [])]
      : next.events;
  const mergedSfx =
    prev.sfx && prev.sfx.length > 0
      ? [...prev.sfx, ...(next.sfx ?? [])]
      : next.sfx;
  return {
    ...next,
    events: mergedEvents,
    sfx: mergedSfx,
  };
}

export class HttpMatchRelay {
  private readonly roomCode: string;
  private readonly playerId: string;
  private readonly isHost: boolean;
  private readonly handlers: HttpMatchRelayHandlers;

  private active = false;
  private closed = false;
  private inFlight = false;
  private flushRequested = false;
  private consecutiveErrors = 0;

  private pendingRealtime: RelayWirePacket | null = null;
  private outgoingQueue: OutgoingItem[] = [];
  private cursors: Record<string, number> = {};
  private realtimeCursors: Record<string, number> = {};

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    roomCode: string,
    playerId: string,
    isHost: boolean,
    handlers: HttpMatchRelayHandlers,
  ) {
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.isHost = isHost;
    this.handlers = handlers;
  }

  public isActive(): boolean {
    return this.active && !this.closed;
  }

  public async create(): Promise<{ ok: boolean; reason?: string }> {
    const t0 = performance.now();
    const res = await this.post({
      action: 'create',
      room: this.roomCode,
      playerId: this.playerId,
    });
    if (res.ok && !this.closed) {
      this.active = true;
      this.startLoop();
      this.handlers.onSyncMeta?.({
        peerAlive: false,
        closed: false,
        rttMs: Math.round(performance.now() - t0),
      });
    }
    return { ok: res.ok, reason: res.reason };
  }

  public async join(
    initialPacket?: RelayWirePacket,
  ): Promise<{ ok: boolean; reason?: string }> {
    const t0 = performance.now();
    const outgoing: OutgoingItem[] = initialPacket
      ? [{ toId: '__host__', packet: initialPacket }]
      : [];
    const res = await this.post({
      action: 'join',
      room: this.roomCode,
      playerId: this.playerId,
      outgoing,
      cursors: this.cursors,
      realtimeCursors: this.realtimeCursors,
    });

    if (res.ok && !this.closed) {
      this.active = true;
      this.applyResponse(res, Math.round(performance.now() - t0));
      this.startLoop();
    }

    return { ok: res.ok, reason: res.reason };
  }

  public send(packet: RelayWirePacket): void {
    if (this.closed || !this.active) return;

    if (packet.type === 'guest_input') {
      if (this.pendingRealtime?.type === 'guest_input') {
        this.pendingRealtime = {
          type: 'guest_input',
          packet: coalesceGuestInput(this.pendingRealtime.packet, packet.packet),
        };
      } else {
        this.pendingRealtime = packet;
      }
      if (packet.packet.commands.length > 0) {
        this.scheduleImmediateFlush();
      }
      return;
    }

    if (packet.type === 'world_snapshot') {
      if (this.pendingRealtime?.type === 'world_snapshot') {
        this.pendingRealtime = {
          type: 'world_snapshot',
          snapshot: coalesceWorldSnapshot(
            this.pendingRealtime.snapshot,
            packet.snapshot,
          ),
        };
      } else {
        this.pendingRealtime = packet;
      }
      return;
    }

    this.outgoingQueue.push({
      toId: this.isHost ? undefined : '__host__',
      packet,
    });
    if (this.outgoingQueue.length > 32) {
      this.outgoingQueue = this.outgoingQueue.slice(-32);
    }
    this.scheduleImmediateFlush();
  }

  public leave(): void {
    if (this.closed) return;
    this.closed = true;
    const wasActive = this.active;
    this.active = false;
    this.stopTimers();

    if (!wasActive) return;

    const payload = JSON.stringify({
      action: 'leave',
      room: this.roomCode,
      playerId: this.playerId,
      outgoing: [{ packet: { type: 'peer_left' } }],
    });

    try {
      void fetch(RELAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Ignore during unload
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.stopTimers();
  }

  private startLoop(): void {
    this.stopTimers();
    this.syncTimer = setInterval(() => {
      void this.syncNow();
    }, SYNC_INTERVAL_MS);
  }

  private scheduleImmediateFlush(): void {
    if (this.closed || !this.active) return;
    if (this.inFlight) {
      this.flushRequested = true;
      return;
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.syncNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async syncNow(): Promise<void> {
    if (this.closed || !this.active || this.inFlight) return;
    this.inFlight = true;
    this.flushRequested = false;

    const realtimeToSend = this.pendingRealtime;
    this.pendingRealtime = null;
    const batch = this.outgoingQueue.splice(0, 16);
    const t0 = performance.now();

    try {
      const res = await this.post({
        action: 'sync',
        room: this.roomCode,
        playerId: this.playerId,
        realtime: realtimeToSend,
        outgoing: batch,
        cursors: this.cursors,
        realtimeCursors: this.realtimeCursors,
      });

      if (this.closed) return;

      if (res.ok) {
        this.consecutiveErrors = 0;
        const rttMs = Math.max(1, Math.round(performance.now() - t0));
        this.applyResponse(res, rttMs);

        if (res.closed && !this.isHost) {
          this.close();
          this.handlers.onDisconnected?.('host_left');
        }
      } else {
        if (batch.length > 0 && res.reason !== 'room_not_found') {
          this.outgoingQueue.unshift(...batch);
        }
        if (res.reason === 'room_not_found' && !this.isHost) {
          this.close();
          this.handlers.onDisconnected?.('host_left');
          return;
        }
        this.consecutiveErrors += 1;
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.close();
          this.handlers.onDisconnected?.('network_error');
        }
      }
    } finally {
      this.inFlight = false;
      if (
        !this.closed &&
        this.active &&
        (this.flushRequested || this.outgoingQueue.length > 0)
      ) {
        this.scheduleImmediateFlush();
      }
    }
  }

  private applyResponse(res: RelayApiResponse, rttMs: number): void {
    if (res.nextCursors) this.cursors = res.nextCursors;
    if (res.nextRealtimeCursors) this.realtimeCursors = res.nextRealtimeCursors;

    this.handlers.onSyncMeta?.({
      peerAlive: Boolean(res.peerAlive),
      closed: Boolean(res.closed),
      rttMs,
    });

    if (Array.isArray(res.envelopes)) {
      for (const env of res.envelopes) {
        if (!env || !env.packet) continue;
        this.handlers.onEnvelope(env);
      }
    }
  }

  private async post(body: Record<string, unknown>): Promise<RelayApiResponse> {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    try {
      const response = await fetch(RELAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller?.signal,
      });

      const data = (await response.json().catch(() => ({}))) as RelayApiResponse;
      if (!response.ok) {
        return {
          ok: false,
          reason: data.reason || `http_${response.status}`,
        };
      }
      return data;
    } catch {
      return { ok: false, reason: 'network_error' };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private stopTimers(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
