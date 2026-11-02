/**
 * Vault SSH Bridge — the command shell served over SSH.
 *
 * Two modes:
 * - Interactive (pty): line editing, banner + rules on connect, colored prompt.
 * - exec (one-shot, `ssh host "cmd"`): plain output, exit codes — ideal for AI tools.
 *
 * Commands are vault-scoped and implemented on top of VaultFS.
 */

import { StringDecoder } from 'string_decoder';
import { VaultSSHSettings } from './types';
import { VaultFS, VaultError, fmtBytes, fmtDate } from './vaultfs';

export const PLUGIN_VERSION = '1.0.0';

export interface ShellIO {
  write(s: string): void;
  close(): void;
}

export interface ShellMeta {
  user: string;
  ip: string;
  kind: 'pty' | 'exec';
}

export interface ShellHooks {
  log?: (text: string) => void;
}

const HELP_TEXT = [
  'Available commands:',
  '  info                          vault info (name, note count)',
  '  rules                         show the server rules',
  '  pwd                           show current folder',
  '  ls [folder]                   list folders and files',
  '  cd <folder>                   change folder (cd .. up, cd alone = root)',
  '  cat <file>                    read a note',
  '  head <file> [n]               first n lines (default 20)',
  '  tail <file> [n]               last n lines (default 20)',
  '  write <file> <text>           create or overwrite a note (use \\n for new lines)',
  '  append <file> <text>          append a line to a note',
  '  mkdir <folder>                create folder(s) recursively',
  '  rm [-r] <path>                move to trash (folders need -r)',
  '  mv <source> <destination>     move or rename',
  '  cp <source> <destination>     copy a note',
  '  find <query> [folder]         search file names',
  '  grep <query> [folder]         search inside notes',
  '  tree [folder]                 show folder tree (2 levels)',
  '  recent [n]                    n most recently modified files',
  '  stat <path>                   file/folder details',
  '  whoami | date | version       session info',
  '  clear                         clear the screen',
  '  exit                          close the connection',
  '',
  'Notes:',
  '  * Every path stays inside the vault - escaping the vault is blocked.',
  '  * Protected folders (e.g. .obsidian) are not accessible at all.',
  '  * Persian aliases: help=راهنما  rules=قوانین  exit=خروج',
  '',
  'Examples:',
  '  ls',
  '  cat notes/idea.md',
  '  write notes/idea2.md # Title\\nSome content',
  '  append notes/log.md done reviewing',
  '  grep meeting projects',
  '',
].join('\n');

interface Token {
  value: string;
  end: number;
}

function scanTokens(line: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let val = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === '\\' || line[i + 1] === 'n')) {
          if (line[i + 1] === 'n') val += '\n';
          else val += line[i + 1];
          i += 2;
        } else {
          val += line[i];
          i++;
        }
      }
      if (i < line.length) i++; // closing quote
    } else {
      while (i < line.length && !/\s/.test(line[i])) {
        val += line[i];
        i++;
      }
    }
    toks.push({ value: val, end: i });
  }
  return toks;
}

function unescapeText(s: string): string {
  let t = s;
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1);
  }
  return t.replace(/\\n/g, '\n');
}

/** Raw remainder of the line after N tokens (used for write/append content). */
function contentAfter(line: string, tokenCount: number): string {
  let i = 0;
  let n = 0;
  while (i < line.length && n < tokenCount) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i += 2;
        else i++;
      }
      if (i < line.length) i++;
    } else {
      while (i < line.length && !/\s/.test(line[i])) i++;
    }
    n++;
    if (n === tokenCount) return unescapeText(line.slice(i).trim());
  }
  return '';
}

export class ShellSession {
  cwd = '';
  private lineBuf = '';
  private decoder = new StringDecoder('utf8');
  private escState = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private vfs: VaultFS,
    private getSettings: () => VaultSSHSettings,
    private io: ShellIO,
    private meta: ShellMeta,
    private hooks: ShellHooks = {}
  ) {}

  /* ================= interactive mode ================= */

  startInteractive(): void {
    const s = this.getSettings();
    const colored = this.meta.kind === 'pty';
    const line = '==============================================================';
    this.io.write(line + '\n');
    this.io.write(` Obsidian Vault SSH Bridge  v${PLUGIN_VERSION}\n`);
    this.io.write(` vault: ${this.vfs.vaultName()}  |  user: ${this.meta.user}  |  ${this.meta.ip}\n`);
    this.io.write(' Access is restricted to this vault only.\n');
    this.io.write(' دسترسی فقط به فایل‌های داخل همین خزانه مجاز است.\n');
    this.io.write(line + '\n');
    if (s.showRulesOnConnect && s.rulesText.trim()) {
      this.io.write('\n' + s.rulesText.trim() + '\n');
    }
    if (colored) this.io.write("\nType 'help' for the command list.\n");
    else this.io.write("\nType 'help' for the command list.\n");
    this.showPrompt();
  }

  showPrompt(): void {
    if (this.closed) return;
    const u = `\x1b[36m${this.getSettings().username}@obsidian\x1b[0m`;
    const p = `\x1b[33m/${this.cwd}\x1b[0m`;
    this.io.write(`${u}:${p}$ `);
  }

  handleData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (const ch of text) this.handleChar(ch);
  }

  private handleChar(ch: string): void {
    if (this.closed) return;
    if (ch === '\r') {
      this.io.write('\r\n');
      const line = this.lineBuf;
      this.lineBuf = '';
      this.submit(line);
      return;
    }
    if (ch === '\n') return; // CR already handled; ignore stray LF
    if (ch === '\x7f' || ch === '\b') {
      if (this.lineBuf.length > 0) {
        this.lineBuf = this.lineBuf.slice(0, -1);
        this.io.write('\b \b');
      }
      return;
    }
    if (ch === '\x03') {
      this.lineBuf = '';
      this.io.write('^C');
      this.showPrompt();
      return;
    }
    if (ch === '\x04') {
      if (this.lineBuf.length === 0) {
        this.io.write('\r\nbye\r\n');
        this.close();
      }
      return;
    }
    if (ch === '\x1b') {
      this.escState = 1;
      return;
    }
    if (this.escState === 1) {
      this.escState = ch === '[' || ch === 'O' ? 2 : 0;
      return;
    }
    if (this.escState === 2) {
      if (/[a-zA-Z~]/.test(ch)) this.escState = 0;
      return;
    }
    if (ch >= ' ') {
      this.lineBuf += ch;
      this.io.write(ch);
    }
  }

  private submit(line: string): void {
    this.queue = this.queue
      .then(async () => {
        try {
          await this.runCommand(line, (s) => this.io.write(s));
        } catch (e) {
          const m = e instanceof VaultError ? e.message : (e as Error)?.message || String(e);
          this.io.write(`error: ${m}\n`);
        }
        this.showPrompt();
      })
      .catch((e) => {
        try {
          this.io.write(`internal error: ${e?.message ?? String(e)}\n`);
        } catch {
          /* ignore */
        }
        this.showPrompt();
      });
  }

  private close(): void {
    this.closed = true;
    try {
      this.io.close();
    } catch {
      /* ignore */
    }
    this.hooks.log?.(`shell closed for ${this.meta.ip}`);
  }

  /* ================= exec (one-shot) mode ================= */

  async runForExec(commandLine: string, out: (s: string) => void): Promise<number> {
    try {
      return await this.runCommand(commandLine, out);
    } catch (e) {
      const m = e instanceof VaultError ? e.message : (e as Error)?.message || String(e);
      out(`error: ${m}\n`);
      return 1;
    }
  }

  /* ================= command dispatch ================= */

  private async runCommand(line: string, out: (s: string) => void): Promise<number> {
    const trimmed = line.trim();
    if (!trimmed) return 0;
    const colored = this.meta.kind === 'pty';
    const toks = scanTokens(trimmed);
    const cmd = (toks[0]?.value ?? '').toLowerCase();
    const args = toks.slice(1).map((t) => t.value);
    const err = (m: string): number => {
      out((colored ? '\x1b[31m' : '') + 'error:' + (colored ? '\x1b[0m' : '') + ` ${m}\n`);
      return 1;
    };

    try {
      switch (cmd) {
        case 'help':
        case 'راهنما':
          out(HELP_TEXT);
          return 0;

        case 'rules':
        case 'قوانین': {
          const r = this.getSettings().rulesText;
          out((r.trim() || '(no rules set)') + '\n');
          return 0;
        }

        case 'info': {
          const i = await this.vfs.info();
          out(
            `vault: ${i.name}\n` +
              `notes (md): ${i.notes}\n` +
              `visible files: ${i.totalFiles}\n` +
              'access: sandboxed to the vault only\n' +
              `server: Vault SSH Bridge v${PLUGIN_VERSION}\n`
          );
          return 0;
        }

        case 'pwd':
          out(`/${this.cwd}\n`);
          return 0;

        case 'whoami':
          out(`${this.meta.user}\n`);
          return 0;

        case 'date':
          out(new Date().toString() + '\n');
          return 0;

        case 'version':
          out(`Vault SSH Bridge v${PLUGIN_VERSION}\n`);
          return 0;

        case 'clear':
          out('\x1b[2J\x1b[H');
          return 0;

        case 'exit':
        case 'quit':
        case 'logout':
        case 'خروج': {
          if (this.meta.kind === 'pty') {
            out('bye\n');
            this.close();
          }
          return 0;
        }

        case 'cd': {
          const p = this.vfs.resolve(this.cwd, args[0] ?? '/');
          if (p !== '') {
            const st = await this.vfs.statSafe(p);
            if (!st) return err(`یافت نشد (not found): ${this.vfs.display(p)}`);
            if (st.type !== 'folder') return err(`این یک پوشه نیست (not a folder): ${this.vfs.display(p)}`);
          }
          this.cwd = p;
          return 0;
        }

        case 'ls': {
          const p = this.vfs.resolve(this.cwd, args[0] ?? '');
          const { dirs, files } = await this.vfs.list(p);
          if (dirs.length === 0 && files.length === 0) {
            out('(empty)\n');
            return 0;
          }
          const lines = [
            ...dirs.map((d) => (colored ? '\x1b[34m' : '') + d + '/' + (colored ? '\x1b[0m' : '')),
            ...files,
          ];
          out(lines.join('\n') + `\n${dirs.length} folder(s), ${files.length} file(s)\n`);
          return 0;
        }

        case 'cat': {
          if (!args[0]) return err('usage: cat <file>');
          const p = this.vfs.resolve(this.cwd, args[0]);
          const content = await this.vfs.read(p);
          out(content.endsWith('\n') ? content : content + '\n');
          return 0;
        }

        case 'head':
        case 'tail': {
          if (!args[0]) return err(`usage: ${cmd} <file> [lines]`);
          const p = this.vfs.resolve(this.cwd, args[0]);
          const nRaw = parseInt(args[1] ?? '20', 10);
          const n = Math.max(1, Math.min(500, isNaN(nRaw) ? 20 : nRaw));
          const content = await this.vfs.read(p);
          const lines = content.replace(/\r\n/g, '\n').split('\n');
          // a trailing newline produces an empty final element — unix tail ignores it
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
          const slice = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
          out(slice.join('\n') + '\n');
          return 0;
        }

        case 'write': {
          if (args.length < 2) return err('usage: write <file> <text>   (use \\n for new lines)');
          const p = this.vfs.resolve(this.cwd, args[0]);
          const text = contentAfter(trimmed, 2);
          if (!text) return err('محتوا خالی است (empty content)');
          const n = await this.vfs.write(p, text);
          out(`written: ${this.vfs.display(p)} (${fmtBytes(n)})\n`);
          return 0;
        }

        case 'append': {
          if (args.length < 2) return err('usage: append <file> <text>');
          const p = this.vfs.resolve(this.cwd, args[0]);
          const text = contentAfter(trimmed, 2);
          if (!text) return err('محتوا خالی است (empty content)');
          const n = await this.vfs.append(p, text);
          out(`appended: ${this.vfs.display(p)} (+${fmtBytes(n)})\n`);
          return 0;
        }

        case 'mkdir': {
          if (!args[0]) return err('usage: mkdir <folder>');
          const p = this.vfs.resolve(this.cwd, args[0]);
          await this.vfs.mkdir(p);
          out(`created: ${this.vfs.display(p)}/\n`);
          return 0;
        }

        case 'rm': {
          let recursive = false;
          const paths: string[] = [];
          for (const a of args) {
            if (a === '-r' || a === '-rf' || a === '-R') recursive = true;
            else paths.push(a);
          }
          if (!paths[0]) return err('usage: rm [-r] <path>');
          const p = this.vfs.resolve(this.cwd, paths[0]);
          const st = await this.vfs.statSafe(p);
          if (!st) return err(`یافت نشد (not found): ${this.vfs.display(p)}`);
          if (st.type === 'folder' && !recursive) {
            return err(`این یک پوشه است — از rm -r استفاده کن (is a folder; use: rm -r ${this.vfs.display(p)})`);
          }
          const mode = await this.vfs.remove(p);
          out(mode === 'trash' ? `moved to trash: ${this.vfs.display(p)}\n` : `deleted: ${this.vfs.display(p)}\n`);
          return 0;
        }

        case 'mv':
        case 'rename': {
          if (args.length < 2) return err(`usage: ${cmd} <source> <destination>`);
          const src = this.vfs.resolve(this.cwd, args[0]);
          const dst = this.vfs.resolve(this.cwd, args[1]);
          await this.vfs.move(src, dst);
          out(`moved: ${this.vfs.display(src)} -> ${this.vfs.display(dst)}\n`);
          return 0;
        }

        case 'cp': {
          if (args.length < 2) return err('usage: cp <source-file> <destination>');
          const src = this.vfs.resolve(this.cwd, args[0]);
          const dst = this.vfs.resolve(this.cwd, args[1]);
          const n = await this.vfs.copy(src, dst);
          out(`copied: ${this.vfs.display(src)} -> ${this.vfs.display(dst)} (${fmtBytes(n)})\n`);
          return 0;
        }

        case 'find':
        case 'search-file': {
          if (!args[0]) return err('usage: find <query> [folder]');
          const base = args[1] ? this.vfs.resolve(this.cwd, args[1]) : this.cwd;
          const res = await this.vfs.searchFileNames(args[0], base);
          if (res.length === 0) {
            out('(no matches)\n');
            return 0;
          }
          out(res.map((r) => '/' + r).join('\n') + `\n${res.length} result(s)\n`);
          return 0;
        }

        case 'grep':
        case 'search': {
          if (!args[0]) return err('usage: grep <query> [folder]');
          const base = args[1] ? this.vfs.resolve(this.cwd, args[1]) : this.cwd;
          const res = await this.vfs.searchContent(args[0], base);
          if (res.length === 0) {
            out('(no matches)\n');
            return 0;
          }
          out(res.join('\n') + `\n${res.length} match(es)\n`);
          return 0;
        }

        case 'tree': {
          const p = args[0] ? this.vfs.resolve(this.cwd, args[0]) : this.cwd;
          const lines = await this.vfs.tree(p, 2);
          out((lines.length ? lines.join('\n') : '(empty)') + '\n');
          return 0;
        }

        case 'recent': {
          const nRaw = parseInt(args[0] ?? '10', 10);
          const n = Math.max(1, Math.min(50, isNaN(nRaw) ? 10 : nRaw));
          const res = await this.vfs.recent(n);
          if (res.length === 0) {
            out('(no files found)\n');
            return 0;
          }
          out(res.map((r) => `${fmtDate(r.mtime)}  ${this.vfs.display(r.path)}`).join('\n') + '\n');
          return 0;
        }

        case 'stat': {
          if (!args[0]) return err('usage: stat <path>');
          const p = this.vfs.resolve(this.cwd, args[0]);
          const st = await this.vfs.statSafe(p);
          if (!st) return err(`یافت نشد (not found): ${this.vfs.display(p)}`);
          out(
            `path: ${this.vfs.display(p)}\n` +
              `type: ${st.type ?? 'file'}\n` +
              `size: ${fmtBytes(st.size)} (${st.size} bytes)\n` +
              `modified: ${fmtDate(st.mtime)}\n`
          );
          return 0;
        }

        default:
          return err(`دستور ناشناخته (unknown command): ${cmd} — برای راهنما 'help' را بزن`);
      }
    } catch (e) {
      const m = e instanceof VaultError ? e.message : (e as Error)?.message || String(e);
      return err(m);
    }
  }
}
