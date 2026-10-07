export type Route = { kind: 'list' } | { kind: 'note'; id: number };

export function parseRoute(url: string): Route {
  const match = /^[a-z][a-z0-9+.-]*:\/\/\/?note\/(\d+)\/?(?:[?#].*)?$/i.exec(url);
  return match ? { kind: 'note', id: Number(match[1]) } : { kind: 'list' };
}
