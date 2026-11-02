/**
 * Vault SSH Bridge — shared types & default settings.
 */

export type DeleteMode = 'trash' | 'permanent';

/** Public tunnel service used to expose the server to the internet. */
export type TunnelMode = 'off' | 'pinggy' | 'serveo' | 'custom';

export interface VaultSSHSettings {
  /** Start the SSH server automatically when Obsidian loads. */
  startWithObsidian: boolean;
  /** TCP port of the embedded SSH server. */
  port: number;
  /** '127.0.0.1' (local only, recommended) or '0.0.0.0' (LAN). */
  bindAddress: string;
  /** Login username for clients / AI assistants. */
  username: string;
  /** Login password for clients / AI assistants. */
  password: string;
  /** Rules text shown on connect and via the `rules` command. */
  rulesText: string;
  /** Show the rules right after login (MOTD). */
  showRulesOnConnect: boolean;
  /** Allow write operations (write/append/mkdir/rm/mv/cp). */
  allowWrites: boolean;
  /** Allow one-shot `exec` mode (ssh host "command") used by many AI tools. */
  allowExec: boolean;
  /** How `rm` behaves: move to trash (recommended) or delete permanently. */
  deleteMode: DeleteMode;
  /** Maximum number of concurrent SSH sessions. */
  maxSessions: number;
  /** Maximum bytes a single `cat`/read may return. */
  maxReadBytes: number;
  /** Show dot-files/dot-folders in listings. */
  showHidden: boolean;
  /** Comma-separated vault paths that are always inaccessible. */
  protectedPaths: string;
  /** Mirror activity log to the developer console. */
  logToConsole: boolean;
  /** Public tunnel service for internet access (external AI assistants). */
  tunnelMode: TunnelMode;
  /** Custom ssh command template for tunnelMode === 'custom' ({PORT} = local port). */
  tunnelCustom: string;
  /** Temporarily ban IPs after repeated failed logins. */
  bruteforceProtect: boolean;
  /** Failed attempts (per IP, 10 min window) before a ban. */
  maxAuthFails: number;
  /** Ban duration in minutes. */
  banMinutes: number;
}

export const DEFAULT_RULES_TEXT = [
  '[Server Rules / قوانین سرور]',
  '1) تنها به فایل‌های داخل همین خزانه (Vault) دسترسی داری؛ خروج از پوشه خزانه مسدود است.',
  '2) پیش از بازنویسی یک فایل، اول با دستور cat محتوای فعلی‌اش را بخوان.',
  '3) فایل‌های محافظت‌شده و سیستمی را تغییر یا حذف نکن.',
  '4) برای ساخت فایل جدید از write و برای افزودن به فایل از append استفاده کن.',
  '5) محتوای خصوصی کاربر را خارج از این خزانه منتشر نکن.',
  "6) اگر مطمئن نیستی، دستور help را اجرا کن.",
].join('\n');

export const DEFAULT_SETTINGS: VaultSSHSettings = {
  startWithObsidian: true,
  port: 2222,
  bindAddress: '127.0.0.1',
  username: 'ai',
  password: '',
  rulesText: DEFAULT_RULES_TEXT,
  showRulesOnConnect: true,
  allowWrites: true,
  allowExec: true,
  deleteMode: 'trash',
  maxSessions: 3,
  maxReadBytes: 512 * 1024,
  showHidden: false,
  protectedPaths: '.obsidian',
  logToConsole: true,
  tunnelMode: 'off',
  tunnelCustom: '',
  bruteforceProtect: true,
  maxAuthFails: 5,
  banMinutes: 10,
};

export interface LogEntry {
  time: number;
  text: string;
}
