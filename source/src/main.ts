/**
 * Vault SSH Bridge — Obsidian plugin entry point.
 * Runs a small SSH server inside Obsidian, sandboxed to the vault.
 */

import { Notice, Plugin, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, LogEntry, VaultSSHSettings } from './types';
import { VaultFS } from './vaultfs';
import { HostKeySet, generateHostKeys, hostKeyFingerprint } from './hostkeys';
import { VaultSSHServer } from './ssh-server';
import { VaultSSHSettingTab } from './settings';
import { ConnectionInfoModal, SessionsModal } from './modals';

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
  logEntries: LogEntry[] = [];
  private statusEl: HTMLElement | null = null;

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

    if (this.settings.startWithObsidian) {
      await this.startServer(true);
    }
    this.updateStatusBar();
  }

  onunload(): void {
    void this.server?.stop();
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
    await this.server.stop();
    if (!quiet) new Notice('سرور SSH متوقف شد.');
    this.updateStatusBar();
  }

  async toggleServer(): Promise<void> {
    if (this.server.isRunning()) await this.stopServer();
    else await this.startServer();
  }

  updateStatusBar(): void {
    if (!this.statusEl) return;
    const running = this.server?.isRunning?.() ?? false;
    const n = running ? this.server.sessionCount : 0;
    this.statusEl.textContent = running ? `⬤ SSH:${this.settings.port}${n > 0 ? ` (${n})` : ''}` : '⭘ SSH:off';
    if (running) this.statusEl.addClass('vssh-status-on');
    else this.statusEl.removeClass('vssh-status-on');
  }

  fingerprints(): { ed: string; rsa: string } {
    return {
      ed: hostKeyFingerprint(this.hostKeys.ed25519),
      rsa: hostKeyFingerprint(this.hostKeys.rsa),
    };
  }

  hostDisplay(): string {
    return this.settings.bindAddress === '0.0.0.0' ? '<IP-COMPUTER>' : this.settings.bindAddress;
  }

  connectionCommand(oneShot = false): string {
    const base = `ssh ${this.settings.username}@${this.hostDisplay()} -p ${this.settings.port}`;
    return oneShot ? base + ' "ls"' : base;
  }

  async savePluginData(): Promise<void> {
    await this.saveData({ settings: this.settings, hostKeys: this.hostKeys } as PluginData);
  }
}

export { setIcon };
