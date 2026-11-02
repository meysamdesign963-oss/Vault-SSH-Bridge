/**
 * Vault SSH Bridge — Obsidian plugin entry point.
 * Runs a small SSH server inside Obsidian, sandboxed to the vault.
 */

import { Notice, Plugin, requestUrl, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, LogEntry, VaultSSHSettings } from './types';
import { VaultFS } from './vaultfs';
import { HostKeySet, generateHostKeys, hostKeyFingerprint } from './hostkeys';
import { VaultSSHServer } from './ssh-server';
import { VaultSSHSettingTab } from './settings';
import { ConnectionInfoModal, SessionsModal } from './modals';
import { TunnelManager } from './tunnel';
import { bestLanIPv4 } from './netinfo';

interface PluginData {
  settings: VaultSSHSettings;
  hostKeys: HostKeySet;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function randomPassword(len = 14): string {
  const arr = new Uint32Array(len);
  (globalThis.crypto as Crypto).getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += PASSWORD_ALPHABET[arr[i] % PASSWORD_ALPHABET.length];
  return out;
}

export default class VaultSSHPlugin extends Plugin {
  settings!: VaultSSHSettings;
  hostKeys!: HostKeySet;
  vfs!: VaultFS;
  server!: VaultSSHServer;
  tunnel!: TunnelManager;
  logEntries: LogEntry[] = [];
  private statusEl: HTMLElement | null = null;
  private publicIPCache = { value: '', at: 0 };

  async onload(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (data?.settings ?? {}) as Partial<VaultSSHSettings>);

    let firstRun = false;
    this.hostKeys = data?.hostKeys ?? ({} as HostKeySet);
    if (!this.hostKeys.ed25519 || !this.hostKeys.rsa) {
      this.hostKeys = generateHostKeys();
      firstRun = true;
    }
    if (!this.settings.password) {
      this.settings.password = randomPassword();
      firstRun = true;
    }
    if (firstRun) await this.savePluginData();

    this.vfs = new VaultFS(this.app.vault as unknown as ConstructorParameters<typeof VaultFS>[0], () => this.settings);
    this.server = new VaultSSHServer(
      () => this.settings,
      () => this.hostKeys,
      this.vfs,
      {
        log: (t) => this.pushLog(t),
        notify: (t) => new Notice('Vault SSH: ' + t, 8000),
        onSessionsChanged: () => this.updateStatusBar(),
        onStatusChanged: () => this.updateStatusBar(),
      }
    );
    this.tunnel = new TunnelManager({
      log: (t) => this.pushLog(t),
      notify: (t) => new Notice(t, 10000),
      onStatusChanged: () => this.updateStatusBar(),
    });

    this.addSettingTab(new VaultSSHSettingTab(this.app, this));

    const ribbon = this.addRibbonIcon('terminal-square', 'Vault SSH Bridge — شروع/توقف سرور', () => {
      void this.toggleServer();
    });
    ribbon.addClass('vssh-ribbon');

    this.statusEl = this.addStatusBarItem();
    if (this.statusEl) {
      this.statusEl.addClass('mod-clickable');
      this.statusEl.setAttribute('aria-label', 'Vault SSH Bridge — نشست‌های فعال');
      this.statusEl.addEventListener('click', () => {
        new SessionsModal(this.app, this).open();
      });
    }

    this.addCommand({
      id: 'vssh-toggle',
      name: 'شروع/توقف سرور SSH (Start/Stop SSH server)',
      callback: () => {
        void this.toggleServer();
      },
    });
    this.addCommand({
      id: 'vssh-info',
      name: 'اطلاعات اتصال (Connection info)',
      callback: () => {
        new ConnectionInfoModal(this.app, this).open();
      },
    });
    this.addCommand({
      id: 'vssh-sessions',
      name: 'نشست‌های فعال (Active sessions)',
      callback: () => {
        new SessionsModal(this.app, this).open();
      },
    });
    this.addCommand({
      id: 'vssh-copy-ai-prompt',
      name: 'کپی پرامپت اتصال برای هوش مصنوعی (Copy AI prompt)',
      callback: async () => {
        try {
          await navigator.clipboard.writeText(this.aiPrompt('local'));
          new Notice('پرامپت اتصال کپی شد — به هوش مصنوعی خود بدهید.');
        } catch {
          new ConnectionInfoModal(this.app, this).open();
        }
      },
    });

    if (this.settings.startWithObsidian) {
      await this.startServer(true);
    }
    this.updateStatusBar();
  }

  onunload(): void {
    void this.server?.stop();
    void this.tunnel?.stop();
  }

  private pushLog(text: string): void {
    this.logEntries.push({ time: Date.now(), text });
    if (this.logEntries.length > 200) this.logEntries.splice(0, this.logEntries.length - 200);
    if (this.settings.logToConsole) console.log('[VaultSSH]', text);
  }

  async startServer(quiet = false): Promise<boolean> {
    if (this.server.isRunning()) return true;
    try {
      await this.server.start();
      if (!quiet) {
        new Notice(`SSH سرور فعال شد → ${this.settings.bindAddress}:${this.settings.port}`, 6000);
      }
      if (this.settings.tunnelMode !== 'off') {
        void this.tunnel.start(this.settings.tunnelMode, this.settings.port, this.settings.tunnelCustom);
      }
      this.updateStatusBar();
      return true;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      new Notice('راه‌اندازی سرور SSH ناموفق بود: ' + msg, 10000);
      this.pushLog('start failed: ' + msg);
      return false;
    }
  }

  async stopServer(quiet = false): Promise<void> {
    await this.tunnel.stop();
    await this.server.stop();
    if (!quiet) new Notice('سرور SSH متوقف شد.');
    this.updateStatusBar();
  }

  /** (Re)start or stop the public tunnel according to current settings. */
  async applyTunnel(): Promise<void> {
    if (!this.server.isRunning() || this.settings.tunnelMode === 'off') {
      await this.tunnel.stop();
      return;
    }
    await this.tunnel.start(this.settings.tunnelMode, this.settings.port, this.settings.tunnelCustom);
  }

  /** Fetch the machine's public (internet) IP, cached for 10 minutes. */
  async fetchPublicIP(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.publicIPCache.value && now - this.publicIPCache.at < 10 * 60_000) {
      return this.publicIPCache.value;
    }
    const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
    for (const url of urls) {
      try {
        const res = await requestUrl({ url, method: 'GET', throw: false });
        const raw: unknown = (res as unknown as { text?: unknown })?.text;
        const text = String(typeof raw === 'string' ? raw : raw instanceof Promise ? await raw : '').trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
          this.publicIPCache = { value: text, at: now };
          return text;
        }
      } catch {
        /* try next */
      }
    }
    return this.publicIPCache.value || '';
  }

  async toggleServer(): Promise<void> {
    if (this.server.isRunning()) await this.stopServer();
    else await this.startServer();
  }

  updateStatusBar(): void {
    if (!this.statusEl) return;
    const running = this.server?.isRunning?.() ?? false;
    const n = running ? this.server.sessionCount : 0;
    const tunnelUp = this.tunnel?.isActive?.() ?? false;
    this.statusEl.textContent = running
      ? `⬤ SSH:${this.settings.port}${n > 0 ? ` (${n})` : ''}${tunnelUp ? ' ↗' : ''}`
      : '⭘ SSH:off';
    if (running) this.statusEl.addClass('vssh-status-on');
    else this.statusEl.removeClass('vssh-status-on');
  }

  /** connection scopes for the connection-info modal / AI prompt. */
  endpointFor(scope: 'local' | 'lan' | 'tunnel'): { host: string; port: number; ready: boolean; hint: string } {
    if (scope === 'tunnel') {
      const st = this.tunnel?.state;
      if (st?.status === 'active' && st.host) return { host: st.host, port: st.port, ready: true, hint: '' };
      return {
        host: '',
        port: 0,
        ready: false,
        hint: 'تونل عمومی فعال نیست — از تنظیمات روشنش کنید یا دکمه‌ی «شروع تونل» را بزنید.',
      };
    }
    if (scope === 'lan') {
      const ip = bestLanIPv4();
      if (this.settings.bindAddress !== '0.0.0.0') {
        return {
          host: ip || '<LAN-IP>',
          port: this.settings.port,
          ready: false,
          hint: 'برای اتصال از دستگاه دیگر، «دامنه‌ی اتصال» را در تنظیمات روی «همه‌ی شبکه» بگذارید و سرور را دوباره شروع کنید.',
        };
      }
      return { host: ip || '<LAN-IP>', port: this.settings.port, ready: !!ip, hint: ip ? '' : 'آدرس شبکه‌ی محلی پیدا نشد.' };
    }
    return { host: '127.0.0.1', port: this.settings.port, ready: true, hint: '' };
  }

  fingerprints(): { ed: string; rsa: string } {
    return {
      ed: hostKeyFingerprint(this.hostKeys.ed25519),
      rsa: hostKeyFingerprint(this.hostKeys.rsa),
    };
  }

  hostDisplay(): string {
    if (this.tunnel?.isActive?.() && this.tunnel.state.host) return this.tunnel.state.host;
    if (this.settings.bindAddress === '0.0.0.0') return bestLanIPv4() || '<LAN-IP>';
    return this.settings.bindAddress;
  }

  connectionCommand(oneShot = false): string {
    const base = `ssh ${this.settings.username}@${this.hostDisplay()} -p ${this.settings.port}`;
    return oneShot ? base + ' "ls"' : base;
  }

  /** Ready-to-paste prompt that gives an external AI everything it needs. */
  aiPrompt(scope: 'local' | 'lan' | 'tunnel' = 'local'): string {
    const ep = this.endpointFor(scope);
    const s = this.settings;
    const lines = [
      'می‌خواهم از طریق SSH به خزانه‌ی اوبسیدین من وصل شوی و کاری را انجام دهی.',
      '',
      `فرمان اتصال (تک‌فرمانی): ssh ${s.username}@${ep.host} -p ${ep.port} "<COMMAND>"`,
      `نمونه: ssh ${s.username}@${ep.host} -p ${ep.port} "ls"`,
      '',
      `نام کاربری: ${s.username}`,
      `رمز عبور: ${s.password}`,
      '',
      'قوانین:',
      '۱) ابتدا با دستور rules قوانین سرور را بخوان و با help لیست دستورات مجاز را ببین.',
      '۲) فقط از دستورات خود این سرور استفاده کن:',
      '   ls, cd, pwd, cat, head, tail, write, append, mkdir, rm, mv, cp, find, grep, tree, recent, stat, info',
      '۳) پیش از بازنویسی هر فایل، اول محتوای فعلی‌اش را با cat بخوان.',
      '۴) دسترسی فقط داخل خزانه است؛ دستور سیستم‌عاملی (مثل bash) کار نمی‌کند.',
      '۵) برای ساخت فایل از write و برای افزودن از append استفاده کن؛ در متن‌ها از \\n برای خط جدید استفاده کن.',
    ];
    if (!ep.ready && ep.hint) lines.push('', 'توجه: ' + ep.hint);
    return lines.join('\n');
  }

  async savePluginData(): Promise<void> {
    await this.saveData({ settings: this.settings, hostKeys: this.hostKeys } as PluginData);
  }
}

export { setIcon };
