export function withConnection(path: string, connection?: string) {
  if (!connection) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set('connection', connection);
  return `${url.pathname}${url.search}`;
}

export function parseSshPwd(value: string) {
  if (!/^ssh:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    const port = url.port ? Number(url.port) : 22;
    if (url.protocol !== 'ssh:' || !url.hostname || url.username || url.password
      || url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    let pwd = decodeURIComponent(url.pathname || '/');
    if (/^\/[a-z]:[\\/]/i.test(pwd)) pwd = pwd.slice(1);
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port, pwd };
  } catch { return undefined; }
}

export function formatSshPwd(host: string, port: number, pwd: string) {
  const bareHost = host.replace(/^\[|\]$/g, '');
  const authority = bareHost.includes(':') ? `[${bareHost}]` : bareHost;
  const remotePath = pwd.startsWith('/') ? pwd : `/${pwd}`;
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  return `ssh://${authority}${port === 22 ? '' : `:${port}`}${encodedPath}`;
}
