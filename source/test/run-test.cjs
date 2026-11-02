/**
 * End-to-end test: starts the real SSH server (bundled core) on a loopback
 * port and talks to it with the real ssh2 client library.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');
const core = require('./test-core.cjs');
const { createFakeVault } = require('./fake-vault.cjs');

const PORT = 2280 + Math.floor(Math.random() * 100);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2714 ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ' :: ' + extra : ''));
    console.log('  \u2718 ' + name + (extra ? ' :: ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectTo(port, user, password) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const to = setTimeout(() => {
      conn.end();
      reject(new Error('connect timeout'));
    }, 8000);
    conn.on('ready', () => {
      clearTimeout(to);
      resolve(conn);
    });
    conn.on('error', (err) => {
      clearTimeout(to);
      reject(err);
    });
    conn.connect({
      host: '127.0.0.1',
      port,
      username: user,
      password,
      readyTimeout: 7000,
    });
  });
}

function connect(user, password) {
  return connectTo(PORT, user, password);
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => {
        out += d.toString('utf8');
      });
      stream.stderr.on('data', (d) => {
        out += d.toString('utf8');
      });
      stream.on('close', (code) => resolve({ code, out }));
    });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-test-'));
  fs.writeFileSync(path.join(root, 'welcome.md'), '# Welcome\n\nThis is the test vault.\nLine three.\n');
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', 'ideas.md'), '- idea one\n- idea two\n- \u0633\u0644\u0627\u0645 \u062f\u0646\u06cc\u0627\n');
  fs.mkdirSync(path.join(root, '.obsidian'));
  fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), '{}');

  const vault = createFakeVault(root);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, {
    port: PORT,
    bindAddress: '127.0.0.1',
    username: 'ai',
    password: 'test-pass-123',
    rulesText: '\u0642\u0627\u0646\u0648\u06cc\u0646 \u0622\u0632\u0645\u0627\u06cc\u0634\u06cc: \u0641\u0642\u0637 \u062f\u0627\u062e\u0644 \u062e\u0632\u0627\u0646\u0647 \u06a9\u0627\u0631 \u06a9\u0646.',
    maxSessions: 3,
    startWithObsidian: false,
    logToConsole: false,
  });
  const vfs = new core.VaultFS(vault, () => settings);
  const keys = core.generateHostKeys();
  const server = new core.VaultSSHServer(
    () => settings,
    () => keys,
    vfs,
    { log: () => {}, notify: () => {}, onSessionsChanged: () => {}, onStatusChanged: () => {} }
  );
  await server.start();
  console.log(`SSH server up on 127.0.0.1:${PORT}`);

  console.log('--- netinfo / tunnel parsers ---');
  const pinggyOut = 'Connecting...\n  Tcp URL  : tcp://abc-xyz.a.pinggy.io:43210\nForwarding started';
  const ep1 = core.parseTunnelEndpoint(pinggyOut, PORT);
  check('parse pinggy endpoint', !!ep1 && ep1.host === 'abc-xyz.a.pinggy.io' && ep1.port === 43210, JSON.stringify(ep1));
  const ep2 = core.parseTunnelEndpoint('Warning: Permanently added...\nForwarding TCP connections to serveo.net:52812', PORT);
  check('parse serveo endpoint', !!ep2 && ep2.host === 'serveo.net' && ep2.port === 52812, JSON.stringify(ep2));
  const ep3 = core.parseTunnelEndpoint('203.0.113.7:45678 ready', PORT);
  check('parse bare ip endpoint', !!ep3 && ep3.host === '203.0.113.7' && ep3.port === 45678, JSON.stringify(ep3));
  check('parser ignores loopback', core.parseTunnelEndpoint('127.0.0.1:2222 localhost:2222', PORT) === null);
  check('parser ignores local port', core.parseTunnelEndpoint('a.pinggy.io:33333', 33333) === null);
  check('parser rejects garbage', core.parseTunnelEndpoint('no endpoints here') === null);
  const lan = core.lanIPv4s();
  check('lanIPv4s returns array', Array.isArray(lan));
  check('bestLanIPv4 returns string', typeof core.bestLanIPv4() === 'string');
  const spec = core.buildTunnelSpec('pinggy', 2222);
  check('tunnel spec pinggy', spec.cmd === 'ssh' && spec.args.includes('a.pinggy.io') && spec.args.some((a) => String(a).includes('127.0.0.1:2222')));
  const specC = core.buildTunnelSpec('custom', 2222, 'ssh -R 0:127.0.0.1:{PORT} me@my-server.com');
  check('tunnel spec custom {PORT}', specC.cmd === 'ssh' && specC.args.some((a) => String(a) === '0:127.0.0.1:2222') && specC.args.includes('me@my-server.com'));

  console.log('--- auth ---');

  // --- authentication ---
  let wrongPass = false;
  try {
    await connect('ai', 'nope');
  } catch {
    wrongPass = true;
  }
  check('wrong password is rejected', wrongPass);

  let wrongUser = false;
  try {
    await connect('boss', 'test-pass-123');
  } catch {
    wrongUser = true;
  }
  check('wrong username is rejected', wrongUser);

  const conn = await connect('ai', 'test-pass-123');
  check('correct credentials accepted', true);

  console.log('--- basic commands ---');
  let r = await exec(conn, 'info');
  check('info shows vault name', r.out.includes('TestVault'), r.out);
  check('info exit code 0', r.code === 0);

  r = await exec(conn, 'pwd');
  check('pwd is /', r.out.trim() === '/', JSON.stringify(r.out));

  r = await exec(conn, 'ls');
  check('ls lists welcome.md', r.out.includes('welcome.md'), r.out);
  check('ls hides .obsidian', !r.out.includes('.obsidian'), r.out);
  check('ls shows projects/', r.out.includes('projects/'), r.out);

  console.log('--- write / read (unicode) ---');
  r = await exec(conn, 'write \u06cc\u0627\u062f\u062f\u0627\u0634\u062a-\u0641\u0627\u0631\u0633\u06cc.md \u0633\u0644\u0627\u0645 \u0628\u0631 \u0627\u0628\u0633\u06cc\u062f\u06cc\u0646');
  check('write persian file ok', r.code === 0, r.out);
  r = await exec(conn, 'cat \u06cc\u0627\u062f\u062f\u0627\u0634\u062a-\u0641\u0627\u0631\u0633\u06cc.md');
  check('cat returns persian content', r.out.includes('\u0633\u0644\u0627\u0645 \u0628\u0631 \u0627\u0628\u0633\u06cc\u062f\u06cc\u0646'), r.out);

  await exec(conn, 'write multi.md line1\\nline2');
  r = await exec(conn, 'cat multi.md');
  check('write handles \\n escape', r.out.includes('line1') && r.out.includes('line2'), JSON.stringify(r.out));

  await exec(conn, 'append multi.md line3');
  r = await exec(conn, 'cat multi.md');
  check('append adds a line', r.out.includes('line3'), r.out);

  console.log('--- folders / move ---');
  await exec(conn, 'mkdir docs');
  r = await exec(conn, 'mv multi.md docs/multi.md');
  check('mv ok', r.code === 0, r.out);
  r = await exec(conn, 'cat docs/multi.md');
  check('cat after mv', r.out.includes('line2'), r.out);

  // NOTE: in exec (one-shot) mode every command is its own session, so cwd does
  // not persist between commands — like real ssh. cd/pwd persistence is tested
  // in the interactive-shell section below.
  r = await exec(conn, 'cat docs/../welcome.md');
  check('.. inside vault is allowed', r.out.includes('# Welcome'), r.out);
  r = await exec(conn, 'cd /docs');
  check('cd to folder ok', r.code === 0, r.out);

  console.log('--- sandbox ---');
  r = await exec(conn, 'cat ../../etc/passwd');
  check('traversal outside vault blocked', r.code !== 0 && /\u062e\u0627\u0631\u062c \u0627\u0632 \u062e\u0632\u0627\u0646\u0647/.test(r.out), r.out);
  r = await exec(conn, 'cat /etc/passwd');
  check('absolute path resolves inside vault only', r.code !== 0 && /not found/.test(r.out), r.out);
  r = await exec(conn, 'write .obsidian/app.json hacked');
  check('protected path write blocked', r.code !== 0 && /\u0645\u062d\u0627\u0641\u0638\u062a/.test(r.out), r.out);
  r = await exec(conn, 'cat .obsidian/app.json');
  check('protected path read blocked', r.code !== 0, r.out);
  await exec(conn, 'cd /');

  console.log('--- head/tail/find/grep/tree/recent/stat ---');
  r = await exec(conn, 'head welcome.md 2');
  check('head works', r.out.includes('# Welcome') && !r.out.includes('Line three'), r.out);
  r = await exec(conn, 'tail welcome.md 1');
  check('tail works', r.out.includes('Line three'), r.out);

  r = await exec(conn, 'find welcome');
  check('find finds file names', r.out.includes('welcome.md'), r.out);
  r = await exec(conn, 'grep \u0633\u0644\u0627\u0645');
  check('grep finds content', r.out.includes('ideas.md') && r.out.includes('\u0633\u0644\u0627\u0645'), r.out);

  r = await exec(conn, 'tree');
  check('tree works', r.out.includes('projects/'), r.out);
  r = await exec(conn, 'recent 2');
  check('recent works', /(welcome|ideas|multi|\u06cc\u0627\u062f\u062f\u0627\u0634\u062a)/.test(r.out), r.out);
  r = await exec(conn, 'stat welcome.md');
  check('stat works', r.out.includes('type: file'), r.out);

  console.log('--- rules & safety ---');
  r = await exec(conn, 'rules');
  check('rules shows server rules', r.out.includes('\u0642\u0627\u0646\u0648\u06cc\u0646'), r.out);

  r = await exec(conn, 'sudo rm -rf /');
  check('unknown command refused', r.code !== 0 && /unknown command/.test(r.out), r.out);

  console.log('--- trash ---');
  r = await exec(conn, 'rm docs/multi.md');
  check('rm moves to trash', r.out.includes('trash'), r.out);
  r = await exec(conn, 'cat docs/multi.md');
  check('file gone after rm', r.code !== 0 && /not found/.test(r.out), r.out);
  check('.trash folder created in vault', fs.existsSync(path.join(root, '.trash')));

  await exec(conn, 'cp welcome.md copy.md');
  r = await exec(conn, 'cat copy.md');
  check('cp works', r.out.includes('# Welcome'), r.out);

  r = await exec(conn, 'cat .trash/copy.md');
  check('hidden .trash not readable by default', r.code !== 0, r.out);

  console.log('--- session limit ---');
  const shells = [];
  for (let i = 0; i < 3; i++) {
    const c2 = await connect('ai', 'test-pass-123');
    const stream = await new Promise((res, rej) =>
      c2.shell((err, s) => (err ? rej(err) : res(s)))
    );
    stream.on('data', () => {});
    shells.push({ conn: c2, stream });
  }
  await sleep(200);
  r = await exec(conn, 'info');
  check('4th session refused (limit 3)', /session limit/.test(r.out), r.out);
  for (const s of shells) {
    try {
      s.stream.end();
      s.conn.end();
    } catch {}
  }
  await sleep(400);
  r = await exec(conn, 'info');
  check('exec works again after shells close', r.code === 0 && r.out.includes('TestVault'), r.out);

  console.log('--- interactive shell (pty) ---');
  const conn3 = await connect('ai', 'test-pass-123');
  const sh = await new Promise((res, rej) =>
    conn3.shell({ term: 'xterm-256color' }, (err, s) => (err ? rej(err) : res(s)))
  );
  let buf = '';
  sh.on('data', (d) => {
    buf += d.toString('utf8');
  });
  await sleep(300);
  check('banner shown on connect', buf.includes('Vault SSH Bridge'), buf.slice(0, 400));
  check('rules shown on connect', buf.includes('\u0642\u0627\u0646\u0648\u06cc\u0646'), buf.slice(0, 1200));

  buf = '';
  sh.write('help\r');
  await sleep(300);
  check('help lists commands', buf.includes('Available commands'), buf.slice(0, 500));

  buf = '';
  sh.write('foobar\r');
  await sleep(250);
  check('unknown command in interactive shell', buf.includes('unknown command'), buf);

  buf = '';
  sh.write('rm -r /\r');
  await sleep(250);
  check('rm root refused', buf.includes('error'), buf);

  buf = '';
  sh.write('write shell-note.md \u0627\u0632 \u0637\u0631\u06cc\u0642 \u0634\u0644\r');
  await sleep(300);
  sh.write('cat shell-note.md\r');
  await sleep(300);
  check('write + cat via interactive shell', buf.includes('\u0627\u0632 \u0637\u0631\u06cc\u0642 \u0634\u0644'), buf);

  buf = '';
  sh.write('catt\x7f welcome.md\r');
  await sleep(300);
  check('backspace editing works', buf.includes('# Welcome'), buf);

  sh.write('cd docs\r');
  await sleep(250);
  sh.write('pwd\r');
  await sleep(250);
  check('cd + pwd in interactive shell', buf.includes('/docs'), buf);

  buf = '';
  sh.write('cat ../welcome.md\r');
  await sleep(300);
  check('.. inside vault is allowed (interactive)', buf.includes('# Welcome'), buf);

  buf = '';
  sh.write('rules\r');
  await sleep(250);
  check('rules command in shell', buf.includes('\u0642\u0627\u0646\u0648\u06cc\u0646'), buf);

  sh.write('exit\r');
  await sleep(300);
  try {
    conn3.end();
  } catch {}

  console.log('--- write-disabled mode ---');
  settings.allowWrites = false;
  r = await exec(conn, 'write nope.md x');
  check('writes refused when disabled', r.code !== 0 && /disabled/.test(r.out), r.out);
  r = await exec(conn, 'cat welcome.md');
  check('reads still fine when writes disabled', r.out.includes('# Welcome'), r.out);
  settings.allowWrites = true;

  console.log('--- brute-force IP ban (separate server) ---');
  const BAN_PORT = 2400 + Math.floor(Math.random() * 100);
  const banSettings = Object.assign({}, settings, {
    port: BAN_PORT,
    bruteforceProtect: true,
    maxAuthFails: 3,
    banMinutes: 5,
  });
  const banServer = new core.VaultSSHServer(
    () => banSettings,
    () => keys,
    vfs,
    { log: () => {}, notify: () => {}, onSessionsChanged: () => {}, onStatusChanged: () => {} }
  );
  await banServer.start();
  for (let i = 0; i < 3; i++) {
    try {
      await connectTo(BAN_PORT, 'ai', 'wrong-' + i);
    } catch {
      /* expected */
    }
  }
  await sleep(200);
  check('ban recorded after repeated failures', banServer.listBans().length === 1, JSON.stringify(banServer.listBans()));
  let bannedConn = false;
  try {
    await connectTo(BAN_PORT, 'ai', 'test-pass-123'); // correct creds must ALSO be refused while banned
  } catch {
    bannedConn = true;
  }
  check('banned IP refused even with correct password', bannedConn);
  const cleared = banServer.clearBans();
  check('clearBans removes bans', cleared === 1);
  const connAfterClear = await connectTo(BAN_PORT, 'ai', 'test-pass-123');
  check('connection works after ban cleared', !!connAfterClear);
  try {
    connAfterClear.end();
  } catch {}
  await banServer.stop();

  console.log('--- teardown ---');
  try {
    conn.end();
  } catch {}
  await sleep(200);
  await server.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(2);
});
