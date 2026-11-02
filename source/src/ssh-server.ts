/**
 * Vault SSH Bridge — embedded SSH server (ssh2) bound to the sandboxed vault shell.
 */

import * as crypto from 'crypto';
import { Connection, Server } from 'ssh2';
import { VaultSSHSettings } from './types';
import { VaultFS } from './vaultfs';
import { ShellSession } from './shell';
import { HostKeySet } from './hostkeys';

export interface SessionInfo {
  id: number;
  kind: 'pty' | 'exec';
  user: string;
  ip: string;
  since: number;
}

export interface ServerHooks {
  log(text: string): void;
  notify(text: string): void;
  onSessionsChanged(): void;
  onStatusChanged(): void;
}

interface InternalSession extends SessionInfo {
  conn: Connection;
  cleanup: () => void;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(Buffer.from(String(a ?? ''), 'utf8')).digest();
  const hb = crypto.createHash('sha256').update(Buffer.from(String(b ?? ''), 'utf8')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class VaultSSHServer {
  private server: Server | null = null;
  private sessions = new Map<number, InternalSession>();
  private nextId = 1;
  /** failed-login tracking per IP (10 min sliding window). */
  private failCounts = new Map<string, { count: number; first: number }>();
  /** banned IPs (value = ban expiry epoch ms). */
  private banUntil = new Map<string, number>();
  private nextSweep = 0;

  constructor(
    private getSettings: () => VaultSSHSettings,
    private getKeys: () => HostKeySet,
    private vfs: VaultFS,
    private hooks: ServerHooks
  ) {}

  isRunning(): boolean {
    return !!this.server;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map(({ id, kind, user, ip, since }) => ({ id, kind, user, ip, since }));
  }

  async start(): Promise<void> {
    if (this.server) return;
    const s = this.getSettings();
    const keys = this.getKeys();
    const hostKeys = [keys.ed25519, keys.rsa].filter((k) => !!k);
    if (hostKeys.length === 0) throw new Error('no host keys available');

    const srv = new Server(
      {
        hostKeys,
        banner:
          'Obsidian Vault SSH Bridge — vault-only access. Unauthorized use is prohibited. | دسترسی غیرمجاز ممنوع است.',
      },
      (client) => this.onClient(client)
    );
    this.server = srv;
    srv.on('error', (err: Error) => {
      this.hooks.log('server error: ' + err.message);
      this.hooks.notify('SSH server error: ' + err.message);
    });

    const port = s.port;
    const bind = s.bindAddress || '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        this.server = null;
        reject(err);
      };
      srv.once('error', onErr);
      srv.listen(port, bind, () => {
        srv.removeListener('error', onErr);
        resolve();
      });
    });
    this.hooks.log(`listening on ${bind}:${port}`);
    this.hooks.onStatusChanged();
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    for (const sess of [...this.sessions.values()]) {
      try {
        sess.conn.end();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    this.hooks.onSessionsChanged();
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        srv.close(fin);
      } catch {
        fin();
      }
      const t = setTimeout(fin, 1500);
      (t as unknown as { unref?: () => void })?.unref?.();
    });
    this.hooks.log('server stopped');
    this.hooks.onStatusChanged();
  }

  disconnectSession(id: number): boolean {
    const sess = this.sessions.get(id);
    if (!sess) return false;
    try {
      sess.conn.end();
    } catch {
      /* ignore */
    }
    sess.cleanup();
    return true;
  }

  disconnectAll(): number {
    const n = this.sessions.size;
    for (const sess of [...this.sessions.values()]) {
      try {
        sess.conn.end();
      } catch {
        /* ignore */
      }
      sess.cleanup();
    }
    return n;
  }

  /** Number of currently banned IPs (for the status UI). */
  get banCount(): number {
    return this.banUntil.size;
  }

  /* ---------------- brute-force guard ---------------- */

  private sweepGuards(now: number): void {
    if (now < this.nextSweep) return;
    this.nextSweep = now + 30_000;
    for (const [ip, until] of this.banUntil) {
      if (until <= now) this.banUntil.delete(ip);
    }
    for (const [ip, rec] of this.failCounts) {
      if (now - rec.first > 10 * 60_000) this.failCounts.delete(ip);
    }
  }

  private banRemainingMs(ip: string): number {
    const until = this.banUntil.get(ip) ?? 0;
    return until > Date.now() ? until - Date.now() : 0;
  }

  private noteAuthFail(ip: string): void {
    const s = this.getSettings();
    if (!s.bruteforceProtect) return;
    const now = Date.now();
    this.sweepGuards(now);
    const rec = this.failCounts.get(ip) ?? { count: 0, first: now };
    if (now - rec.first > 10 * 60_000) {
      rec.count = 0;
      rec.first = now;
    }
    rec.count++;
    this.failCounts.set(ip, rec);
    const threshold = Math.max(2, s.maxAuthFails);
    if (rec.count >= threshold) {
      const mins = Math.max(1, s.banMinutes);
      this.banUntil.set(ip, now + mins * 60_000);
      this.failCounts.delete(ip);
      this.hooks.log(`brute-force guard: ${ip} banned for ${mins} min (${rec.count} failed logins)`);
      this.hooks.notify(`IP ${ip} به مدت ${mins} دقیقه مسدود شد (${rec.count} تلاش ناموفق ورود).`);
    }
  }

  /** IPs currently banned (ip -> remaining ms) for display. */
  listBans(): { ip: string; remainingMs: number }[] {
    const now = Date.now();
    this.sweepGuards(now);
    return [...this.banUntil.entries()]
      .filter(([, until]) => until > now)
      .map(([ip, until]) => ({ ip, remainingMs: until - now }))
      .sort((a, b) => b.remainingMs - a.remainingMs);
  }

  clearBans(): number {
    const n = this.banUntil.size;
    this.banUntil.clear();
    this.failCounts.clear();
    if (n > 0) this.hooks.log(`all bans cleared (${n})`);
    return n;
  }

  /* ---------------- internals ---------------- */

  private register(kind: 'pty' | 'exec', ip: string, conn: Connection): InternalSession {
    const id = this.nextId++;
    const hooks = this.hooks;
    const sess: InternalSession = {
      id,
      kind,
      user: this.getSettings().username,
      ip,
      since: Date.now(),
      conn,
      cleanup: () => {
        if (this.sessions.has(id)) {
          this.sessions.delete(id);
          hooks.onSessionsChanged();
          hooks.log(`session #${id} (${kind}) closed`);
        }
      },
    };
    this.sessions.set(id, sess);
    this.hooks.onSessionsChanged();
    return sess;
  }

  private onClient(client: Connection): void {
    const ip = ((client as unknown as { _sock?: { remoteAddress?: string } })._sock?.remoteAddress as string) || 'unknown';
    let attempts = 0;
    this.sweepGuards(Date.now());
    const bannedFor = this.banRemainingMs(ip);
    if (bannedFor > 0) {
      this.hooks.log(`connection from banned ${ip} — dropped (${Math.ceil(bannedFor / 1000)}s left)`);
      try {
        client.end();
      } catch {
        /* ignore */
      }
      return;
    }
    this.hooks.log(`connection from ${ip}`);

    client.on('authentication', (ctx: any) => {
      const s = this.getSettings();
      // ssh2 >= 1.17 exposes ctx.method; older versions used ctx.type.
      const authMethod = String(ctx.method ?? ctx.type ?? '');
      const check = (pass: string) => {
        const okUser = typeof ctx.username === 'string' && ctx.username === s.username;
        return okUser && timingSafeEqualStr(pass, s.password);
      };
      if (authMethod === 'password') {
        if (check(String(ctx.password ?? ''))) {
          this.failCounts.delete(ip);
          this.hooks.log(`auth ok: ${ctx.username}@${ip}`);
          ctx.accept();
        } else {
          this.failAuth(ctx, client, ip, attempts++);
        }
      } else if (authMethod === 'keyboard-interactive') {
        const onFinish = (answers: any) => {
          const first = Array.isArray(answers) ? answers?.[0] : undefined;
          const pass = typeof first === 'object' && first !== null ? String(first.response ?? '') : String(first ?? '');
          if (check(pass)) {
            this.failCounts.delete(ip);
            this.hooks.log(`auth ok (keyboard-interactive): ${ctx.username}@${ip}`);
            ctx.accept();
          } else {
            this.failAuth(ctx, client, ip, attempts++);
          }
        };
        try {
          // ssh2 >= 1.17: prompt(prompts, title, instructions, cb)
          ctx.prompt(['Password: '], '', '', onFinish);
        } catch {
          // older ssh2: prompt(name, instructions, lang, prompts, finishCb)
          try {
            ctx.prompt('Password: ', '', 'en', ['Password: '], onFinish);
          } catch {
            try {
              ctx.reject(['password']);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        try {
          ctx.reject(['password', 'keyboard-interactive']);
        } catch {
          /* ignore */
        }
      }
    });

    client.on('ready', () => {
      this.hooks.log(`handshake complete: ${ip}`);
      client.on('session', (accept: () => any) => {
        let session: any;
        try {
          session = accept();
        } catch {
          return;
        }
        session.on('pty', (acc: any) => {
          try {
            acc();
          } catch {
            /* ignore */
          }
        });
        session.on('shell', (acc: any, rej: any) => this.handleShell(client, ip, acc, rej));
        session.on('exec', (acc: any, rej: any, info: any) =>
          this.handleExec(client, ip, acc, rej, String(info?.command ?? ''))
        );
        session.on('error', () => {
          /* ignore */
        });
        session.on('close', () => {
          /* ignore */
        });
      });
    });

    client.on('error', (err: Error) => {
      this.hooks.log(`connection error (${ip}): ${err.message}`);
    });
  }

  private failAuth(ctx: any, client: Connection, ip: string, attempt: number): void {
    const n = attempt + 1;
    this.hooks.log(`auth failed (${n}): ${ctx.username ?? '?'}@${ip}`);
    this.noteAuthFail(ip);
    try {
      ctx.reject(['password']);
    } catch {
      try {
        ctx.reject();
      } catch {
        /* ignore */
      }
    }
    if (n >= 3) {
      this.hooks.log(`too many failed attempts from ${ip} — disconnecting`);
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
  }

  private handleShell(client: Connection, ip: string, accept: () => any, reject: () => any): void {
    const s = this.getSettings();
    const limit = Math.max(1, s.maxSessions);
    if (this.sessions.size >= limit) {
      this.hooks.log(`shell refused (session limit ${limit}): ${ip}`);
      try {
        const stream = accept();
        stream.write(
          `\r\nsession limit reached (${limit}) — حداکثر تعداد نشست‌های همزمان پر است. اتصال بسته می‌شود.\r\n`
        );
        const t = setTimeout(() => {
          try {
            stream.end();
          } catch {
            /* ignore */
          }
          try {
            client.end();
          } catch {
            /* ignore */
          }
        }, 400);
        (t as unknown as { unref?: () => void })?.unref?.();
      } catch {
        try {
          reject();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    let stream: any;
    try {
      stream = accept();
    } catch {
      return;
    }
    const sess = this.register('pty', ip, client);
    const io = {
      write: (t: string) => {
        try {
          if (stream.writable) stream.write(t.replace(/\r?\n/g, '\r\n'));
        } catch {
          /* ignore */
        }
      },
      close: () => {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
        try {
          client.end();
        } catch {
          /* ignore */
        }
      },
    };
    const shell = new ShellSession(this.vfs, () => this.getSettings(), io, { user: sess.user, ip, kind: 'pty' }, {
      log: (t) => this.hooks.log(t),
    });
    shell.startInteractive();
    stream.on('data', (buf: Buffer) => shell.handleData(buf));
    const fin = () => sess.cleanup();
    stream.on('close', fin);
    stream.on('end', fin);
    client.on('close', fin);
  }

  private handleExec(client: Connection, ip: string, accept: () => any, reject: () => any, command: string): void {
    const s = this.getSettings();
    const limit = Math.max(1, s.maxSessions);

    const refuse = (msg: string, code: number) => {
      this.hooks.log(`exec refused: ${ip} — ${msg}`);
      try {
        const stream = accept();
        stream.write(msg + '\n');
        try {
          stream.exit(code);
        } catch {
          /* ignore */
        }
        stream.end();
      } catch {
        try {
          reject();
        } catch {
          /* ignore */
        }
      }
    };

    if (!s.allowExec) {
      refuse('exec mode is disabled by the vault owner.', 111);
      return;
    }
    if (this.sessions.size >= limit) {
      refuse(`session limit reached (${limit}). try again later.`, 111);
      return;
    }

    let stream: any;
    try {
      stream = accept();
    } catch {
      return;
    }
    const sess = this.register('exec', ip, client);
    this.hooks.log(`exec #${sess.id}: ${command.slice(0, 160)}`);

    let finished = false;
    const fin = () => {
      if (!finished) {
        finished = true;
        sess.cleanup();
      }
    };

    const cap = 64 * 1024;
    let written = 0;
    let truncated = false;
    const writeOut = (t: string) => {
      if (truncated) return;
      try {
        if (!stream.writable) return;
      } catch {
        return;
      }
      written += Buffer.byteLength(t);
      if (written > cap) {
        truncated = true;
        try {
          stream.write('\n(output truncated at 64 KB)\n');
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        stream.write(t);
      } catch {
        /* ignore */
      }
    };

    const shell = new ShellSession(this.vfs, () => this.getSettings(), {
      write: () => undefined,
      close: () => undefined,
    }, { user: sess.user, ip, kind: 'exec' }, {});

    const timer: any = setTimeout(() => {
      try {
        stream.write('\n(command timed out after 30s)\n');
      } catch {
        /* ignore */
      }
      try {
        stream.exit(124);
      } catch {
        /* ignore */
      }
      try {
        stream.end();
      } catch {
        /* ignore */
      }
      fin();
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }, 30000);
    (timer as unknown as { unref?: () => void })?.unref?.();

    shell
      .runForExec(command, writeOut)
      .then((code) => {
        clearTimeout(timer);
        fin(); // free the session slot immediately — stream close event is handled idempotently
        try {
          stream.exit(code);
        } catch {
          /* ignore */
        }
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      })
      .catch((e) => {
        clearTimeout(timer);
        fin();
        try {
          stream.write('internal error: ' + (e?.message ?? String(e)) + '\n');
        } catch {
          /* ignore */
        }
        try {
          stream.exit(1);
        } catch {
          /* ignore */
        }
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      });

    stream.on('close', fin);
    client.on('close', fin);
  }
}
