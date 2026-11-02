/**
 * A minimal in-memory-on-disk implementation of the Obsidian Vault interface,
 * so the plugin core can be tested in plain Node.js without Obsidian.
 */

const fs = require('fs');
const path = require('path');

function createFakeVault(root) {
  const full = (p) => path.join(root, p);

  const adapter = {
    async exists(p) {
      return fs.existsSync(full(p));
    },
    async stat(p) {
      const st = fs.statSync(full(p));
      return {
        type: st.isDirectory() ? 'folder' : 'file',
        size: st.size,
        mtime: st.mtimeMs,
        ctime: st.ctimeMs,
      };
    },
    async list(p) {
      const dir = full(p);
      const names = fs.readdirSync(dir);
      const files = [];
      const folders = [];
      for (const n of names) {
        const fp = path.join(dir, n);
        const rel = (p && p !== '/' ? p.replace(/\/+$/, '') + '/' : '') + n;
        if (fs.statSync(fp).isDirectory()) folders.push(rel);
        else files.push(rel);
      }
      return { files, folders };
    },
    async mkdir(p) {
      fs.mkdirSync(full(p), { recursive: true });
    },
    async read(p) {
      return fs.readFileSync(full(p), 'utf8');
    },
    async write(p, data) {
      fs.mkdirSync(path.dirname(full(p)), { recursive: true });
      fs.writeFileSync(full(p), data);
    },
    async append(p, data) {
      fs.mkdirSync(path.dirname(full(p)), { recursive: true });
      fs.appendFileSync(full(p), data);
    },
    async remove(p) {
      fs.rmSync(full(p), { recursive: true, force: true });
    },
    async rename(a, b) {
      fs.mkdirSync(path.dirname(full(b)), { recursive: true });
      fs.renameSync(full(a), full(b));
    },
  };

  let trashCounter = 0;

  return {
    getName() {
      return 'TestVault';
    },
    adapter,
    async exists(p) {
      return adapter.exists(p);
    },
    getAbstractFileByPath(p) {
      const fp = full(p);
      if (!fs.existsSync(fp)) return null;
      const st = fs.statSync(fp);
      return {
        path: p,
        children: st.isDirectory() ? [] : undefined,
        stat: { mtime: st.mtimeMs, size: st.size, ctime: st.ctimeMs },
      };
    },
    getMarkdownFiles() {
      const out = [];
      (function walk(dir, rel) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const n of names) {
          const fp = path.join(dir, n);
          const r = rel ? rel + '/' + n : n;
          let st;
          try {
            st = fs.statSync(fp);
          } catch {
            continue;
          }
          if (st.isDirectory()) walk(fp, r);
          else if (n.endsWith('.md')) {
            out.push({ path: r, stat: { mtime: st.mtimeMs, size: st.size, ctime: st.ctimeMs } });
          }
        }
      })(root, '');
      return out;
    },
    async cachedRead(f) {
      return fs.readFileSync(full(f.path), 'utf8');
    },
    async createFolder(p) {
      if (fs.existsSync(full(p))) throw new Error('Folder already exists');
      fs.mkdirSync(full(p), { recursive: true });
    },
    async create(p, data) {
      if (fs.existsSync(full(p))) throw new Error('File already exists');
      await adapter.write(p, data);
      return { path: p, stat: { mtime: Date.now(), size: data.length } };
    },
    async modify(f, data) {
      fs.writeFileSync(full(f.path), data);
    },
    async delete(af) {
      fs.rmSync(full(af.path), { recursive: true, force: true });
    },
    async trash(af) {
      const t = path.join(root, '.trash');
      fs.mkdirSync(t, { recursive: true });
      const base = path.basename(af.path);
      const dest = path.join(t, base + '.' + ++trashCounter);
      fs.renameSync(full(af.path), dest);
    },
    async rename(af, np) {
      await adapter.rename(af.path, np);
    },
  };
}

module.exports = { createFakeVault };
