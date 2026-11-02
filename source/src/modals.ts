/**
 * Vault SSH Bridge — modals: connection info & active sessions.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type VaultSSHPlugin from './main';

function duration(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

export class ConnectionInfoModal extends Modal {
  plugin: VaultSSHPlugin;

  constructor(app: App, plugin: VaultSSHPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'اطلاعات اتصال SSH' });
    contentEl.createEl('p', {
      text: 'این اطلاعات را به کلاینت SSH یا دستیار هوش مصنوعی بدهید. اگر «دامنه‌ی اتصال» روی localhost است، فقط از همین کامپیوتر می‌توان وصل شد.',
      cls: 'setting-item-description',
    });

    const p = this.plugin.settings;
    const host = this.plugin.hostDisplay();
    const interactiveCmd = `ssh ${p.username}@${host} -p ${p.port}`;
    const oneShotCmd = `ssh ${p.username}@${host} -p ${p.port} "ls"`;

    const row = (name: string, value: string, mono = true): HTMLElement => {
      const s = new Setting(contentEl).setName(name);
      const val = s.addText((t) => {
        t.setValue(value);
        t.inputEl.readOnly = true;
        if (mono) t.inputEl.addClass('vssh-mono');
      });
      return val.settingEl;
    };

    row('نام کاربری', p.username, false);
    row('رمز عبور', p.password);
    row('پورت', String(p.port), false);
    row('فرمان اتصال تعاملی', interactiveCmd);
    row('فرمان تک‌خطی (برای هوش مصنوعی)', oneShotCmd);

    const fp = this.plugin.fingerprints();
    row('اثر انگشت کلید میزبان (Ed25519)', fp.ed);
    row('اثر انگشت کلید میزبان (RSA)', fp.rsa);

    new Setting(contentEl)
      .setName('کپی کامل اطلاعات')
      .setDesc('همه‌ی اطلاعات اتصال به‌صورت یک متن آماده برای ارسال به هوش مصنوعی.')
      .addButton((b) =>
        b.setButtonText('کپی').onClick(async () => {
          const text = [
            'اتصال SSH به خزانه اوبسیدین من:',
            `فرمان: ${interactiveCmd}`,
            `نام کاربری: ${p.username}`,
            `رمز عبور: ${p.password}`,
            'پس از اتصال، دستور rules را بخوان و برای دیدن دستورات help را اجرا کن. دسترسی فقط داخل خزانه است.',
          ].join('\n');
          try {
            await navigator.clipboard.writeText(text);
            new Notice('اطلاعات اتصال کپی شد.');
          } catch {
            new Notice('کپی ممکن نشد.');
          }
        })
      );

    contentEl.createEl('p', {
      text: 'نکته: تغییر رمز یا نام کاربری بلافاصله اعمال می‌شود؛ کلاینت‌های متصل باید دوباره وصل شوند.',
      cls: 'setting-item-description',
    });
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

    contentEl.createEl('h4', { text: 'وقایع اخیر' });
    const logBox = contentEl.createDiv('vssh-log');
    const pre = logBox.createEl('pre');
    pre.setText(
      this.plugin.logEntries
        .slice(-30)
        .map((e) => `${new Date(e.time).toLocaleTimeString()}  ${e.text}`)
        .join('\n') || '—'
    );

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('بروزرسانی').onClick(() => this.render())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
