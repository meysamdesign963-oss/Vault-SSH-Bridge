/**
 * Vault SSH Bridge — network discovery & public-tunnel helpers.
 *
 * Pure functions (no Obsidian imports) so the test harness can use them too:
 * - LAN IPv4 discovery (os.networkInterfaces)
 * - best-LAN-IP selection
 * - public tunnel endpoint parsing (pinggy / serveo / generic)
 * - tunnel command building (system ssh client)
 */

import * as os from 'os';

export interface LanIP {
  name: string;
  address: string;
}

/** All non-internal IPv4 addresses of this machine (LAN IPs). */
export function lanIPv4s(): LanIP[] {
  const out: LanIP[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, list] of Object.entries(ifaces)) {
      for (const ni of list ?? []) {
        if (String((ni as { family: unknown }).family) === 'IPv4' && !(ni as { internal: boolean }).internal) {
          out.push({ name, address: (ni as { address: string }).address });
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function isPrivateIPv4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
}

/** Best LAN IP to show the user (private ranges first, e.g. 192.168.x.x). */
export function bestLanIPv4(): string {
  const ips = lanIPv4s();
  const priv = ips.find((i) => isPrivateIPv4(i.address));
  if (priv) return priv.address;
  return ips[0]?.address ?? '';
}

export interface TunnelEndpoint {
  host: string;
  port: number;
}

function validHost(h: string): boolean {
  return (
    !!h &&
    h !== '127.0.0.1' &&
    h !== 'localhost' &&
    h !== '0.0.0.0' &&
    h !== '::1' &&
    h !== '::' &&
    !h.startsWith('.')
  );
}

function validPort(p: number, localPort?: number): boolean {
  return isFinite(p) && p > 0 && p <= 65535 && !(localPort && p === localPort);
}

/**
 * Parse the public endpoint a tunnel client prints, e.g.
 *   pinggy: "Tcp URL  : tcp://abcdef.a.pinggy.io:43210"
 *   serveo: "Forwarding TCP connections to serveo.net:52812"
 *   generic: "tunnel.example.com:43210" or "203.0.113.7:43210"
 * Returns the first plausible public host:port (loopback and the local
 * forward port are ignored).
 */
export function parseTunnelEndpoint(text: string, localPort?: number): TunnelEndpoint | null {
  if (!text) return null;
  const candidates: TunnelEndpoint[] = [];
  const push = (hostRaw: string, portRaw: string) => {
    const host = hostRaw.replace(/^\[|\]$/g, '').toLowerCase();
    const port = parseInt(portRaw, 10);
    if (!validHost(host) || !validPort(port, localPort)) return;
    candidates.push({ host, port });
  };
  // 1) explicit tcp:// URLs (pinggy prints "tcp://host:port")
  for (const m of text.matchAll(/tcp:\/\/([a-zA-Z0-9.\-]+):(\d{2,5})/g)) push(m[1], m[2]);
  // 2) serveo-style "Forwarding TCP connections to host:port"
  for (const m of text.matchAll(/forwarding tcp connections? to ([a-zA-Z0-9.\-]+):(\d{2,5})/gi)) push(m[1], m[2]);
  // 3) hostname:port (host must look like a DNS name)
  for (const m of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9\-]*(?:\.[a-zA-Z0-9\-]+)+):(\d{2,5})\b/g)) push(m[1], m[2]);
  // 4) bare public IPv4:port
  for (const m of text.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g)) push(m[1], m[2]);
  return candidates.length ? candidates[0] : null;
}

export type TunnelServiceKind = 'pinggy' | 'serveo' | 'custom';

export interface TunnelSpec {
  cmd: string;
  args: string[];
  service: string;
}

/**
 * Build the system-ssh command that opens a reverse tunnel:
 * public TCP :0 (service-assigned) -> 127.0.0.1:<localPort>.
 * For 'custom', the user template may contain {PORT} (local port).
 */
export function buildTunnelSpec(kind: TunnelServiceKind, localPort: number, customCmd?: string): TunnelSpec {
  const common = [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  if (kind === 'serveo') {
    return { cmd: 'ssh', args: [...common, '-R', `0:127.0.0.1:${localPort}`, 'serveo.net'], service: 'serveo.net' };
  }
  if (kind === 'custom') {
    const filled = (customCmd || '').trim().replace(/\{PORT\}/g, String(localPort));
    const toks = filled.split(/\s+/).filter(Boolean);
    return { cmd: toks[0] || 'ssh', args: toks.slice(1), service: 'custom' };
  }
  // pinggy (default) — free public TCP tunnel, no account needed
  return {
    cmd: 'ssh',
    args: ['-p', '443', ...common, '-R', `0:127.0.0.1:${localPort}`, 'a.pinggy.io'],
    service: 'a.pinggy.io',
  };
}
