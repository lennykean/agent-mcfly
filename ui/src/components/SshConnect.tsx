import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSource } from '../types';

interface SshConnection {
  id: string;
  host: string;
  port: number;
  home?: string;
}

interface HostKeyChallenge {
  code: 'HOST_KEY_UNKNOWN' | 'HOST_KEY_MISMATCH';
  fingerprint?: string;
  expectedFingerprint?: string;
  error?: string;
}

export function SshConnect({ onConnected, onClose }: {
  onConnected: (source: WorkspaceSource, home: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<'agent' | 'password' | 'key'>('agent');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [challenge, setChallenge] = useState<HostKeyChallenge>();
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    mounted.current = true;
    dialog.showModal();
    hostRef.current?.focus();
    return () => { mounted.current = false; if (dialog.open) dialog.close(); };
  }, []);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (auth === 'key' && !privateKey) { setError('Choose a private key file.'); return; }
    setConnecting(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        host: host.trim(),
        port: Number(port),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(auth === 'password' ? { password } : {}),
        ...(auth === 'key' ? { privateKey, ...(passphrase ? { passphrase } : {}) } : {}),
        ...(challenge?.fingerprint ? { fingerprint: challenge.fingerprint } : {}),
      };
      const response = await fetch('/api/ssh/connect', { method: 'POST', body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!mounted.current) {
        if (response.ok && data.id) void fetch('/api/ssh/disconnect', { method: 'POST', body: JSON.stringify({ id: data.id }) });
        return;
      }
      if (response.status === 409 && (data.code === 'HOST_KEY_UNKNOWN' || data.code === 'HOST_KEY_MISMATCH')) {
        setChallenge(data);
        return;
      }
      if (!response.ok) throw new Error(data.error || `SSH connection failed (${response.status})`);
      const connection = data as SshConnection;
      if (!connection.id) throw new Error('SSH connection did not return an id.');
      onConnected({
        connection: connection.id,
        host: connection.host || host.trim(),
        port: connection.port || Number(port),
      }, connection.home || '');
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'SSH connection failed.');
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="pickerOverlay"
      aria-labelledby="ssh-connect-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={onClose}
    >
      <form className="pickerModal sshModal" onSubmit={connect} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="pickerHead">
          <span id="ssh-connect-title">connect over SSH</span>
          <button type="button" className="pickerClose" aria-label="Close SSH connection dialog" onClick={onClose}>✕</button>
        </div>

        <div className="sshGrid">
          <label htmlFor="ssh-host">hostname</label>
          <input ref={hostRef} id="ssh-host" className="pickerInput" required value={host} onChange={(e) => { setHost(e.target.value); setChallenge(undefined); }} spellCheck={false} />

          <label htmlFor="ssh-port">port</label>
          <input id="ssh-port" className="pickerInput" type="number" min="1" max="65535" required value={port} onChange={(e) => { setPort(e.target.value); setChallenge(undefined); }} />

          <label htmlFor="ssh-user">username</label>
          <input id="ssh-user" className="pickerInput" required value={username} onChange={(e) => { setUsername(e.target.value); setChallenge(undefined); }} autoComplete="username" spellCheck={false} />

          <label htmlFor="ssh-auth">credentials</label>
          <select id="ssh-auth" className="pickerInput" value={auth} onChange={(e) => { setAuth(e.target.value as typeof auth); setChallenge(undefined); }}>
            <option value="agent">SSH agent</option>
            <option value="password">password</option>
            <option value="key">private key</option>
          </select>

          {auth === 'password' && <>
            <label htmlFor="ssh-password">password</label>
            <input id="ssh-password" className="pickerInput" type="password" required value={password} onChange={(e) => { setPassword(e.target.value); setChallenge(undefined); }} autoComplete="current-password" />
          </>}

          {auth === 'key' && <>
            <label htmlFor="ssh-key">private key</label>
            <span className="sshFile">
              <input
                id="ssh-key"
                type="file"
                  required
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    setPrivateKey('');
                    setChallenge(undefined);
                    if (file) void file.text().then(setPrivateKey).catch(() => setError('Could not read that private key.'));
                  }}
                />
            </span>

            <label htmlFor="ssh-passphrase">passphrase</label>
            <input id="ssh-passphrase" className="pickerInput" type="password" value={passphrase} onChange={(e) => { setPassphrase(e.target.value); setChallenge(undefined); }} autoComplete="off" />
          </>}
        </div>

        {challenge && (
          <div className="sshFingerprint" role="alert">
            <strong>{challenge.code === 'HOST_KEY_MISMATCH' ? 'Host key changed' : 'Unknown host key'}</strong>
            {challenge.expectedFingerprint && <span>expected: <code>{challenge.expectedFingerprint}</code></span>}
            <span>fingerprint: <code>{challenge.fingerprint || 'unavailable'}</code></span>
            <span>Confirm this fingerprint before connecting.</span>
          </div>
        )}
        {error && <div className="sshError" role="alert">{error}</div>}

        <div className="fbActions">
          <button type="button" onClick={onClose}>cancel</button>
          <button type="submit" disabled={connecting || (!!challenge && !challenge.fingerprint)}>
            {connecting ? 'connecting…' : challenge ? 'trust and connect' : 'connect'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
