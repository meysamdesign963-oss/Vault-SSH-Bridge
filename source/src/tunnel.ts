/**
 * Vault SSH Bridge — public tunnel manager.
 *
 * Opens a reverse tunnel with the system `ssh` client to a free public
 * tunnel service (pinggy.io / serveo.net / a custom server) so an external
 * AI assistant can reach the local SSH server over the internet WITHOUT
 * any router (port-forwarding) configuration.
 *
 * The tunnel process is a plain child process — it only forwards TCP to
 * the local SSH port and never touches the vault sandbox.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { buildTunnelSpec, parseTunnelEndpoint, TunnelServiceKind } from './netinfo';

export type TunnelMode = 'off' | 'pinggy' | 'serveo' | 'custom';
export type TunnelStatus = 'off' | 'starting' | 'active' | 'error';

export interface TunnelState {
  status: TunnelStatus;
  mode: TunnelMode;
  endpoint: string; // "host:port" the AI connects to
  host: string;
  port: number;
  error: string;
  since: number;
}

export interface TunnelHooks {
  log(text: string): void;
  notify(text: string): void;
  onStatusChanged(): void;
}

const MAXBUF = 16 * 1024;

function emptyState(): TunnelState {
  return { status: 'off', mode: 'off', endpoint: '', host: '', port: 0, error: '', since: 0 };
}

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private out = '';
  private stoppedByUs = false;
  state: TunnelState = emptyState();

  constructor(private hooks: TunnelHooks) {}

  isRunning(): boolean {
    return this.state.status === 'starting' || this.state.status === 'active';
  }

  isActive(): boolean {
    return this.state.status === 'active' && !!this.state.host;
  }

  async start(mode: TunnelMode, localPort: number, customCmd: string): Promise<void> {
    await this.stop();
    if (mode === 'off') return;
    this.stoppedByUs = false;
    const spec = buildTunnelSpec(
      (mode === 'serveo' ? 'serveo' : mode === 'custom' ? 'custom' : 'pinggy') as TunnelServiceKind,
      localPort,
      customCmd
    );
    this.out = '';
    this.state = { status: 'starting', mode, endpoint: '', host: '', port: 0, error: '', since: Date.now() };
    this.hooks.onStatusChanged();

    let proc: ChildProcess;
    try {
      proc = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.state = { ...this.state, status: 'error', error: 'ssh client could not be started: ' + (e as Error).message };
      this.hooks.log('tunnel spawn failed: ' + (e as Error).message);
      this.hooks.onStatusChanged();
      return;
    }
    this.proc = proc;
    this.hooks.log(`tunnel starting via ${spec.service} -> 127.0.0.1:${localPort}`);

    const onData = (d: Buffer) => {
      if (this.out.length < MAXBUF) this.out += d.toString('utf8');
      if (this.state.status === 'starting') {
        const ep = parseTunnelEndpoint(this.out, localPort);
        if (ep) {
          this.state = {
            ...this.state,
            status: 'active',
            host: ep.host,
            port: ep.port,
            endpoint: `${ep.host}:${ep.port}`,
          };
          this.hooks.log(`tunnel active: ${ep.host}:${ep.port} -> 127.0.0.1:${localPort}`);
          this.hooks.notify(`تونل عمومی فعال شد: ${ep.host}:${ep.port}`);
          this.hooks.onStatusChanged();
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err: Error) => {
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.state = {
        ...this.state,
        status: 'error',
        error: enoent ? 'کلاینت ssh در سیستم پیدا نشد (OpenSSH Client).' : err.message,
      };
      this.hooks.log('tunnel error: ' + err.message);
      this.hooks.notify(
        enoent
          ? 'Vault SSH: برای تونل عمومی، کلاینت OpenSSH باید نصب باشد (ویندوز ۱۰+ به‌صورت پیش‌فرض دارد).'
          : 'Vault SSH: خطای تونل — ' + err.message
      );
      this.hooks.onStatusChanged();
    });

    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stoppedByUs) return;
      const ep = parseTunnelEndpoint(this.out, localPort);
      if (ep) {
        // endpoint was known — report as active-then-dropped
        this.state = { ...this.state, status: 'error', error: `تونل قطع شد (${ep.host}:${ep.port}) — دوباره شروع کنید.` };
      } else {
        const tail = this.out
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(-3)
          .join(' | ');
        this.state = { ...this.state, status: 'error', error: `تونل بسته شد (کد ${code}). ${tail.slice(0, 220)}` };
      }
      this.hooks.log(`tunnel exited (code ${code})`);
      this.hooks.notify('Vault SSH: تونل عمومی قطع شد.');
      this.hooks.onStatusChanged();
    });
  }

  async stop(): Promise<void> {
    this.stoppedByUs = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      (t as unknown as { unref?: () => void }).unref?.();
    }
    if (this.state.status !== 'off') {
      this.state = emptyState();
      this.hooks.onStatusChanged();
    }
  }
}
