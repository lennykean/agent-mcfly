import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { AGENT_TOOLS } from './pty.js';

const { Client } = ssh2;

const connections = new Map();
const knownHostsFile = () => process.env.MCFLY_SSH_KNOWN_HOSTS
  || path.join(os.homedir(), '.mcfly', 'ssh-known-hosts.json');
const hostKey = (host, port) => JSON.stringify([host.toLowerCase(), port]);
const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

function knownHosts() {
  try { return JSON.parse(fs.readFileSync(knownHostsFile(), 'utf8')); }
  catch { return {}; }
}

function rememberHost(host, port, value) {
  const file = knownHostsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...knownHosts(), [hostKey(host, port)]: value }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

function cleanOptions(options) {
  let host = String(options?.host ?? '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = options?.port == null || options.port === '' ? 22 : Number(options.port);
  const username = String(options?.username ?? '').trim();
  if (!host || host.length > 255 || /[\s/@\0]/.test(host)) throw new Error('invalid SSH host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid SSH port');
  if (!username || username.length > 255 || /[\r\n\0]/.test(username)) throw new Error('invalid SSH username');
  if (options.password != null && (typeof options.password !== 'string' || options.password.length > 4096)) throw new Error('invalid SSH password');
  if (options.privateKey != null && (typeof options.privateKey !== 'string' || options.privateKey.length > 1024 * 1024)) throw new Error('invalid SSH private key');
  if (options.passphrase != null && (typeof options.passphrase !== 'string' || options.passphrase.length > 4096)) throw new Error('invalid SSH passphrase');
  return { ...options, host, port, username, label: String(options.label ?? host).slice(0, 255) };
}

function publicRecord(record) {
  const { id, host, port, username, label, fingerprint: hostFingerprint, connectedAt, home, platform, tools } = record;
  return { id, host, port, username, label, fingerprint: hostFingerprint, connectedAt, home, platform, tools };
}

function requireSftp(record) {
  return new Promise((resolve, reject) => {
    record.client.sftp((error, sftp) => {
      if (error) {
        const unavailable = new Error(`SSH connected, but SFTP is unavailable: ${error.message ?? error}`);
        unavailable.code = 'SFTP_UNAVAILABLE';
        reject(unavailable);
        return;
      }
      sftp.end();
      resolve();
    });
  });
}

export function getSshConnection(id) {
  return connections.get(String(id ?? ''));
}

export function listSshConnections() {
  return [...connections.values()].map(publicRecord);
}

export function execSsh(recordOrId, command, { timeout = 30_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const record = typeof recordOrId === 'string' ? getSshConnection(recordOrId) : recordOrId;
  if (!record?.client) return Promise.reject(new Error('SSH connection not found'));
  return new Promise((resolve, reject) => {
    let stream;
    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.client.removeListener?.('close', onDisconnect);
      error ? reject(error) : resolve(value);
    };
    const onDisconnect = () => finish(new Error('SSH connection closed during command'));
    const timer = setTimeout(() => {
      finish(new Error('SSH command timed out'));
      try { stream?.close(); } catch { /* already closed */ }
    }, timeout);
    record.client.once?.('close', onDisconnect);
    try {
      record.client.exec(String(command), (error, channel) => {
        if (error) return finish(error);
        if (settled) {
          try { channel.close(); } catch { /* timed out before the channel opened */ }
          return;
        }
        stream = channel;
        const collect = (target) => (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > maxBytes) {
            finish(new Error('SSH command output too large'));
            try { stream.close(); } catch { /* already closed */ }
            return;
          }
          if (target === 'stdout') stdout += chunk;
          else stderr += chunk;
        };
        stream.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        stream.on('data', collect('stdout'));
        stream.stderr.on('data', collect('stderr'));
        stream.once('error', (e) => finish(e));
        stream.once('close', (code, signal) => finish(null, { stdout, stderr, code, signal }));
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function probe(record) {
  await requireSftp(record);
  const posix = await execSsh(record,
    `printf '__MCFLY_HOME__%s\\n__MCFLY_PLATFORM__%s\\n' "$HOME" "$(uname -s 2>/dev/null)"; `
    + AGENT_TOOLS.map((tool) => `command -v ${tool} >/dev/null 2>&1 && printf '__MCFLY_TOOL__${tool}\\n';`).join(' ')
    + ' true',
    { timeout: 5_000, maxBytes: 64 * 1024 }).catch(() => ({ stdout: '' }));
  let output = posix.stdout;
  if (!output.includes('__MCFLY_PLATFORM__')) {
    output = (await execSsh(record,
      `cmd /d /s /c "echo __MCFLY_HOME__%USERPROFILE%&echo __MCFLY_PLATFORM__win32&${AGENT_TOOLS.map((tool) => `where ${tool} >nul 2>nul && echo __MCFLY_TOOL__${tool}`).join('&')}"`,
      { timeout: 5_000, maxBytes: 64 * 1024 }).catch(() => ({ stdout: '' }))).stdout;
  }
  record.home = output.match(/^__MCFLY_HOME__(.*)$/m)?.[1]?.trim() || null;
  const remotePlatform = output.match(/^__MCFLY_PLATFORM__(.*)$/m)?.[1]?.trim().toLowerCase();
  record.platform = remotePlatform === 'windows' || remotePlatform === 'win32' ? 'win32'
    : remotePlatform === 'darwin' ? 'darwin' : remotePlatform === 'linux' ? 'linux' : remotePlatform || null;
  record.tools = [...output.matchAll(/^__MCFLY_TOOL__(.+)$/gm)].map((m) => m[1].trim());
  if (!record.home) {
    const error = new Error('SSH connected, but remote command execution or home-directory detection failed');
    error.code = 'SSH_PROBE_FAILED';
    throw error;
  }
}

export async function connectSsh(rawOptions) {
  const options = cleanOptions(rawOptions);
  rawOptions = undefined;
  let { password, privateKey, passphrase } = options;
  delete options.password;
  delete options.privateKey;
  delete options.passphrase;
  const expectedFingerprint = knownHosts()[hostKey(options.host, options.port)];
  let presentedFingerprint;
  let rejectedHost = false;
  const client = new Client();
  const record = {
    id: crypto.randomUUID(), client, host: options.host, port: options.port,
    username: options.username, label: options.label, fingerprint: null,
    connectedAt: Date.now(), home: null, platform: null, tools: [],
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.end();
      if (rejectedHost) {
        const firstContact = !expectedFingerprint;
        const hostError = new Error(firstContact ? 'SSH host key needs confirmation' : 'SSH host key changed');
        hostError.status = 409;
        hostError.code = firstContact ? 'HOST_KEY_UNKNOWN' : 'HOST_KEY_MISMATCH';
        hostError.host = options.host;
        hostError.port = options.port;
        hostError.fingerprint = presentedFingerprint;
        if (expectedFingerprint) hostError.expectedFingerprint = expectedFingerprint;
        reject(hostError);
      } else reject(error);
    };
    client.on('error', fail);
    client.once('close', () => connections.delete(record.id));
    client.once('ready', async () => {
      record.fingerprint = presentedFingerprint;
      connections.set(record.id, record);
      // ssh2 keeps the supplied authentication values on its config object;
      // authentication is complete, so do not retain those plaintext inputs.
      client.config.password = undefined;
      client.config.privateKey = undefined;
      client.config.passphrase = undefined;
      try {
        await probe(record);
        if (!connections.has(record.id)) throw new Error('SSH connection closed');
        if (expectedFingerprint !== presentedFingerprint) rememberHost(options.host, options.port, presentedFingerprint);
        settled = true;
        resolve(publicRecord(record));
      } catch (error) {
        connections.delete(record.id);
        fail(error);
      }
    });

    const agent = password == null && privateKey == null
      ? process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined)
      : undefined;
    try {
      client.connect({
        host: options.host, port: options.port, username: options.username,
        password, privateKey, passphrase, agent,
        readyTimeout: 20_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
        hostVerifier(key) {
          presentedFingerprint = fingerprint(key);
          const accepted = expectedFingerprint === presentedFingerprint || options.fingerprint === presentedFingerprint;
          rejectedHost = !accepted;
          return accepted;
        },
      });
    } catch (error) {
      fail(error);
    } finally {
      password = undefined;
      privateKey = undefined;
      passphrase = undefined;
    }
  });
}

export function disconnectSsh(id) {
  const record = getSshConnection(id);
  if (!record) return false;
  connections.delete(record.id);
  record.client.end();
  return true;
}

export function disconnectAllSsh() {
  for (const record of connections.values()) record.client.end();
  connections.clear();
}
