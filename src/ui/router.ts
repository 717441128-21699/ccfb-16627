/**
 * 极简 hash 路由
 */
export type Route =
  | { name: 'overview' }
  | { name: 'channel'; ch: number }
  | { name: 'alerts' }
  | { name: 'reversal' }
  | { name: 'datasets' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  if (name === 'channel') {
    const ch = Math.max(0, Math.min(23, parseInt(param ?? '0', 10) || 0));
    return { name: 'channel', ch };
  }
  if (name === 'alerts') return { name: 'alerts' };
  if (name === 'reversal') return { name: 'reversal' };
  if (name === 'datasets') return { name: 'datasets' };
  return { name: 'overview' };
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'channel':
      return `#/channel/${r.ch}`;
    case 'alerts':
      return '#/alerts';
    case 'reversal':
      return '#/reversal';
    case 'datasets':
      return '#/datasets';
    default:
      return '#/overview';
  }
}
