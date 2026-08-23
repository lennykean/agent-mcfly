/** @typedef {import('../types').PeerReference} PeerReference */

/** @param {PeerReference} peer */
export const peerLabel = (peer) =>
  peer.title || peer.session_id?.split('/').pop() || peer.tool || 'peer';

/** @param {PeerReference} peer */
export function peerSession(peer) {
  if (!peer.session_id || !peer.provider || !peer.workspace) return null;
  return {
    id: peer.session_id,
    provider: peer.provider,
    project: peer.workspace,
    cwd: peer.workspace,
    label: peerLabel(peer),
    updated_at: 0,
    size: 0,
  };
}
