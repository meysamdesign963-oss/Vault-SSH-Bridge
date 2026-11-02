/**
 * Vault SSH Bridge — sandboxed filesystem layer over the Obsidian vault.
 *
 * SECURITY MODEL
 * - Every path is resolved inside a virtual root ('' = vault root).
 *   Leading '/' means vault root; '..' segments are resolved and any
 *   attempt to climb above the vault root is rejected.
 * - "Protected" prefixes (default: .obsidian) are always inaccessible.
 * - Dot-files/folders are hidden unless showHidden is enabled.
 * - Write operations require settings.allowWrites.
 */

import { VaultSSHSettings } from './types';

export class VaultError extends Error {}

export interface FileStat {
  type?: 'file' | 'folder';
  size: number;
  ctime?: number;
  mtime: number;
}

export interface AdapterLike {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<unknown>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<unknown>;
  append(path: string, data: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  rename(path: string, newPath: string): Promise<unknown>;
  trashLocal?(path: string): Promise<unknown>;
}

export interface AbstractLike {
  path: string;
  children?: unknown[];
  stat?: { size?: number; mtime?: number; ctime?: number };
}

export interface FileLike {
  path: string;
  stat: { size?: number; mtime: number; ctime?: number };
}

/** Structural subset of Obsidian's Vault — lets the core run in plain Node for tests. */
export interface VaultLike {
  getName(): string;
  exists(path: string): Promise<boolean>;
  adapter: AdapterLike;
  getAbstractFileByPath(path: string): AbstractLike | null;
  getMarkdownFiles(): FileLike[];
  getFiles?(): FileLike[];
  cachedRead(file: FileLike): Promise<string>;
  createFolder(path: string): Promise<unknown>;
  create(path: string, data: string): Promise<FileLike>;
  modify(file: AbstractLike, data: string): Promise<unknown>;
  delete(file: AbstractLike, force?: boolean): Promise<unknown>;
  trash(file: AbstractLike, system: boolean): Promise<unknown>;
  rename(file: AbstractLike, newPath: string): Promise<unknown>;
}

export function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function fmtBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class VaultFS {
  constructor(private vault: VaultLike, private getSettings: () => VaultSSHSettings) {}

  private set(): VaultSSHSettings {
    return this.getSettings();
  }

  vaultName(): string {
    try {
      return this.vault.getName() || 'vault';
    } catch {
      return 'vault';
    }
  }

  /* ---------------- path safety ---------------- */

  protectedPrefixes(): string[] {
    return this.set().protectedPaths
      .split(',')
      .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
      .filter((s) => s.length > 0);
  }

  isProtected(p: string): boolean {
    return this.protectedPrefixes().some((base) => p === base || p.startsWith(base + '/'));
  }

  isHidden(p: string): boolean {
    return !this.set().showHidden && p.split('/').some((seg) => seg.startsWith('.'));
  }

  /** Throw if the path may not be touched at all. */
  assertAllowed(p: string): void {
    if (p === '') return; // vault root itself is fine to list / cd into
    if (this.isProtected(p)) {
      throw new VaultError(`مسیر محافظت‌شده است (protected path): /${p}`);
    }
    if (this.isHidden(p)) {
      throw new VaultError(`مسیر مخفی است و نمایش فایل‌های مخفی خاموش است (hidden path): /${p}`);
    }
  }

  private assertWrites(): void {
    if (!this.set().allowWrites) {
      throw new VaultError('عملیات نوشتن توسط مالک سرور غیرفعال است (write operations are disabled by the owner)');
    }
  }

  /**
   * Resolve a client-supplied path against the virtual cwd.
   * Returns a vault-relative posix path ('' = vault root). Throws VaultError
   * when the path escapes the vault or points at a forbidden location.
   */
  resolve(cwd: string, input: string): string {
    let raw = (input ?? '').trim();
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    raw = raw.trim();
    if (!raw || raw === '.') return cwd;

    const merged = raw.startsWith('/') ? raw.slice(1) : (cwd ? cwd + '/' : '') + raw;
    const segs: string[] = [];
    for (const seg of merged.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (segs.length === 0) {
          throw new VaultError('دسترسی به خارج از خزانه مجاز نیست (path escapes the vault)');
        }
        segs.pop();
        continue;
      }
      segs.push(seg);
    }
    const path = segs.join('/');
    this.assertAllowed(path);
    return path;
  }

  display(p: string): string {
    return '/' + p;
  }

  private adapterPath(p: string): string {
    return p === '' ? '/' : '/' + p;
  }

  /* ---------------- basic ops ---------------- */

  async statSafe(p: string): Promise<FileStat | null> {
    const tries = p === '' ? ['/', ''] : [this.adapterPath(p)];
    for (const t of tries) {
      try {
        return await this.vault.adapter.stat(t);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async assertExists(p: string): Promise<FileStat> {
    const st = await this.statSafe(p);
    if (!st) throw new VaultError(`یافت نشد (not found): ${this.display(p)}`);
    return st;
  }

  async list(p: string): Promise<{ dirs: string[]; files: string[] }> {
    const st = await this.statSafe(p);
    if (!st) throw new VaultError(`یافت نشد (not found): ${this.display(p)}`);
    if (st.type && st.type !== 'folder') throw new VaultError(`این یک پوشه نیست (not a folder): ${this.display(p)}`);
    let res: { files: string[]; folders: string[] } | null = null;
    const tries = p === '' ? ['/', ''] : [this.adapterPath(p)];
    for (const t of tries) {
      try {
        res = await this.vault.adapter.list(t);
        break;
      } catch {
        /* try next */
      }
    }
    if (!res) throw new VaultError(`خواندن پوشه ممکن نشد (cannot list): ${this.display(p)}`);
    const norm = (x: string) => x.replace(/^\/+/, '').replace(/\/+$/, '');
    const keep = (full: string) => {
      const f = norm(full);
      return !this.isProtected(f) && !this.isHidden(f);
    };
    const dirs = res.folders.map(norm).filter(keep).map((d) => d.split('/').pop() as string).sort();
    const files = res.files.map(norm).filter(keep).map((f) => f.split('/').pop() as string).sort();
    return { dirs, files };
  }

  private async ensureDir(p: string): Promise<void> {
    if (!p) return;
    const parts = p.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      let exists = false;
      try {
        exists = !!(this.vault.getAbstractFileByPath(cur) || (await this.vault.exists(cur)));
      } catch {
        exists = false;
      }
      if (!exists) {
        try {
          await this.vault.createFolder(cur);
        } catch {
          /* race: already created */
        }
      }
    }
  }

  async read(p: string): Promise<string> {
    this.assertAllowed(p);
    const st = await this.assertExists(p);
    if (st.type === 'folder') throw new VaultError(`این یک پوشه است (is a folder): ${this.display(p)}`);
    const max = this.set().maxReadBytes;
    if (st.size > max) {
      throw new VaultError(
        `فایل بزرگ‌تر از حد مجاز است (${fmtBytes(st.size)} > ${fmtBytes(max)}). از head یا tail استفاده کن (file too large; use head/tail)`
      );
    }
    return await this.vault.adapter.read(this.adapterPath(p));
  }

  async write(p: string, content: string): Promise<number> {
    if (!p) throw new VaultError('نام فایل لازم است (a file name is required)');
    this.assertAllowed(p);
    this.assertWrites();
    await this.ensureDir(parentOf(p));
    const af = this.vault.getAbstractFileByPath(p);
    if (af && af.children) throw new VaultError(`این مسیر یک پوشه است (is a folder): ${this.display(p)}`);
    if (af) {
      await this.vault.modify(af, content);
    } else {
      try {
        await this.vault.create(p, content);
      } catch {
        await this.vault.adapter.write(this.adapterPath(p), content);
      }
    }
    return content.length;
  }

  async append(p: string, text: string): Promise<number> {
    if (!p) throw new VaultError('نام فایل لازم است (a file name is required)');
    this.assertAllowed(p);
    this.assertWrites();
    const st = await this.statSafe(p);
    if (st && st.type === 'folder') throw new VaultError(`این مسیر یک پوشه است (is a folder): ${this.display(p)}`);
    if (!st) {
      return this.write(p, text);
    }
    let base = '';
    let haveBase = false;
    if (st.size > 0 && st.size <= 1_000_000) {
      try {
        base = await this.vault.adapter.read(this.adapterPath(p));
        haveBase = true;
      } catch {
        haveBase = false;
      }
    }
    const sep = haveBase && base.length > 0 && !base.endsWith('\n') ? '\n' : '';
    const af = this.vault.getAbstractFileByPath(p);
    if (haveBase && af && !af.children) {
      await this.vault.modify(af, base + sep + text);
      return (sep + text).length;
    }
    await this.vault.adapter.append(this.adapterPath(p), sep + text);
    return (sep + text).length;
  }

  async mkdir(p: string): Promise<string> {
    if (!p) throw new VaultError('نام پوشه لازم است (a folder name is required)');
    this.assertAllowed(p);
    this.assertWrites();
    await this.ensureDir(p);
    return p;
  }

  async remove(p: string): Promise<'trash' | 'deleted'> {
    if (!p) throw new VaultError('حذف ریشه‌ی خزانه ممکن نیست (cannot remove the vault root)');
    this.assertAllowed(p);
    this.assertWrites();
    const af = this.vault.getAbstractFileByPath(p);
    if (!af) {
      const st = await this.statSafe(p);
      if (!st) throw new VaultError(`یافت نشد (not found): ${this.display(p)}`);
    }
    const target = af ?? ({ path: p } as AbstractLike);
    const mode = this.set().deleteMode;
    try {
      if (mode === 'trash') {
        await this.vault.trash(target, true);
        return 'trash';
      }
      await this.vault.delete(target, true);
      return 'deleted';
    } catch (e) {
      const ad = this.vault.adapter as AdapterLike;
      if (ad.trashLocal) {
        try {
          await ad.trashLocal(this.adapterPath(p));
          return 'trash';
        } catch {
          /* fall through */
        }
      }
      throw e;
    }
  }

  async move(src: string, dst: string): Promise<void> {
    if (!src || !dst) throw new VaultError('مسیر مبدأ و مقصد لازم است (source and destination are required)');
    if (src === dst) throw new VaultError('مبدأ و مقصد یکی است (source and destination are the same)');
    this.assertAllowed(src);
    this.assertAllowed(dst);
    this.assertWrites();
    await this.assertExists(src);
    const dstSt = await this.statSafe(dst);
    if (dstSt) throw new VaultError(`مقصد از قبل وجود دارد (destination already exists): ${this.display(dst)}`);
    await this.ensureDir(parentOf(dst));
    const af = this.vault.getAbstractFileByPath(src);
    if (!af) throw new VaultError(`یافت نشد (not found): ${this.display(src)}`);
    try {
      await this.vault.rename(af, dst);
    } catch (e) {
      try {
        await this.vault.adapter.rename(this.adapterPath(src), this.adapterPath(dst));
      } catch {
        throw e;
      }
    }
  }

  async copy(src: string, dst: string): Promise<number> {
    if (!src || !dst) throw new VaultError('مسیر مبدأ و مقصد لازم است (source and destination are required)');
    this.assertAllowed(src);
    this.assertAllowed(dst);
    this.assertWrites();
    const st = await this.assertExists(src);
    if (st.type === 'folder') throw new VaultError('کپی پوشه پشتیبانی نمی‌شود؛ فقط فایل (copying folders is not supported)');
    const dstSt = await this.statSafe(dst);
    if (dstSt) throw new VaultError(`مقصد از قبل وجود دارد (destination already exists): ${this.display(dst)}`);
    const content = await this.vault.adapter.read(this.adapterPath(src));
    await this.write(dst, content);
    return content.length;
  }

  /* ---------------- search & info ---------------- */

  private allFiles(): FileLike[] {
    const files = this.vault.getFiles ? this.vault.getFiles() : this.vault.getMarkdownFiles();
    return files.filter((f) => !this.isProtected(f.path) && !this.isHidden(f.path));
  }

  async searchFileNames(q: string, base: string): Promise<string[]> {
    const qn = q.toLowerCase();
    return this.allFiles()
      .filter((f) => !base || f.path === base || f.path.startsWith(base + '/'))
      .filter((f) => {
        const name = (f.path.split('/').pop() as string).toLowerCase();
        return f.path.toLowerCase().includes(qn) || name.includes(qn);
      })
      .slice(0, 50)
      .map((f) => f.path);
  }

  async searchContent(q: string, base: string): Promise<string[]> {
    const qn = q.toLowerCase();
    const files = this.vault
      .getMarkdownFiles()
      .filter((f) => !this.isProtected(f.path) && !this.isHidden(f.path))
      .filter((f) => !base || f.path === base || f.path.startsWith(base + '/'));
    const results: string[] = [];
    const cap = Math.min(files.length, 2000);
    for (let i = 0; i < cap && results.length < 40; i++) {
      const f = files[i];
      const size = f.stat?.size ?? 0;
      if (size > 1_000_000) continue;
      let content = '';
      try {
        content = await this.vault.cachedRead(f as FileLike);
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let li = 0; li < lines.length; li++) {
        if (lines[li].toLowerCase().includes(qn)) {
          results.push(`${f.path}:${li + 1}: ${lines[li].trim().slice(0, 160)}`);
          if (results.length >= 40) break;
        }
      }
    }
    return results;
  }

  async recent(n: number): Promise<{ path: string; mtime: number }[]> {
    return this.allFiles()
      .slice()
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0))
      .slice(0, n)
      .map((f) => ({ path: f.path, mtime: f.stat?.mtime ?? 0 }));
  }

  async tree(base: string, maxDepth: number): Promise<string[]> {
    const lines: string[] = [];
    let folders = 0;
    const walk = async (p: string, depth: number): Promise<void> => {
      if (depth > maxDepth || folders > 300 || lines.length > 400) return;
      const res = await this.list(p);
      for (const d of res.dirs) {
        if (lines.length > 400) return;
        lines.push('  '.repeat(depth + 1) + d + '/');
        folders++;
        await walk(p ? p + '/' + d : d, depth + 1);
      }
      for (const f of res.files) {
        if (lines.length > 400) return;
        lines.push('  '.repeat(depth + 1) + f);
      }
    };
    if (base) {
      const st = await this.assertExists(base);
      if (st.type !== 'folder') throw new VaultError(`این یک پوشه نیست (not a folder): ${this.display(base)}`);
    }
    await walk(base, 0);
    if (base) lines.unshift(base + '/');
    return lines;
  }

  async info(): Promise<{ name: string; notes: number; totalFiles: number }> {
    const files = this.allFiles();
    const notes = files.filter((f) => f.path.toLowerCase().endsWith('.md')).length;
    return { name: this.vaultName(), notes, totalFiles: files.length };
  }
}
