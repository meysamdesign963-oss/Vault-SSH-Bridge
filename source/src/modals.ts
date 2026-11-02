/**
 * Vault SSH Bridge — modals: connection info (local / LAN / internet) & active sessions.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type VaultSSHPlugin from './main';

function duration(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

type Scope = 'local' | 'lan' | 'tunnel';

export class ConnectionInfoModal extends Modal {
  plugin: VaultSSHPlugin;
  private promptScope: Scope = 'local';

  constructor(app: App, plugin: VaultSSHPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  private copy(text: string, okMsg: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => new Notice(okMsg))
      .catch(() => new Notice('کپی ممکن نشد — به‌صورت دستی انتخاب و کپی کنید.'));
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const p = this.plugin.settings;

    contentEl.createEl('h3', { text: 'اطلاعات اتصال SSH' });
    contentEl.createEl('p', {
      text: 'این اطلاعات را به کلاینت SSH یا دستیار هوش مصنوعی بدهید. بسته به اینکه هوش مصنوعی کجاست، یکی از سه حالت زیر را استفاده کنید.',
      cls: 'setting-item-description',
    });

    /* ---------- credentials ---------- */
    const row = (name: string, value: string, mono = true, desc = ''): HTMLElement => {
      const s = new Setting(contentEl).setName(name);
      if (desc) s.setDesc(desc);
      const val = s.addText((t) => {
        t.setValue(value);
        t.inputEl.readOnly = true;
        if (mono) t.inputEl.addClass('vssh-mono');
      });
      return val.settingEl;
    };
    const cmdRow = (name: string, value: string, desc = ''): void => {
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.setValue(value);
          t.inputEl.readOnly = true;
          t.inputEl.addClass('vssh-mono');
        })
        .addButton((b) =>
          b.setButtonText('کپی').onClick(() => this.copy(value, 'فرمان کپی شد.'))
        );
    };

    row('نام کاربری', p.username, false);
    row('رمز عبور', p.password);
    row('پورت', String(p.port), false);

    /* ---------- 1) local ---------- */
    contentEl.createEl('h4', { text: '۱) هوش مصنوعی روی همین کامپیوتر (localhost)' });
    cmdRow('فرمان اتصال تعاملی', `ssh ${p.username}@127.0.0.1 -p ${p.port}`);
    cmdRow('فرمان تک‌خطی (برای ابزارهای AI)', `ssh ${p.username}@127.0.0.1 -p ${p.port} "ls"`);

    /* ---------- 2) LAN ---------- */
    contentEl.createEl('h4', { text: '۲) دستگاه دیگر در شبکه‌ی محلی (وای‌فای / کابل)' });
    const lanEp = this.plugin.endpointFor('lan');
    cmdRow(
      'فرمان اتصال با آی‌پی شبکه',
      `ssh ${p.username}@${lanEp.host} -p ${lanEp.port}`,
      lanEp.ready
        ? 'دامنه‌ی اتصال روی «همه‌ی شبکه» تنظیم شده است.'
        : lanEp.hint
    );

    /* ---------- 3) internet / tunnel ---------- */
    contentEl.createEl('h4', { text: '۳) از اینترنت — هوش مصنوعی بیرون از شبکه (تونل عمومی)' });
    const tunnelSetting = new Setting(contentEl).setName('وضعیت تونل عمومی');
    this.fillTunnelStatus(tunnelSetting);

    new Setting(contentEl)
      .setName('تونل عمومی')
      .setDesc('با کلاینت OpenSSH سیستم، یک نشانی عمومی موقت می‌سازد — بدون تنظیم مودم. سرویس رایگان pinggy.io توصیه می‌شود.')
      .addDropdown((d) =>
        d
          .addOption('off', 'خاموش')
          .addOption('pinggy', 'pinggy.io (رایگان — پیشنهادی)')
          .addOption('serveo', 'serveo.net')
          .addOption('custom', 'دستور سفارشی')
          .setValue(p.tunnelMode)
          .onChange(async (v) => {
            this.plugin.settings.tunnelMode = v as typeof p.tunnelMode;
            await this.plugin.savePluginData();
            await this.plugin.applyTunnel();
            this.render();
          })
      );

    if (p.tunnelMode === 'custom') {
      new Setting(contentEl)
        .setName('دستور سفارشی تونل')
        .setDesc('مثال: ssh -R 0:127.0.0.1:{PORT} user@your-server.com — {PORT} با پورت سرور جایگزین می‌شود.')
        .addText((t) =>
          t.setValue(p.tunnelCustom).onChange(async (v) => {
            this.plugin.settings.tunnelCustom = v;
            await this.plugin.savePluginData();
          })
        );
    }

    const st = this.plugin.tunnel?.state;
    if (st?.status === 'active' && st.host) {
      cmdRow('نشانی عمومی فعال', `ssh ${p.username}@${st.host} -p ${st.port}`, 'این فرمان از هر جای اینترنت قابل استفاده است.');
    }

    /* ---------- public IP ---------- */
    const pubSetting = new Setting(contentEl)
      .setName('آی‌پی عمومی اینترنت شما')
      .setDesc('برای اتصال مستقیم (بدون تونل) باید در مودم، پورت TCP ' + p.port + ' را به این کامپیوتر فوروارد کنید.');
    pubSetting.addText((t) => {
      t.setValue('در حال دریافت…');
      t.inputEl.readOnly = true;
      t.inputEl.addClass('vssh-mono');
      void this.plugin.fetchPublicIP().then((ip) => t.setValue(ip || 'دریافت نشد'));
    });
    pubSetting.addButton((b) =>
      b.setButtonText('بروزرسانی').onClick(() => {
        void this.plugin.fetchPublicIP(true);
        this.render();
      })
    );

    /* ---------- ready AI prompt ---------- */
    contentEl.createEl('h4', { text: 'پرامپت آماده برای هوش مصنوعی' });
    let promptArea: HTMLTextAreaElement | null = null;
    new Setting(contentEl)
      .setName('مقصد هوش مصنوعی')
      .setDesc('پرامپت زیر به‌صورت خودکار با همین اطلاعات (آدرس، رمز و قوانین) ساخته می‌شود.')
      .addDropdown((d) =>
        d
          .addOption('local', 'همین کامپیوتر (127.0.0.1)')
          .addOption('lan', 'شبکه‌ی محلی (آی‌پی LAN)')
          .addOption('tunnel', 'اینترنت (تونل عمومی)')
          .setValue(this.promptScope)
          .onChange((v) => {
            this.promptScope = v as Scope;
            if (promptArea) promptArea.value = this.plugin.aiPrompt(this.promptScope);
          })
      )
      .addButton((b) =>
        b.setButtonText('کپی پرامپت').setCta().onClick(() => this.copy(this.plugin.aiPrompt(this.promptScope), 'پرامپت کپی شد — به هوش مصنوعی خود بدهید.'))
      );
    promptArea = contentEl.createEl('textarea', { cls: 'vssh-wide vssh-mono' });
    promptArea.rows = 10;
    promptArea.readOnly = true;
    promptArea.value = this.plugin.aiPrompt(this.promptScope);

    /* ---------- fingerprints & notes ---------- */
    contentEl.createEl('h4', { text: 'امنیت' });
    const fp = this.plugin.fingerprints();
    row('اثر انگشت کلید میزبان (Ed25519)', fp.ed);
    row('اثر انگشت کلید میزبان (RSA)', fp.rsa);
    contentEl.createEl('p', {
      text: 'تغییر رمز یا نام کاربری بلافاصله اعمال می‌شود. پس از تلاش‌های ناموفق مکرر، IP متخلف مسدود می‌شود (تنظیمات: محافظت شکست رمز). بعد از پایان کار، تونل را خاموش کنید.',
      cls: 'setting-item-description',
    });
  }

  private fillTunnelStatus(setting: Setting): void {
    const st = this.plugin.tunnel?.state;
    let text = 'خاموش';
    if (st?.status === 'active') text = `فعال ✅ ${st.endpoint}`;
    else if (st?.status === 'starting') text = 'در حال اتصال به سرویس تونل…';
    else if (st?.status === 'error') text = 'خطا: ' + st.error;
    setting.setDesc(text);
    setting.addButton((b) =>
      b
        .setButtonText(st?.status === 'off' || st?.status === 'error' ? 'شروع تونل' : 'توقف تونل')
        .onClick(async () => {
          if (this.plugin.settings.tunnelMode === 'off') {
            new Notice('اول «تونل عمومی» را در همین پنجره انتخاب کنید (مثلاً pinggy.io).');
            return;
          }
          if (st && (st.status === 'starting' || st.status === 'active')) {
            await this.plugin.tunnel.stop();
          } else {
            if (!this.plugin.server.isRunning()) await this.plugin.startServer();
            await this.plugin.tunnel.start(
              this.plugin.settings.tunnelMode,
              this.plugin.settings.port,
              this.plugin.settings.tunnelCustom
            );
          }
          this.render();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SessionsModal extends Modal {
  plugin: VaultSSHPlugin;

  constructor(app: App, plugin: VaultSSHPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'نشست‌های فعال SSH' });

    const sessions = this.plugin.server.listSessions();
    if (sessions.length === 0) {
      contentEl.createEl('p', { text: 'در حال حاضر نشست فعالی وجود ندارد.' });
    } else {
      for (const s of sessions) {
        new Setting(contentEl)
          .setName(`#${s.id} — ${s.kind === 'pty' ? 'تعاملی' : 'تک‌فرمانی'} — ${s.user}@${s.ip}`)
          .setDesc(`شروع: ${new Date(s.since).toLocaleTimeString()} (${duration(s.since)})`)
          .addButton((b) =>
            b.setButtonText('قطع اتصال').setWarning().onClick(() => {
              this.plugin.server.disconnectSession(s.id);
              this.render();
            })
          );
      }
      new Setting(contentEl).addButton((b) =>
        b.setButtonText('قطع همه').setWarning().onClick(() => {
          this.plugin.server.disconnectAll();
          this.render();
        })
      );
    }

    const bans = this.plugin.server.listBans();
    if (bans.length > 0) {
      contentEl.createEl('h4', { text: 'IPهای مسدودشده (محافظت شکست رمز)' });
      for (const ban of bans) {
        new Setting(contentEl)
          .setName(ban.ip)
          .setDesc(`${Math.ceil(ban.remainingMs / 1000)} ثانیه مانده`)
          .addButton((b) =>
            b.setButtonText('رفع مسدودی').onClick(() => {
              this.plugin.server.clearBans();
              this.render();
            })
          );
      }
      new Setting(contentEl).addButton((b) =>
        b.setButtonText('رفع همه‌ی مسدودی‌ها').setWarning().onClick(() => {
          this.plugin.server.clearBans();
          this.render();
        })
      );
    }

    contentEl.createEl('h4', { text: 'وقایع اخیر' });
    const logBox = contentEl.createDiv('vssh-log');
    const pre = logBox.createEl('pre');
    pre.setText(
      this.plugin.logEntries
        .slice(-30)
        .map((e) => `${new Date(e.time).toLocaleTimeString()}  ${e.text}`)
        .join('\n') || '—'
    );

    new Setting(contentEl).addButton((b) => b.setButtonText('بروزرسانی').onClick(() => this.render()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
