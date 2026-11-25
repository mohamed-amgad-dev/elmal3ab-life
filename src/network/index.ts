import type { INetworkManager } from '../types/network';

export { PeerNetworkManager, parseRoomSuffix } from './PeerNetworkManager';

/** Returns the live network manager registered on `window.__ELMAL3AB_NET__` (or `null`). */
export function getGlobalNetworkManager(): INetworkManager | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __ELMAL3AB_NET__?: INetworkManager }).__ELMAL3AB_NET__ ?? null;
}
