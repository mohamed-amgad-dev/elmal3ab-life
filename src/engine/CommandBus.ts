import type { GameCommand } from '../types/game';

export type CommandHandler = (cmd: GameCommand) => void;

/**
 * Typed pub/sub event bus decoupling UI/input sources from MatchEngine.
 *
 * Online Multiplayer Hook:
 * When adding WebSocket/WebRTC netcode later, attach a network transport
 * subscriber here to forward local player commands to the room server, and
 * inject remote authoritative commands/snapshots back into `emit()`.
 */
export class CommandBus {
  private readonly listeners = new Set<CommandHandler>();

  emit(cmd: GameCommand): void {
    for (const handler of this.listeners) {
      handler(cmd);
    }
  }

  subscribe(handler: CommandHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const commandBus = new CommandBus();
