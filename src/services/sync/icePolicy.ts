export type IceMode = 'stun' | 'turn' | 'turn+stun';
export type IceTransport = 'all' | 'relay';

export type IceConfig = {
  mode: IceMode;
  transport: IceTransport;
  iceServers: RTCIceServer[];
};

export const hasTurn = (iceServers: RTCIceServer[]) =>
  iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => typeof url === 'string' && (url.startsWith('turn:') || url.startsWith('turns:')));
  });

export const iceKey = (server: RTCIceServer) => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return `${urls.join('|')}|${server.username || ''}|${String(server.credential || '')}`;
};

export const mergeIceServers = (primary: RTCIceServer[], secondary: RTCIceServer[]) => {
  const seen = new Set<string>();
  const merged: RTCIceServer[] = [];
  const addServer = (server: RTCIceServer) => {
    const key = iceKey(server);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(server);
  };
  primary.forEach(addServer);
  secondary.forEach(addServer);
  return merged;
};

const iceServersEqual = (a: RTCIceServer[], b: RTCIceServer[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (iceKey(a[i]) !== iceKey(b[i])) return false;
  }
  return true;
};

export function computeIceConfigs(opts: {
  platform: { isIPhone: boolean };
  stun: RTCIceServer[];
  turn: RTCIceServer[] | null;
}): {
  initial: IceConfig;
  upgrade?: IceConfig;
} {
  const hasTurnServers = !!(opts.turn && opts.turn.length && hasTurn(opts.turn));
  const initial: IceConfig = hasTurnServers
    ? { mode: 'turn', transport: 'all', iceServers: opts.turn as RTCIceServer[] }
    : { mode: 'stun', transport: 'all', iceServers: opts.stun };

  if (!hasTurnServers) return { initial };

  const upgradeServers = opts.platform.isIPhone
    ? (opts.turn as RTCIceServer[])
    : mergeIceServers(opts.turn as RTCIceServer[], opts.stun);
  const upgradeMode: IceMode = opts.platform.isIPhone ? 'turn' : 'turn+stun';
  if (upgradeMode === initial.mode && iceServersEqual(upgradeServers, initial.iceServers)) {
    return { initial };
  }

  return {
    initial,
    upgrade: {
      mode: upgradeMode,
      transport: 'all',
      iceServers: upgradeServers
    }
  };
}
