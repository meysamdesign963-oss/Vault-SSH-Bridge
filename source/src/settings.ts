/**
 * Vault SSH Bridge — Persian settings tab.
 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultSSHPlugin from './main';
import { randomPassword } from './main';
import { ConnectionInfoModal, SessionsModal } from './modals';

export class VaultSSHSettingTab extends PluginSettingTab {
  plugin: VaultSSHPlugin;

  constructor(app: App, plugin: VaultSSHPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Vault SSH Bridge — سرور SSH داخل اوبسیدین' });
    containerEl.createEl('p', {
      text: 'با این پلاگین، هوش مصنوعی یا خودتان از طریق SSH به خزانه (Vault) متصل می‌شوید. دسترسی فقط به فایل‌های داخل خزانه محدود است.',
      cls: 'setting-item-description',
    });

    this.renderStatus(containerEl.createDiv('vssh-status-box'));

    /* ---------- server ---------- */
    containerEl.createEl('h3', { text: 'سرور' });

    new Setting(containerEl)
      .setName('شروع خودکار با اوبسیدین')
      .setDesc('هنگام باز شدن اوبسیدین، سرور SSH به‌صورت خودکار اجرا شود.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.startWithObsidian).onChange(async (v) => {
          this.plugin.settings.startWithObsidian = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName('پورت')
      .setDesc('پورت TCP سرور SSH (پیش‌فرض: 2222). پس از تغییر، سرور را ری‌استارت کنید.')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(this.plugin.settings.port));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 1 && n <= 65535) {
            this.plugin.settings.port = n;
            await this.plugin.savePluginData();
            if (this.plugin.server?.isRunning()) {
              new Notice('برای اعمال پورت جدید، سرور را توقف و دوباره شروع کنید.');
            }
          }
        });
      });

    new Setting(containerEl)
      .setName('دامنه‌ی اتصال')
      .setDesc('«فقط همین کامپیوتر» امن‌ترین حالت است. «همه‌ی شبکه» فقط اگر دستگاه دیگری (مثلاً گوشی یا سرور هوش مصنوعی) قرار است وصل شود و رمز قوی گذاشته‌اید.')
      .addDropdown((d) =>
        d
          .addOption('127.0.0.1', 'فقط همین کامپیوتر (localhost) — پیشنهادی')
          .addOption('0.0.0.0', 'همه‌ی شبکه (کمتر امن)')
          .setValue(this.plugin.settings.bindAddress === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')
          .onChange(async (v) => {
            this.plugin.settings.bindAddress = v;
            await this.plugin.savePluginData();
            if (this.plugin.server?.isRunning()) {
              new Notice('برای اعمال تغییر، سرور را توقف و دوباره شروع کنید.');
            }
          })
      );

    /* ---------- auth ---------- */
    containerEl.createEl('h3', { text: 'احراز هویت' });

    new Setting(containerEl)
      .setName('نام کاربری')
      .setDesc('نام کاربری برای ورود کلاینت‌ها و هوش مصنوعی (مثلاً ai).')
      .addText((t) =>
        t.setValue(this.plugin.settings.username).onChange(async (v) => {
          const u = v.trim();
          if (u) {
            this.plugin.settings.username = u;
            await this.plugin.savePluginData();
          }
        })
      );

    const passSetting = new Setting(containerEl)
      .setName('رمز عبور')
      .setDesc('رمز ورود SSH. آن را فقط به ابزارهای مورد اعتماد بدهید. (به‌صورت متن ساده در data.json پلاگین ذخیره می‌شود)')
      .addText((t) => {
        t.inputEl.type = 'text';
        t.setValue(this.plugin.settings.password);
        t.onChange(async (v) => {
          this.plugin.settings.password = v;
          await this.plugin.savePluginData();
        });
      });
    passSetting.addButton((b) =>
      b.setButtonText('رمز جدید').setTooltip('تولید رمز تصادفی امن').onClick(async () => {
        this.plugin.settings.password = randomPassword();
        await this.plugin.savePluginData();
        new Notice('رمز جدید ساخته شد.');
        this.display();
      })
    );
    passSetting.addButton((b) =>
      b.setButtonText('کپی').onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.plugin.settings.password);
          new Notice('رمز عبور کپی شد.');
        } catch {
          new Notice('کپی ممکن نشد — به‌صورت دستی انتخاب و کپی کنید.');
        }
      })
    );

    /* ---------- rules ---------- */
    containerEl.createEl('h3', { text: 'قوانین سرور' });

    new Setting(containerEl)
      .setName('متن قوانین')
      .setDesc('این متن بلافاصله بعد از اتصال و با اجرای دستور rules نمایش داده می‌شود. برای هوش مصنوعی، قوانین را کوتاه، شفاف و دستوری بنویسید.')
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        t.inputEl.addClass('vssh-wide');
        t.setValue(this.plugin.settings.rulesText);
        t.onChange(async (v) => {
          this.plugin.settings.rulesText = v;
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName('نمایش قوانین پس از اتصال')
      .setDesc('اگر فعال باشد، قوانین به‌محض ورود کلاینت نمایش داده می‌شوند (MOTD).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showRulesOnConnect).onChange(async (v) => {
          this.plugin.settings.showRulesOnConnect = v;
          await this.plugin.savePluginData();
        })
      );

    /* ---------- permissions ---------- */
    containerEl.createEl('h3', { text: 'دسترسی‌ها و امنیت' });

    new Setting(containerEl)
      .setName('اجازه‌ی نوشتن')
      .setDesc('اگر خاموش شود، کلاینت‌ها فقط می‌توانند بخوانند (ls، cat، find و …) و دستورات write/append/rm/mv/cp رد می‌شوند.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowWrites).onChange(async (v) => {
          this.plugin.settings.allowWrites = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName('اجازه‌ی فرمان تک‌خطی (exec)')
      .setDesc('حالت اجرای تک‌فرمانی مثل ssh host "ls" — بیشتر ابزارهای هوش مصنوعی از این حالت استفاده می‌کنند. برای شل تعاملی لازم نیست.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowExec).onChange(async (v) => {
          this.plugin.settings.allowExec = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName('روش حذف فایل‌ها')
      .setDesc('«سطل زباله» پیشنهاد می‌شود؛ حذف دائمی قابل بازگشت نیست.')
      .addDropdown((d) =>
        d
          .addOption('trash', 'انتقال به سطل زباله (پیشنهادی)')
          .addOption('permanent', 'حذف دائمی (خطرناک)')
          .setValue(this.plugin.settings.deleteMode)
          .onChange(async (v) => {
            this.plugin.settings.deleteMode = v === 'permanent' ? 'permanent' : 'trash';
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName('حداکثر نشست همزمان')
      .setDesc('تعداد اتصال‌های همزمان مجاز (پیش‌فرض: 3).')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(this.plugin.settings.maxSessions));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 1 && n <= 20) {
            this.plugin.settings.maxSessions = n;
            await this.plugin.savePluginData();
          }
        });
      });

    new Setting(containerEl)
      .setName('حداکثر حجم خواندن هر فایل (KB)')
      .setDesc('فایل‌های بزرگ‌تر با cat خوانده نمی‌شوند؛ از head/tail استفاده کنید. (پیش‌فرض: 512)')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(Math.round(this.plugin.settings.maxReadBytes / 1024)));
        t.onChange(async (v) => {
          const kb = parseInt(v, 10);
          if (!isNaN(kb) && kb >= 1 && kb <= 10240) {
            this.plugin.settings.maxReadBytes = kb * 1024;
            await this.plugin.savePluginData();
          }
        });
      });

    new Setting(containerEl)
      .setName('نمایش فایل‌های مخفی')
      .setDesc('فایل‌ها و پوشه‌هایی که با نقطه شروع می‌شوند (مثل .trash). در حالت خاموش، از طریق SSH کاملاً غیرقابل‌دسترس‌اند.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showHidden).onChange(async (v) => {
          this.plugin.settings.showHidden = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName('مسیرهای محافظت‌شده')
      .setDesc('با کاما جدا شوند؛ این مسیرها همیشه و در هر حالتی از طریق SSH قابل‌دسترس نیستند. (پیش‌فرض: .obsidian)')
      .addText((t) =>
        t.setValue(this.plugin.settings.protectedPaths).onChange(async (v) => {
          this.plugin.settings.protectedPaths = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName('ثبت وقایع در کنسول توسعه‌دهنده')
      .setDesc('ورود/خروج و دستورات در کنسول (Ctrl+Shift+I) هم ثبت می‌شوند.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.logToConsole).onChange(async (v) => {
          this.plugin.settings.logToConsole = v;
          await this.plugin.savePluginData();
        })
      );
  }

  private renderStatus(box: HTMLElement): void {
    box.empty();
    const running = this.plugin.server?.isRunning?.() ?? false;

    const badge = box.createDiv('vssh-badge');
    const dot = badge.createSpan('vssh-dot');
    if (running) dot.addClass('on');
    badge.createSpan({ text: running ? `سرور فعال است — ${this.plugin.settings.bindAddress}:${this.plugin.settings.port}` : 'سرور خاموش است' });

    const actions = box.createDiv('vssh-actions');
    const startStop = actions.createEl('button', {
      text: running ? 'توقف سرور' : 'شروع سرور',
      cls: running ? 'mod-warning' : 'mod-cta',
    });
    startStop.addEventListener('click', async () => {
      if (this.plugin.server.isRunning()) await this.plugin.stopServer();
      else await this.plugin.startServer();
      this.display();
    });

    const infoBtn = actions.createEl('button', { text: 'اطلاعات اتصال' });
    infoBtn.addEventListener('click', () => {
      new ConnectionInfoModal(this.plugin.app, this.plugin).open();
    });

    const sessionsBtn = actions.createEl('button', { text: 'نشست‌های فعال' });
    sessionsBtn.addEventListener('click', () => {
      new SessionsModal(this.plugin.app, this.plugin).open();
    });
  }
}
