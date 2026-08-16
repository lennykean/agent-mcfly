export function withConnection(path: string, connection?: string) {
  if (!connection) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set('connection', connection);
  return `${url.pathname}${url.search}`;
}
