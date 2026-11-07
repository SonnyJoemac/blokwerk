#!/usr/bin/env node
'use strict';
if (+process.versions.node.split('.')[0] < 18) { console.error('Node 18 of nieuwer is nodig: https://nodejs.org'); process.exit(1); }
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const { spawn, execFile, exec } = require('child_process');
const crypto = require('crypto');
const ROOT = __dirname, DATA = path.join(ROOT, 'data'), SRV = path.join(DATA, 'server'), JRE = path.join(DATA, 'java'), CFG = path.join(DATA, 'config.json');
const BAK = path.join(DATA, 'backups'), TRASH = path.join(DATA, 'trash'), HIST = path.join(DATA, 'file-history'), CRASH = path.join(DATA, 'crash-logs'), TMP = path.join(DATA, 'tmp');
const PLJ = path.join(DATA, 'players.json'), LOCK = path.join(DATA, 'server.lock'), BIDX = path.join(BAK, 'index.json');
const VERSION='4.0.0';
const UA = { 'User-Agent': 'Blokwerk/' + VERSION };
const FILES = ['blokwerk.js', 'dashboard.html'], APPCFG = path.join(DATA, 'app.json');
const AIK = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1'.split(' ');
let PORT = +process.env.PORT || 3000;
for (const d of [SRV, BAK, TRASH, HIST, CRASH]) fs.mkdirSync(d, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });

class Err extends Error { constructor(s, m) { super(m); this.status = s; } }
const jr = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const mb = n => Math.round(n / 1048576) + ' MB';
const run = (cmd, args, o) => new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 256e6, ...o }, (e, so, se) => e ? no(Object.assign(new Error(String(se || e.message).trim().split('\n')[0]), { code: e.code, se: String(se || '') })) : ok(String(so))));
const pexec = fn => new Promise(r => fn(r));
async function dirSize(p) {
  let n = 0, es; try { es = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return 0; }
  await Promise.all(es.map(async e => { const f = path.join(p, e.name); if (e.isDirectory()) n += await dirSize(f); else if (e.isFile()) { try { n += (await fs.promises.stat(f)).size; } catch {} } }));
  return n;
}
function mv(a, b) { try { fs.renameSync(a, b); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(a, b, { recursive: true }); fs.rmSync(a, { recursive: true, force: true }); } }

// ---- instellingen van de app (data/app.json, nooit naar de browser gestuurd behalve de veilige velden)
const DEFB = { auto: false, mode: 'daily', at: '04:00', everyH: 6, keep: 7, scope: 'full', last: 0 };
let app = { updateUrl: process.env.BLOKWERK_UPDATE_URL || '', auth: null, autoStart: false, crashRestart: true, restartAt: '', backup: { ...DEFB } };
{ const a = jr(APPCFG, {}); Object.assign(app, a); app.backup = { ...DEFB, ...(a.backup || {}) }; }
const saveApp = () => fs.writeFileSync(APPCFG, JSON.stringify(app, null, 1), { mode: 0o600 });
const U = { available: null, checked: 0, error: '' };
let cfg = jr(CFG, null);
const S = { status: cfg ? 'offline' : 'setup', proc: null, starting: false, players: new Set(), joined: {}, started: 0, mem: 0, busy: false, after: null, expected: false, crashes: [] };
const M = { hist: [], cpu: null, net: null, pp: null, tps: null, noTick: false, heap: null, temp: null, srvSize: 0, sizeAt: 0, alerts: [], last: null };
const P = Object.assign({ hist: [], uuids: {} }, jr(PLJ, {}));
const savePl = () => { try { fs.writeFileSync(PLJ, JSON.stringify({ hist: P.hist.slice(-500), uuids: P.uuids })); } catch {} };
const logs = [], clients = new Set(), W = [];
const emit = (ev, d) => { const m = 'event: ' + ev + '\ndata: ' + JSON.stringify(d) + '\n\n'; for (const c of clients) c.write(m); };
const log = (m, c) => { const l = { t: new Date().toTimeString().slice(0, 8), m, c: c || '' }; logs.push(l); if (logs.length > 1000) logs.shift(); emit('log', l); };
const state = () => ({ status: S.status, cfg: cfg && { type: cfg.type, version: cfg.version, ram: cfg.ram, port: cfg.port, max: cfg.max, flags: cfg.flags },
  players: [...S.players], uptime: S.started ? Math.floor((Date.now() - S.started) / 1000) : 0, mem: S.mem, busy: S.busy, metrics: M.last, alerts: M.alerts,
  app: { version: VERSION, updateUrl: app.updateUrl, update: U.available, checked: U.checked, error: U.error } });
const push = () => emit('state', state());
const pick = (v, l, d) => l.includes(v) ? v : d;
const levelName = () => parseProps(readTxt(path.join(SRV, 'server.properties')))['level-name'] || 'world';
function readTxt(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
function parseProps(t) { const o = {}; for (const l of t.split(/\r?\n/)) { if (!l.trim() || /^\s*[#!]/.test(l)) continue; const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return o; }

// ---- authenticatie: wachtwoord (scrypt), sessiecookie (HttpOnly, SameSite=Strict) en CSRF-token per sessie
const sess = new Map(); let fails = { n: 0, until: 0 };
let setupCode = app.auth ? '' : String(crypto.randomInt(100000, 999999));
const hashPw = (pw, salt) => crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
function setPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); app.auth = { salt, hash: hashPw(pw, salt).toString('hex') }; saveApp(); }
function checkPw(pw) { if (!app.auth || typeof pw !== 'string') return false; const h = hashPw(pw, app.auth.salt), e = Buffer.from(app.auth.hash, 'hex'); return h.length === e.length && crypto.timingSafeEqual(h, e); }
function newSession(res) {
  const id = crypto.randomBytes(32).toString('hex'), s = { csrf: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 12 * 3600e3 };
  sess.set(id, s); res.setHeader('Set-Cookie', 'bw=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'); return s; // geen Secure-vlag: alleen http://localhost
}
function getSession(req) {
  const m = /(?:^|;\s*)bw=([a-f0-9]{64})/.exec(req.headers.cookie || ''), s = m && sess.get(m[1]);
  if (!s) return null; if (s.exp < Date.now()) { sess.delete(m[1]); return null; }
  s.exp = Date.now() + 12 * 3600e3; return { ...s, id: m[1] };
}
const goodPw = p => typeof p === 'string' && p.length >= 8 && p.length <= 128;
const J = u => fetch(u, { headers: UA }).then(r => { if (!r.ok) throw new Error(u + ' gaf HTTP ' + r.status); return r.json(); });
async function download(u, dest, label) {
  const r = await fetch(u, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error('Download mislukt (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || 0; let got = 0, last = 0;
  const out = fs.createWriteStream(dest);
  for await (const ch of r.body) {
    got += ch.length; if (!out.write(ch)) await new Promise(k => out.once('drain', k));
    if (total && Date.now() - last > 600) { last = Date.now(); emit('progress', { label, pct: Math.round(got / total * 100) }); }
  }
  await new Promise((k, e) => { out.on('error', e); out.end(k); });
  emit('progress', { label, pct: 100 });
}
const cmp = (a, b) => { const p = s => s.split('-')[0].split('.').map(Number), x = p(a), y = p(b); for (let i = 0; i < 3; i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; } return 0; };
async function resolve(type, ver) {
  const man = await J('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  let v = ver === 'latest' ? man.latest.release : ver, url;
  if (type === 'paper') {
    const A = 'https://fill.papermc.io/v3/projects/paper'; let b;
    if (ver === 'latest') {
      for (const x of Object.values((await J(A)).versions).flat().sort(cmp)) {
        b = (await J(A + '/versions/' + x + '/builds')).find(q => q.channel === 'STABLE'); if (b) { v = x; break; }
      }
    } else { const all = await J(A + '/versions/' + v + '/builds'); b = all.find(q => q.channel === 'STABLE') || all[0]; }
    if (!b) throw new Error('Geen Paper-build gevonden');
    url = (b.downloads['server:default'] || Object.values(b.downloads)[0]).url;
  } else if (type === 'purpur') {
    const A = 'https://api.purpurmc.org/v2/purpur'; if (ver === 'latest') v = (await J(A)).versions.pop();
    url = A + '/' + v + '/latest/download';
  } else if (type === 'fabric') {
    const F = 'https://meta.fabricmc.net/v2/versions', [l, i] = await Promise.all([J(F + '/loader'), J(F + '/installer')]);
    url = F + '/loader/' + v + '/' + l.find(x => x.stable).version + '/' + i.find(x => x.stable).version + '/server/jar';
  }
  const mv = man.versions.find(x => x.id === v); if (!mv) throw new Error('Onbekende versie: ' + v);
  const meta = await J(mv.url); if (type === 'vanilla') url = meta.downloads.server.url;
  return { version: v, url, java: (meta.javaVersion && meta.javaVersion.majorVersion) || 21 };
}
const javaMajor = bin => new Promise(r => execFile(bin, ['-version'], (e, so, se) => { const m = /version "(\d+)/.exec(se || so || ''); r(m ? +m[1] : 0); }));
function findJava(d) {
  if (!fs.existsSync(d)) return null;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = findJava(p); if (r) return r; }
    else if (f.name === (process.platform === 'win32' ? 'java.exe' : 'java') && path.basename(d) === 'bin') return p;
  }
  return null;
}
async function ensureJava(need) {
  for (const bin of [findJava(JRE), 'java'].filter(Boolean)) if (await javaMajor(bin) >= need) return bin;
  log('Java ' + need + ' wordt gedownload (eenmalig)...');
  const plat = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform], arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const f = path.join(DATA, 'java.' + (plat === 'windows' ? 'zip' : 'tar.gz'));
  fs.rmSync(JRE, { recursive: true, force: true }); fs.mkdirSync(JRE, { recursive: true });
  await download('https://api.adoptium.net/v3/binary/latest/' + need + '/ga/' + plat + '/' + arch + '/jre/hotspot/normal/eclipse', f, 'Java ' + need);
  await new Promise((ok, no) => execFile('tar', ['-xf', f, '-C', JRE], e => e ? no(e) : ok()));
  fs.unlinkSync(f); const j = findJava(JRE); if (!j) throw new Error('Java installeren mislukt'); return j;
}
const props = o => ['motd=' + String(o.motd || 'Welkom!').replace(/[\r\n]+/g, ' '), 'server-port=' + (+o.port || 25565), 'max-players=' + (+o.max || 10),
  'gamemode=' + pick(o.gamemode, ['survival', 'creative', 'adventure', 'spectator'], 'survival'), 'difficulty=' + pick(o.difficulty, ['peaceful', 'easy', 'normal', 'hard'], 'normal'),
  'online-mode=' + (o.online !== false), 'pvp=' + (o.pvp !== false), 'view-distance=10'].join('\n') + '\n';
function memOf(pid, cb) {
  if (process.platform === 'win32') exec('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', (e, o) => { const m = /"([\d.,\s]+) K"/.exec(o || ''); cb(m ? parseInt(m[1].replace(/\D/g, '')) / 1024 : 0); });
  else execFile('ps', ['-o', 'rss=', '-p', String(pid)], (e, o) => cb(parseInt(o) / 1024 || 0));
}

// ---- installatie (met automatische back-up voor een server-update)
async function install(o) {
  if (S.busy || S.proc || S.starting) throw new Err(409, 'Bezig of server draait');
  if (!o.eula) throw new Err(400, 'Accepteer eerst de Minecraft EULA');
  S.busy = 'Installeren'; S.status = 'installing'; push();
  try {
    const type = pick(o.type, ['paper', 'purpur', 'vanilla', 'fabric'], 'paper'), ver = /^[\w.\-]+$/.test(o.version || '') ? o.version : 'latest';
    log('Versies ophalen...'); const r = await resolve(type, ver); log('Gevonden: ' + type + ' ' + r.version);
    if (fs.existsSync(path.join(SRV, 'server.jar')) && fs.readdirSync(SRV).length > 3) { log('Back-up maken voor de update...'); await makeBackup({ scope: 'full', trigger: 'pre-update', label: 'Voor update naar ' + r.version }); }
    const java = await ensureJava(r.java); log('Java: ' + java);
    await download(r.url, path.join(SRV, 'server.jar.tmp'), 'Server');
    fs.renameSync(path.join(SRV, 'server.jar.tmp'), path.join(SRV, 'server.jar'));
    const pf = path.join(SRV, 'server.properties'); if (!fs.existsSync(pf)) fs.writeFileSync(pf, props(o));
    fs.writeFileSync(path.join(SRV, 'eula.txt'), 'eula=true\n');
    cfg = { type, version: r.version, ram: Math.max(1, +o.ram || 4), port: +o.port || 25565, max: +o.max || 10, java, flags: !!o.aikar };
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 1)); S.status = 'offline'; log('Installatie klaar. Klik op Start.', 'ok');
  } catch (e) { S.status = cfg ? 'offline' : 'setup'; log('Mislukt: ' + e.message, 'e'); }
  finally { S.busy = false; push(); }
}

// ---- console-regels, spelers, interne commando's
const send = c => { if (S.proc && S.proc.stdin.writable) { S.proc.stdin.write(c + '\n'); return true; } return false; };
const ask = (cmd, re, ms = 10000, hide = false) => new Promise((ok, no) => {
  if (!S.proc || !S.proc.stdin.writable) return no(new Error('Server draait niet'));
  const w = { re, hide, ok, t: setTimeout(() => { const i = W.indexOf(w); if (i >= 0) W.splice(i, 1); no(new Error('Geen antwoord van de server op "' + cmd + '"')); }, ms) };
  W.push(w); S.proc.stdin.write(cmd + '\n');
});
const unit = (n, u) => +n * ({ K: 1 / 1024, M: 1, G: 1024 }[u] || 1);
function line(t) {
  if (/^\[[\d.]+s\]\[\w+\s*\]\[gc/.test(t)) { const m = /(\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\)/.exec(t); if (m) M.heap = { used: unit(m[3], m[4]), total: unit(m[5], m[6]), at: Date.now() }; return; }
  for (let i = 0; i < W.length; i++) { const m = W[i].re.exec(t); if (m) { const w = W.splice(i, 1)[0]; clearTimeout(w.t); w.ok(m); if (w.hide) return; break; } }
  log(t, /\bWARN/.test(t) ? 'w' : /\bERROR|\bFATAL|Exception/.test(t) ? 'e' : /\bDEBUG/.test(t) ? 'd' : '');
  if (S.status === 'starting' && /\bDone \(/.test(t)) { S.status = 'online'; push(); }
  let m = /UUID of player (\.?\w{3,16}) is ([0-9a-f-]{32,36})/i.exec(t); if (m) { P.uuids[m[1]] = m[2]; savePl(); }
  m = /: (\.?\w{3,16}) joined the game/.exec(t); if (m) { S.players.add(m[1]); S.joined[m[1]] = Date.now(); P.hist.push({ t: Date.now(), name: m[1], type: 'join' }); savePl(); push(); emit('players', {}); }
  m = /: (\.?\w{3,16}) left the game/.exec(t); if (m) { S.players.delete(m[1]); delete S.joined[m[1]]; P.hist.push({ t: Date.now(), name: m[1], type: 'leave' }); savePl(); push(); emit('players', {}); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function start() {
  if (S.proc || S.starting || !cfg || S.busy) return false;
  const lk = parseInt(readTxt(LOCK)); if (lk && alive(lk)) throw new Err(409, 'Er draait al een Minecraft-proces (pid ' + lk + '). Stop dat eerst of verwijder data/server.lock.');
  S.starting = true;
  try {
    const jm = await javaMajor(cfg.java), a = ['-Xms' + cfg.ram + 'G', '-Xmx' + cfg.ram + 'G']; if (cfg.flags) a.push(...AIK); if (jm >= 11) a.push('-Xlog:gc:stdout'); a.push('-jar', 'server.jar', 'nogui');
    S.status = 'starting'; S.players.clear(); S.joined = {}; S.expected = false; M.heap = null; M.tps = null; log('Server starten...'); push();
    const p = spawn(cfg.java, a, { cwd: SRV }); S.proc = p; S.started = Date.now(); let buf = '';
    try { fs.writeFileSync(LOCK, String(p.pid)); } catch {}
    const feed = d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } };
    p.stdout.on('data', feed); p.stderr.on('data', feed); p.stdin.on('error', () => {});
    p.on('error', e => { log('Kon Java niet starten: ' + e.message, 'e'); S.proc = null; S.status = 'offline'; S.started = 0; fs.rmSync(LOCK, { force: true }); push(); });
    p.on('exit', (c, sig) => {
      if (S.proc !== p) return; const expected = S.expected; S.expected = false;
      S.proc = null; S.status = 'offline'; S.started = 0; S.mem = 0; S.players.clear(); S.joined = {}; M.tps = null; fs.rmSync(LOCK, { force: true });
      for (const w of W.splice(0)) { clearTimeout(w.t); } 
      log('Server gestopt (' + (c === null ? 'signaal ' + sig : 'code ' + c) + ').', c === 0 || expected ? '' : 'e'); push(); emit('players', {});
      if (!expected && c !== 0) crashed(c, sig);
      if (S.after) { const f = S.after; S.after = null; f(); }
    });
    return true;
  } finally { S.starting = false; }
}
function stop(then) {
  const p = S.proc; if (!p) { if (then) then(); return; }
  S.expected = true; S.status = 'stopping'; S.after = then || null; push(); send('stop');
  setTimeout(() => { if (S.proc === p) { log('Server reageert niet, geforceerd stoppen.', 'w'); p.kill(); } }, 45000);
}
function forceStop() { const p = S.proc; if (!p) return; S.expected = true; S.after = null; S.status = 'stopping'; log('Server wordt geforceerd gestopt.', 'w'); push(); p.kill('SIGKILL'); }
function crashed(c, sig) {
  const name = 'crash-' + stamp() + '.txt'; let extra = '';
  try { const d = path.join(SRV, 'crash-reports'), f = fs.readdirSync(d).filter(x => x.endsWith('.txt')).map(x => ({ x, t: fs.statSync(path.join(d, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0]; if (f && Date.now() - f.t < 120000) extra = '\n\n===== ' + f.x + ' =====\n' + fs.readFileSync(path.join(d, f.x), 'utf8').slice(0, 30000); } catch {}
  const body = 'Blokwerk ' + VERSION + ' - crashlog\nTijdstip: ' + new Date().toISOString() + '\nServer: ' + (cfg ? cfg.type + ' ' + cfg.version : '?') + '\nAfsluitcode: ' + (c === null ? 'signaal ' + sig : c) + '\n\n===== Laatste 300 consoleregels =====\n' + logs.slice(-300).map(l => '[' + l.t + '] ' + l.m).join('\n') + extra + '\n';
  try { fs.writeFileSync(path.join(CRASH, name), body); const all = fs.readdirSync(CRASH).sort(); for (const f of all.slice(0, Math.max(0, all.length - 50))) fs.rmSync(path.join(CRASH, f), { force: true }); } catch {}
  log('Server is gecrasht. Crashlog opgeslagen: ' + name, 'e'); emit('crash', { name });
  if (!app.crashRestart) return;
  S.crashes = S.crashes.filter(x => Date.now() - x < 600e3); S.crashes.push(Date.now());
  if (S.crashes.length > 3) return log('Meer dan 3 crashes in 10 minuten: automatisch herstarten is gestopt.', 'e');
  log('Automatisch herstarten over 10 seconden...', 'w'); setTimeout(() => { if (!S.proc && S.status === 'offline') start().catch(e => log(e.message, 'e')); }, 10000);
}
const sh = pexec;
async function procInfo(pid) {
  if (process.platform === 'linux') {
    try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), f = s.slice(s.lastIndexOf(')') + 2).split(' '); return { rss: +f[21] * 4096 / 1048576, sec: (+f[11] + +f[12]) / 100 }; } catch { return null; }
  }
  if (process.platform === 'win32') return { rss: await sh(k => memOf(pid, k)), sec: null };
  return new Promise(r => execFile('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], (e, o) => { const [a, b] = String(o || '').trim().split(/\s+/).map(Number); r(e || !a ? null : { rss: a / 1024, pcpu: b || 0 }); }));
}
async function netNow() {
  try {
    if (process.platform === 'linux') { let rx = 0, tx = 0; for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) { const [n, v] = l.split(':'); if (!v || n.trim() === 'lo') continue; const f = v.trim().split(/\s+/); rx += +f[0]; tx += +f[8]; } return { rx, tx }; }
    if (process.platform === 'darwin') { const o = await run('netstat', ['-ib']); let rx = 0, tx = 0; for (const l of o.split('\n')) { const f = l.trim().split(/\s+/); if (f.length >= 11 && /^<Link#/.test(f[2]) && !/^lo/.test(f[0])) { rx += +f[6] || 0; tx += +f[9] || 0; } } return { rx, tx }; }
    const o = await run('netstat', ['-e']), m = /(?:ytes)\s+(\d+)\s+(\d+)/.exec(o); return m ? { rx: +m[1], tx: +m[2] } : null;
  } catch { return null; }
}
async function cpuTemp() {
  if (process.platform !== 'linux') return null;
  try { let best = null; for (const z of fs.readdirSync('/sys/class/thermal').filter(x => x.startsWith('thermal_zone'))) { const v = parseInt(readTxt('/sys/class/thermal/' + z + '/temp')) / 1000; if (v > 0 && v < 130 && (best === null || v > best)) best = v; } return best; } catch { return null; }
}
const cpuT = () => { let i = 0, t = 0; for (const c of os.cpus()) { for (const k in c.times) t += c.times[k]; i += c.times.idle; } return { i, t }; };
async function sample() {
  const now = Date.now(), c = cpuT(), mt = os.totalmem(), mf = os.freemem(); let cpu = 0;
  if (M.cpu) { const dt = c.t - M.cpu.t; cpu = dt ? 100 * (1 - (c.i - M.cpu.i) / dt) : 0; } M.cpu = c;
  const s = { t: now, cpu: +cpu.toFixed(1), mem: Math.round((mt - mf) / 1048576), memT: Math.round(mt / 1048576), pcpu: null, prss: null, heapU: null, heapT: null, disk: null, diskT: null, up: null, down: null, tps: M.tps, players: S.players.size };
  if (S.proc) {
    const pi = await procInfo(S.proc.pid);
    if (pi) { s.prss = Math.round(pi.rss); S.mem = pi.rss; const n = os.cpus().length || 1;
      if (pi.sec != null) { if (M.pp) { const dt = (now - M.pp.at) / 1000; if (dt > 0) s.pcpu = +Math.max(0, (pi.sec - M.pp.sec) / dt * 100 / n).toFixed(1); } M.pp = { sec: pi.sec, at: now }; } else if (pi.pcpu != null) s.pcpu = +(pi.pcpu / n).toFixed(1); }
    if (M.heap) { s.heapU = Math.round(M.heap.used); s.heapT = Math.round(M.heap.total); }
  } else M.pp = null;
  const nn = await netNow(); if (nn && M.net) { const dt = (now - M.net.at) / 1000; if (dt > 0) { s.down = Math.max(0, Math.round((nn.rx - M.net.rx) / dt)); s.up = Math.max(0, Math.round((nn.tx - M.net.tx) / dt)); } } if (nn) M.net = { ...nn, at: now };
  try { if (fs.promises.statfs) { const d = await fs.promises.statfs(DATA); s.diskT = Math.round(d.blocks * d.bsize / 1048576); s.disk = Math.round((d.blocks - d.bavail) * d.bsize / 1048576); } } catch {}
  if (now - M.sizeAt > 120000) { M.sizeAt = now; dirSize(SRV).then(n => { M.srvSize = n; }); }
  s.srv = Math.round(M.srvSize / 1048576); s.temp = await cpuTemp();
  const al = [], ram = cfg ? cfg.ram * 1024 : 0;
  if (S.proc && s.heapU && s.heapT && s.heapU / s.heapT > 0.9) al.push({ k: 'heap', l: 'w', m: 'Java-heap bijna vol (' + Math.round(s.heapU / s.heapT * 100) + '%). Overweeg meer geheugen.' });
  if (S.proc && s.prss && ram && s.prss > ram * 1.25) al.push({ k: 'rss', l: 'w', m: 'De server gebruikt veel meer geheugen dan ingesteld (' + (s.prss / 1024).toFixed(1) + ' GB).' });
  if (S.proc && s.tps != null && s.tps < 15) al.push({ k: 'tps', l: s.tps < 10 ? 'e' : 'w', m: 'Lage TPS: ' + s.tps.toFixed(1) + ' (normaal 20).' });
  if (s.mem / s.memT > 0.92) al.push({ k: 'sysmem', l: 'w', m: 'Het systeem heeft weinig vrij geheugen (' + Math.round(s.mem / s.memT * 100) + '% in gebruik).' });
  if (s.disk != null && s.diskT && (s.diskT - s.disk) < 2048) al.push({ k: 'disk', l: 'e', m: 'Minder dan 2 GB schijfruimte over.' });
  else if (s.disk != null && s.disk / s.diskT > 0.9) al.push({ k: 'disk', l: 'w', m: 'Schijf is voor ' + Math.round(s.disk / s.diskT * 100) + '% vol.' });
  for (const a of al) if (!M.alerts.some(x => x.k === a.k)) log('Waarschuwing: ' + a.m, 'w');
  M.alerts = al; M.last = s; M.hist.push(s); if (M.hist.length > 360) M.hist.shift(); emit('metrics', { s, alerts: al, uptime: S.started ? Math.floor((now - S.started) / 1000) : 0 });
}
setInterval(() => sample().catch(() => {}), 5000); sample().catch(() => {});
setInterval(async () => {
  if (S.status !== 'online' || !cfg || S.busy) return;
  try {
    if (cfg.type === 'paper' || cfg.type === 'purpur') { const m = await ask('tps', /TPS from last[^:]*:\s*\*?([\d.]+)/, 5000, true); M.tps = Math.min(20, +m[1]); }
    else if (!M.noTick) { const m = await ask('tick query', /Average time per tick: ([\d.]+)ms|Unknown or incomplete command|Unknown command/, 5000, true); if (m[1]) M.tps = Math.min(20, +(1000 / Math.max(+m[1], 50)).toFixed(1)); else M.noTick = true; }
  } catch { }
}, 15000);

// ---- geplande herstart en automatisch starten
let lastRestartDay = '';
setInterval(() => {
  if (!app.restartAt || S.status !== 'online') return;
  const d = new Date(), hm = d.toTimeString().slice(0, 5), day = d.toDateString();
  if (hm === app.restartAt && lastRestartDay !== day) {
    lastRestartDay = day; log('Geplande herstart over 60 seconden.', 'w'); send('say Server herstart over 60 seconden.');
    setTimeout(() => { if (S.status === 'online') stop(() => start().catch(e => log(e.message, 'e'))); }, 60000);
  }
}, 20000);
setTimeout(() => { if (app.autoStart && cfg && S.status === 'offline') { log('Automatisch starten...'); start().catch(e => log(e.message, 'e')); } }, 2500);
const newer = (a, b) => { const p = s => String(s).split('.').map(n => parseInt(n) || 0); for (let i = 0; i < 3; i++) { const d = (p(a)[i] || 0) - (p(b)[i] || 0); if (d) return d > 0; } return false; };
const okUrl = u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)[:\/]/.test(u);
async function checkUpdate() {
  U.error = ''; U.available = null;
  try {
    if (!app.updateUrl) throw new Error('Geen update-adres ingesteld');
    if (!okUrl(app.updateUrl)) throw new Error('Alleen https-adressen zijn toegestaan');
    const m = await J(app.updateUrl); if (!m.version || !m.files) throw new Error('Ongeldig update-bestand');
    if (newer(m.version, VERSION)) U.available = { version: m.version, notes: String(m.notes || '') };
  } catch (e) { U.error = e.message; }
  U.checked = Date.now(); push();
}
async function applyUpdate() {
  if (S.proc || S.busy) throw new Error('Stop eerst de Minecraft-server');
  if (!okUrl(app.updateUrl || '')) throw new Error('Geen geldig update-adres');
  const m = await J(app.updateUrl); if (!newer(m.version, VERSION)) throw new Error('Al up-to-date');
  const tmp = path.join(DATA, 'update'), bak = path.join(DATA, 'backup', VERSION);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(bak, { recursive: true });
  for (const f of FILES) {
    const e = m.files[f]; if (!e) continue;
    const u = new URL(e.url, app.updateUrl).href; if (!okUrl(u)) throw new Error(f + ': onveilig adres');
    const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(b).digest('hex') !== e.sha256) throw new Error(f + ': controlegetal klopt niet, update afgebroken');
    fs.writeFileSync(path.join(tmp, f), b);
  }
  if (fs.existsSync(path.join(tmp, 'blokwerk.js'))) await new Promise((ok, no) => execFile(process.execPath, ['--check', path.join(tmp, 'blokwerk.js')], e => e ? no(new Error('Nieuwe versie is ongeldig, update afgebroken')) : ok()));
  for (const f of fs.readdirSync(tmp)) { fs.copyFileSync(path.join(ROOT, f), path.join(bak, f)); fs.copyFileSync(path.join(tmp, f), path.join(ROOT, f)); }
  fs.rmSync(tmp, { recursive: true, force: true }); log('Update naar ' + m.version + ' geïnstalleerd. Blokwerk herstart...', 'ok');
  const code = process.env.BLOKWERK_LOOP ? 42 : 0, bye = () => process.exit(code);
  setTimeout(() => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(bye); setTimeout(bye, 2000); }, 500);
}


// ---- jar/zip lezen zonder dependencies (alleen metadata van mods en plugins)
function zipRead(file) {
  const fd = fs.openSync(file, 'r'); let okz = false;
  try {
    const st = fs.fstatSync(fd), tail = Buffer.alloc(Math.min(st.size, 65557)); fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
    const i = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); if (i < 0) throw new Error('Geen geldig JAR/ZIP-bestand');
    const n = tail.readUInt16LE(i + 10), cs = tail.readUInt32LE(i + 12), co = tail.readUInt32LE(i + 16), cd = Buffer.alloc(cs); fs.readSync(fd, cd, 0, cs, co);
    const ents = {}; let p = 0;
    for (let k = 0; k < n && p + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      ents[cd.toString('utf8', p + 46, p + 46 + nl)] = { m: cd.readUInt16LE(p + 10), cs: cd.readUInt32LE(p + 20), us: cd.readUInt32LE(p + 24), off: cd.readUInt32LE(p + 42) }; p += 46 + nl + el + cl;
    }
    if (!Object.keys(ents).length) throw new Error('Leeg of beschadigd JAR-bestand');
    const get = name => { const e = ents[name]; if (!e || e.us > 2e6) return null; const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, e.off); const d = Buffer.alloc(e.cs); fs.readSync(fd, d, 0, e.cs, e.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28)); return (e.m === 8 ? zlib.inflateRawSync(d) : d).toString('utf8').replace(/^\uFEFF/, ''); };
    okz = true; return { ents, get, close: () => fs.closeSync(fd) };
  } finally { if (!okz) fs.closeSync(fd); }
}
const yv = (t, k) => { const m = new RegExp('^' + k + ':\\s*[\'"]?([^\'"\\r\\n#]+?)[\'"]?\\s*(?:#.*)?$', 'm').exec(t); return m ? m[1] : null; };
const tv = (t, k) => { const m = new RegExp('^\\s*' + k + '\\s*=\\s*"([^"]+)"', 'm').exec(t); return m ? m[1] : null; };
function jarInfo(file) { const z = zipRead(file); try { return jarInfo2(z); } finally { z.close(); } }
function jarInfo2(z) {
  const g = z.get, e = z.ents; let t;
  if (e['fabric.mod.json']) { const j = JSON.parse(g('fabric.mod.json')); return { loader: 'fabric', id: j.id, name: j.name || j.id, version: String(j.version || ''), mc: typeof (j.depends || {}).minecraft === 'string' ? j.depends.minecraft : Array.isArray((j.depends || {}).minecraft) ? j.depends.minecraft.join(' || ') : null }; }
  if (e['quilt.mod.json']) { const j = JSON.parse(g('quilt.mod.json')).quilt_loader || {}; return { loader: 'quilt', id: j.id, name: (j.metadata || {}).name || j.id, version: String(j.version || '') }; }
  if (e['META-INF/neoforge.mods.toml'] && (t = g('META-INF/neoforge.mods.toml'))) return { loader: 'neoforge', id: tv(t, 'modId'), name: tv(t, 'displayName') || tv(t, 'modId'), version: tv(t, 'version') };
  if (e['META-INF/mods.toml'] && (t = g('META-INF/mods.toml'))) return { loader: 'forge', id: tv(t, 'modId'), name: tv(t, 'displayName') || tv(t, 'modId'), version: tv(t, 'version') };
  if (e['mcmod.info']) { let j = []; try { j = JSON.parse(g('mcmod.info')); j = Array.isArray(j) ? j : j.modList || []; } catch {} return { loader: 'forge', id: (j[0] || {}).modid, name: (j[0] || {}).name, version: (j[0] || {}).version }; }
  const pl = e['paper-plugin.yml'] ? 'paper-plugin.yml' : e['plugin.yml'] ? 'plugin.yml' : null;
  if (pl) { t = g(pl); return { loader: 'bukkit', id: yv(t, 'name'), name: yv(t, 'name'), version: yv(t, 'version'), api: yv(t, 'api-version'), paper: pl === 'paper-plugin.yml' }; }
  return { loader: 'unknown' };
}
const vp = s => (String(s).match(/\d+|x|\*/g) || []).slice(0, 3).map(n => /\d/.test(n) ? +n : -1);
const vcmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] === -1 || b[i] === -1) return 0; const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
function mcOk(range, ver) { // Fabric-versiebereik, bijv. ">=1.20 <1.21", "~1.20.1", "1.20.x"
  const v = vp(ver); if (!range || !v.length) return true;
  return String(range).split('||').some(alt => alt.trim().split(/\s+/).every(tok => { const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(tok); if (!m) return true; const r = vp(m[2]), op = m[1] || '='; if (!r.length) return true;
    const c = vcmp(v, r); if (op === '>=') return c >= 0; if (op === '<=') return c <= 0; if (op === '>') return c > 0; if (op === '<') return c < 0;
    if (op === '~' || op === '^') return c >= 0 && vcmp(v.slice(0, 2), r.slice(0, 2)) === 0; return c === 0 || (m[2].indexOf('x') >= 0 || m[2].indexOf('*') >= 0) && vcmp(v, r) === 0; }));
}
const loaderDir = l => l === 'bukkit' ? 'plugins' : ['fabric', 'quilt', 'forge', 'neoforge'].includes(l) ? 'mods' : null;
function compat(info, dir) {
  const w = [], t = cfg && cfg.type, ver = cfg && cfg.version;
  if (info.loader === 'unknown') w.push('Geen mod- of pluginbeschrijving gevonden; het bestand kan een bibliotheek zijn of niet werken.');
  else if (!cfg) return w;
  else if (t === 'vanilla') w.push('Vanilla-servers kunnen geen mods of plugins laden.');
  else if (info.loader === 'bukkit' && t === 'fabric') w.push('Dit is een Bukkit/Paper-plugin; een Fabric-server laadt alleen Fabric-mods.');
  else if (info.loader === 'bukkit' && info.paper && t !== 'paper' && t !== 'purpur') w.push('Dit is een Paper-plugin en werkt alleen op Paper of Purpur.');
  else if (info.loader === 'bukkit') { if (info.api && vcmp(vp(info.api), vp(ver)) > 0) w.push('Vereist Minecraft-API ' + info.api + ', de server is ' + ver + '.'); }
  else if (info.loader === 'fabric' && t !== 'fabric') w.push('Dit is een Fabric-mod; deze server is ' + t + '.');
  else if (info.loader === 'quilt') w.push('Quilt-mod: werkt alleen op een Quilt-server of soms op Fabric.');
  else if (info.loader === 'forge' || info.loader === 'neoforge') w.push((info.loader === 'forge' ? 'Forge' : 'NeoForge') + '-mod: Blokwerk kan alleen Paper, Purpur, Vanilla en Fabric installeren, dus deze mod wordt niet geladen.');
  if (info.loader === 'fabric' && t === 'fabric' && info.mc && !mcOk(info.mc, ver)) w.push('Bedoeld voor Minecraft ' + info.mc + ', de server is ' + ver + '.');
  if (dir && loaderDir(info.loader) && loaderDir(info.loader) !== dir) w.push('Staat in ' + dir + '/, maar hoort in ' + loaderDir(info.loader) + '/.');
  return w;
}
const shaCache = new Map();
function sha(f, st) { const k = f + st.size + st.mtimeMs, c = shaCache.get(k); if (c) return c; const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); shaCache.set(k, h); return h; }
function listMods() {
  const out = [];
  for (const dir of ['mods', 'plugins']) {
    let fl = []; try { fl = fs.readdirSync(path.join(SRV, dir)); } catch { continue; }
    for (const f of fl) {
      if (!/\.jar(\.disabled)?$/i.test(f)) continue; const p = path.join(SRV, dir, f); let st; try { st = fs.statSync(p); if (!st.isFile()) continue; } catch { continue; }
      const it = { dir, file: f, enabled: !/\.disabled$/i.test(f), size: st.size, mtime: st.mtimeMs, sha: sha(p, st), warn: [], info: { loader: 'unknown' } };
      try { it.info = jarInfo(p); } catch (e) { it.warn.push('Kon het bestand niet lezen: ' + e.message); }
      it.warn.push(...compat(it.info, dir)); out.push(it);
    }
  }
  for (const a of out) {
    const same = out.filter(b => b !== a && b.sha === a.sha); if (same.length) { a.dup = 'same'; a.warn.push('Exact hetzelfde bestand als ' + same.map(b => b.dir + '/' + b.file).join(', ') + '.'); }
    const ver = out.filter(b => b !== a && b.sha !== a.sha && a.info.id && b.info.id === a.info.id && b.info.loader === a.info.loader); if (ver.length) { a.dup = a.dup || 'id'; a.warn.push('Zelfde ' + (a.info.loader === 'bukkit' ? 'plugin' : 'mod') + ' ("' + a.info.id + '") staat er in meerdere versies in: ' + ver.map(b => b.file).join(', ') + '.'); }
  }
  return out;
}
const modName = f => { if (typeof f !== 'string' || !/^[^\/\\\0:*?"<>|]{1,200}\.jar(\.disabled)?$/i.test(f) || f.startsWith('.')) throw new Err(400, 'Ongeldige bestandsnaam'); return f; };
const modPath = (dir, f) => { if (!['mods', 'plugins'].includes(dir)) throw new Err(400, 'Ongeldige map'); return path.join(SRV, dir, modName(f)); };

// ---- bestandsbeheer: alles blijft binnen data/server
const SENS = /(^|\/)(\.env[^\/]*|[^\/]*\.(pem|key|p12|pfx|jks|keystore|kdbx)|id_(rsa|ed25519|ecdsa)[^\/]*|[^\/]*(credentials|secret)[^\/]*|\.git(\/.*)?|\.ssh(\/.*)?)$/i;
const PROT = new Set(['server.jar', 'eula.txt']); // niet verwijderbaar/hernoembaar
function safe(rel) {
  rel = String(rel || '').replace(/\0/g, '').replace(/\\/g, '/'); if (rel.length > 1000) throw new Err(400, 'Pad te lang');
  const p = path.resolve(SRV, '.' + path.sep + rel);
  if (p !== SRV && !p.startsWith(SRV + path.sep)) throw new Err(403, 'Pad valt buiten de serverfolder');
  let q = p; while (!fs.existsSync(q)) q = path.dirname(q);
  const rq = fs.realpathSync(q), rs = fs.realpathSync(SRV); if (rq !== rs && !rq.startsWith(rs + path.sep)) throw new Err(403, 'Pad valt buiten de serverfolder');
  return p;
}
const relOf = p => path.relative(SRV, p).split(path.sep).join('/');
const locked = rel => SENS.test(rel);
const EDIT = /\.(txt|json|json5|yml|yaml|properties|toml|cfg|conf|ini|xml|csv|md|mcmeta|mcfunction|lang|snbt|log|sh|bat|secret)$/i;
const UPX = new Set('jar zip gz tgz png jpg jpeg json yml yaml properties txt toml cfg conf ini xml csv md mcmeta mcfunction lang snbt dat nbt mca schem schematic litematic'.split(' '));
const MAGIC = { jar: [0x50, 0x4b], zip: [0x50, 0x4b], png: [0x89, 0x50, 0x4e, 0x47], gz: [0x1f, 0x8b], tgz: [0x1f, 0x8b], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff] };
const BIN = new Set('dat nbt mca schem schematic litematic'.split(' '));
function sniff(file, ext) {
  const fd = fs.openSync(file, 'r'), b = Buffer.alloc(4096), n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); const h = b.subarray(0, n);
  if (MAGIC[ext]) return MAGIC[ext].every((x, i) => h[i] === x);
  if (BIN.has(ext)) return true;
  if (h.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(h.subarray(0, n < 4096 ? n : n - 3)); return true; } catch { return false; }
}
const cleanName = n => { n = String(n || '').trim(); if (!n || n.length > 200 || /[\/\\\0:*?"<>|]/.test(n) || /^\.+$/.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) throw new Err(400, 'Ongeldige bestandsnaam'); return n; };
function snap(abs) { // kopie van het oude bestand bewaren voordat het wordt overschreven
  try { if (!fs.statSync(abs).isFile()) return; const d = path.join(HIST, relOf(abs).replace(/\//g, '__')); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(abs, path.join(d, stamp() + '.bak'));
    const all = fs.readdirSync(d).sort(); for (const f of all.slice(0, Math.max(0, all.length - 15))) fs.rmSync(path.join(d, f), { force: true }); } catch {}
}
const MASK = '********', SECRET = /(password|secret|token)/i;
const maskProps = t => t.replace(/^([ \t]*[^#!\s=][^=]*?)=(.+)$/gm, (a, k, v) => SECRET.test(k) ? k + '=' + MASK : a);
function unmask(t, old) { const o = parseProps(old); return t.replace(/^([ \t]*[^#!\s=][^=]*?)=(.*)$/gm, (a, k, v) => SECRET.test(k) && v.trim() === MASK ? k + '=' + (o[k.trim()] || '') : a); }
const LISTS = { 'whitelist.json': ['uuid', 'name'], 'ops.json': ['uuid', 'name'], 'banned-players.json': ['uuid', 'name'], 'banned-ips.json': ['ip'] };
function validate(rel, txt) {
  const b = path.basename(rel).toLowerCase(), ext = path.extname(b).slice(1);
  if (LISTS[b]) { let j; try { j = JSON.parse(txt || '[]'); } catch (e) { return 'Ongeldige JSON: ' + e.message; } if (!Array.isArray(j)) return 'Dit bestand moet een lijst ([ ... ]) zijn';
    for (const [i, x] of j.entries()) { for (const k of LISTS[b]) if (!x || typeof x[k] !== 'string' || !x[k]) return 'Item ' + (i + 1) + ': veld "' + k + '" ontbreekt'; if (x.uuid && !/^[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}$/i.test(x.uuid)) return 'Item ' + (i + 1) + ': ongeldige UUID'; } return null; }
  if (ext === 'json' || ext === 'mcmeta') { try { JSON.parse(txt); } catch (e) { return 'Ongeldige JSON: ' + e.message; } return null; }
  if (b === 'eula.txt') return /^\s*eula\s*=\s*(true|false)\s*$/m.test(txt) ? null : 'De regel eula=true of eula=false ontbreekt';
  if (ext === 'yml' || ext === 'yaml') { const l = txt.split(/\r?\n/); for (let i = 0; i < l.length; i++) if (/^ *\t/.test(l[i])) return 'Regel ' + (i + 1) + ': YAML mag geen tabs bevatten, gebruik spaties'; return null; }
  if (ext === 'properties') { const l = txt.split(/\r?\n/); for (let i = 0; i < l.length; i++) if (l[i].trim() && !/^\s*[#!]/.test(l[i]) && !/[=:]/.test(l[i])) return 'Regel ' + (i + 1) + ': verwacht sleutel=waarde'; return null; }
  if (ext === 'toml') { const l = txt.split(/\r?\n/); for (let i = 0; i < l.length; i++) { const s = l[i].trim(); if (s.startsWith('[') && !/^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(s)) return 'Regel ' + (i + 1) + ': onvolledige sectie'; } return null; }
  return null;
}
function fileInfo(p) { const st = fs.statSync(p), rel = relOf(p); return { name: path.basename(p), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, locked: locked(rel), editable: !st.isDirectory() && EDIT.test(p) && !locked(rel) && st.size <= 2e6 }; }
function search(q, base, out, depth) {
  if (out.length >= 200 || depth > 12) return; let es; try { es = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = path.join(base, e.name); if (e.isSymbolicLink()) continue; if (e.name.toLowerCase().includes(q)) out.push({ ...fileInfo(p), path: relOf(p) }); if (e.isDirectory()) search(q, p, out, depth + 1); }
}

// ---- server.properties: schema met uitleg en validatie
const SCH = [
  ['motd', 'text', 'Het bericht in de serverlijst van spelers.', 'Algemeen'], ['max-players', 'int', 'Maximaal aantal spelers tegelijk.', 'Algemeen', 1, 1000],
  ['server-port', 'int', 'Poort waarop spelers verbinden (standaard 25565). Herstart nodig.', 'Algemeen', 1024, 65535], ['server-ip', 'text', 'Laat leeg om op alle netwerkkaarten te luisteren.', 'Algemeen'],
  ['enable-status', 'bool', 'Server verschijnt in de serverlijst met status en spelersaantal.', 'Algemeen'], ['hide-online-players', 'bool', 'Verberg de namen van online spelers in de serverlijst.', 'Algemeen'],
  ['gamemode', 'enum', 'Standaard spelmodus voor nieuwe spelers.', 'Spel', ['survival', 'creative', 'adventure', 'spectator']], ['force-gamemode', 'bool', 'Zet spelers bij elke join terug naar de standaard spelmodus.', 'Spel'],
  ['difficulty', 'enum', 'Moeilijkheidsgraad.', 'Spel', ['peaceful', 'easy', 'normal', 'hard']], ['hardcore', 'bool', 'Hardcore: spelers worden na hun dood toeschouwer.', 'Spel'],
  ['pvp', 'bool', 'Spelers kunnen elkaar schade doen.', 'Spel'], ['allow-flight', 'bool', 'Sta vliegen toe. Nodig voor sommige mods; anders worden vliegende spelers gekickt.', 'Spel'],
  ['allow-nether', 'bool', 'Netherportalen werken.', 'Spel'], ['enable-command-block', 'bool', 'Commandoblokken werken.', 'Spel'],
  ['spawn-monsters', 'bool', 'Vijandige mobs spawnen.', 'Spel'], ['spawn-animals', 'bool', 'Dieren spawnen.', 'Spel'], ['spawn-npcs', 'bool', 'Dorpelingen spawnen.', 'Spel'],
  ['spawn-protection', 'int', 'Straal rond spawn waarin alleen OP\'s mogen bouwen (0 = uit).', 'Spel', 0, 1000], ['player-idle-timeout', 'int', 'Minuten inactiviteit voor een kick (0 = nooit).', 'Spel', 0, 100000],
  ['op-permission-level', 'int', 'Standaardniveau voor nieuwe OP\'s (1-4).', 'Spel', 1, 4],
  ['generate-structures', 'bool', 'Dorpen, tempels e.d. genereren (alleen in nieuwe chunks).', 'Wereld'], ['level-type', 'text', 'Wereldtype, bijv. minecraft:normal of minecraft:flat.', 'Wereld'],
  ['level-seed', 'text', 'Seed voor een nieuwe wereld. Heeft geen effect op een bestaande wereld.', 'Wereld'], ['max-world-size', 'int', 'Maximale straal van de wereld in blokken.', 'Wereld', 1, 29999984],
  ['view-distance', 'int', 'Zichtafstand in chunks. Lager is lichter voor de server.', 'Prestaties', 3, 32], ['simulation-distance', 'int', 'Afstand in chunks waarbinnen mobs en gewassen actief zijn.', 'Prestaties', 3, 32],
  ['network-compression-threshold', 'int', 'Pakketgrootte vanaf waar gecomprimeerd wordt (-1 = nooit).', 'Prestaties', -1, 65535], ['max-tick-time', 'int', 'Milliseconden per tick waarna de watchdog de server stopt (-1 = uit).', 'Prestaties', -1, 2147483647],
  ['online-mode', 'bool', 'Controleert accounts bij Mojang. Uitzetten is onveilig: iedereen kan dan een andere naam gebruiken.', 'Beveiliging'], ['white-list', 'bool', 'Alleen spelers op de whitelist mogen joinen.', 'Beveiliging'],
  ['enforce-whitelist', 'bool', 'Zet spelers die van de whitelist gehaald zijn direct uit de server.', 'Beveiliging'], ['enable-rcon', 'bool', 'Externe console (RCON). Laat uit als je het niet nodig hebt.', 'Beveiliging'],
  ['rcon.port', 'int', 'Poort voor RCON.', 'Beveiliging', 1024, 65535], ['rcon.password', 'secret', 'RCON-wachtwoord (verborgen; laat staan om het te behouden).', 'Beveiliging'],
];
const SKEY = Object.fromEntries(SCH.map(s => [s[0], s]));
function propsOut() {
  const v = parseProps(readTxt(path.join(SRV, 'server.properties'))); for (const k in v) if (SECRET.test(k) && v[k]) v[k] = MASK;
  return { values: v, schema: SCH.map(s => ({ k: s[0], t: s[1], d: s[2], g: s[3], a: s[4], b: s[5] })), level: v['level-name'] || 'world' };
}
function propsIn(vals) {
  const f = path.join(SRV, 'server.properties'), old = readTxt(f), cur = parseProps(old), errs = {}, set = {};
  for (const [k, raw] of Object.entries(vals || {})) {
    if (!/^[\w.\-]{1,60}$/.test(k) || k === 'level-name') { errs[k] = 'Niet toegestaan'; continue; }
    let v = typeof raw === 'boolean' ? String(raw) : String(raw == null ? '' : raw); if (/[\r\n\0]/.test(v)) { errs[k] = 'Geen regeleinden toegestaan'; continue; } v = v.trim();
    const s = SKEY[k];
    if (SECRET.test(k) && v === MASK) continue;
    if (s) { if (s[1] === 'bool' && !/^(true|false)$/.test(v)) errs[k] = 'Kies aan of uit'; else if (s[1] === 'int') { if (!/^-?\d+$/.test(v) || +v < s[4] || +v > s[5]) errs[k] = 'Geef een geheel getal tussen ' + s[4] + ' en ' + s[5]; } else if (s[1] === 'enum' && !s[4].includes(v)) errs[k] = 'Kies een geldige waarde'; else if (v.length > 400) errs[k] = 'Te lang'; }
    else if (v.length > 400) errs[k] = 'Te lang';
    if (cur[k] !== v) set[k] = v;
  }
  if (Object.keys(errs).length) throw Object.assign(new Err(400, 'Controleer de gemarkeerde instellingen'), { fields: errs });
  if (!Object.keys(set).length) return { changed: 0 };
  snap(f); const lines = old.split(/\r?\n/), seen = new Set();
  const out = lines.map(l => { const i = l.indexOf('='); if (i < 0 || /^\s*[#!]/.test(l)) return l; const k = l.slice(0, i).trim(); if (k in set) { seen.add(k); return k + '=' + set[k]; } return l; });
  while (out.length && out[out.length - 1] === '') out.pop(); for (const k in set) if (!seen.has(k)) out.push(k + '=' + set[k]);
  fs.writeFileSync(f, out.join('\n') + '\n');
  if (cfg && (set['server-port'] || set['max-players'])) { if (set['server-port']) cfg.port = +set['server-port']; if (set['max-players']) cfg.max = +set['max-players']; fs.writeFileSync(CFG, JSON.stringify(cfg, null, 1)); push(); }
  return { changed: Object.keys(set).length, restart: S.status !== 'offline' };
}

// ---- spelers
const NAME = /^\.?\w{3,16}$/;
const rdList = f => { const j = jr(path.join(SRV, f), []); return Array.isArray(j) ? j : []; };
function playersOut() {
  const cache = rdList('usercache.json'), uu = { ...P.uuids }; for (const c of cache) if (c && c.name && c.uuid) uu[c.name] = c.uuid;
  const seen = {}; for (const h of P.hist) { const s = seen[h.name] || (seen[h.name] = { name: h.name, joins: 0 }); s.last = h.t; if (h.type === 'join') { s.joins++; s.first = s.first || h.t; } }
  for (const c of cache) if (c && c.name && !seen[c.name]) seen[c.name] = { name: c.name, joins: 0, last: c.expiresOn ? Date.parse(c.expiresOn) - 30 * 864e5 || null : null };
  const props = parseProps(readTxt(path.join(SRV, 'server.properties')));
  return { online: [...S.players].map(n => ({ name: n, uuid: uu[n] || null, since: S.joined[n] || null })), history: P.hist.slice(-150).reverse(), seen: Object.values(seen).map(s => ({ ...s, uuid: uu[s.name] || null, online: S.players.has(s.name) })).sort((a, b) => (b.last || 0) - (a.last || 0)),
    banned: rdList('banned-players.json'), bannedIps: rdList('banned-ips.json'), whitelist: rdList('whitelist.json'), ops: rdList('ops.json'), whitelistOn: props['white-list'] === 'true', running: S.status === 'online' };
}
const reason = r => String(r || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 100);
function editList(file, fn) { const f = path.join(SRV, file); const j = rdList(file); const r = fn(j); snap(f); fs.writeFileSync(f, JSON.stringify(r, null, 2) + '\n'); }
function playerAction(o) {
  const a = o.action, n = String(o.name || ''), on = S.status === 'online';
  if (['whitelist-on', 'whitelist-off', 'whitelist-reload'].includes(a)) { if (!on) throw new Err(409, 'Server moet online zijn'); send(a === 'whitelist-on' ? 'whitelist on' : a === 'whitelist-off' ? 'whitelist off' : 'whitelist reload'); return; }
  if (a === 'pardon-ip') { const ip = String(o.name || ''); if (!/^[\da-fA-F.:]{3,45}$/.test(ip)) throw new Err(400, 'Ongeldig IP-adres'); if (on) send('pardon-ip ' + ip); else editList('banned-ips.json', j => j.filter(x => x.ip !== ip)); return; }
  if (!NAME.test(n)) throw new Err(400, 'Ongeldige spelersnaam');
  if (!['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist-add', 'whitelist-remove'].includes(a)) throw new Err(400, 'Onbekende actie');
  if (!on) { // zonder draaiende server kunnen we alleen dingen verwijderen
    if (a === 'pardon') return editList('banned-players.json', j => j.filter(x => String(x.name).toLowerCase() !== n.toLowerCase()));
    if (a === 'deop') return editList('ops.json', j => j.filter(x => String(x.name).toLowerCase() !== n.toLowerCase()));
    if (a === 'whitelist-remove') return editList('whitelist.json', j => j.filter(x => String(x.name).toLowerCase() !== n.toLowerCase()));
    throw new Err(409, 'Deze actie werkt alleen als de server online is.');
  }
  const r = reason(o.reason), cmd = { kick: 'kick', ban: 'ban', pardon: 'pardon', op: 'op', deop: 'deop', 'whitelist-add': 'whitelist add', 'whitelist-remove': 'whitelist remove' }[a];
  send(cmd + ' ' + n + ((a === 'kick' || a === 'ban') && r ? ' ' + r : '')); log('> ' + cmd + ' ' + n, 'u');
}

// ---- NBT (alleen om level.dat te lezen: naam, versie, seed)
function nbt(buf) {
  let p = 0;
  const rd = t => {
    switch (t) {
      case 1: return buf.readInt8(p++); case 2: { const v = buf.readInt16BE(p); p += 2; return v; } case 3: { const v = buf.readInt32BE(p); p += 4; return v; }
      case 4: { const v = buf.readBigInt64BE(p); p += 8; return v; } case 5: { const v = buf.readFloatBE(p); p += 4; return v; } case 6: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 7: { const n = buf.readInt32BE(p); p += 4 + n; return null; }
      case 8: { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; }
      case 9: { const it = buf.readInt8(p++), n = buf.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(rd(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = buf.readInt8(p++); if (!tt) break; const n = buf.readUInt16BE(p); p += 2; const k = buf.toString('utf8', p, p + n); p += n; o[k] = rd(tt); } return o; }
      case 11: { const n = buf.readInt32BE(p); p += 4 + 4 * n; return null; } case 12: { const n = buf.readInt32BE(p); p += 4 + 8 * n; return null; }
    }
    throw new Error('NBT');
  };
  if (buf[0] !== 10) throw new Error('NBT'); p = 1; p += 2 + buf.readUInt16BE(p); return rd(10);
}
function levelInfo(dir) {
  try { const d = nbt(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'level.dat')))).Data || {}, g = (d.WorldGenSettings || {});
    const seed = g.seed != null ? g.seed : d.RandomSeed; return { levelName: d.LevelName || null, version: (d.Version || {}).Name || null, seed: seed != null ? String(seed) : null, lastPlayed: d.LastPlayed != null ? Number(d.LastPlayed) : null, hardcore: !!d.hardcore, gameType: d.GameType != null ? ['survival', 'creative', 'adventure', 'spectator'][d.GameType] || null : null };
  } catch { return {}; }
}
const wCache = new Map();
async function cachedSize(p) { const c = wCache.get(p); if (c && Date.now() - c.t < 60000) return c.n; const n = await dirSize(p); wCache.set(p, { n, t: Date.now() }); return n; }
async function listWorlds() {
  const lv = levelName(), es = fs.readdirSync(SRV, { withFileTypes: true }).filter(e => e.isDirectory()), names = new Set(es.map(e => e.name)), out = [];
  for (const e of es) {
    const dir = path.join(SRV, e.name); if (!fs.existsSync(path.join(dir, 'level.dat'))) continue;
    const folders = [e.name], dims = []; let nested = 0;
    for (const [id, sub, sib] of [['nether', 'DIM-1', e.name + '_nether'], ['end', 'DIM1', e.name + '_the_end']]) {
      if (names.has(sib)) { folders.push(sib); dims.push({ id, folder: sib, size: await cachedSize(path.join(SRV, sib)) }); }
      else if (fs.existsSync(path.join(dir, sub))) { const s = await cachedSize(path.join(dir, sub)); nested += s; dims.push({ id, folder: e.name + '/' + sub, size: s }); }
    }
    const total = await cachedSize(dir); dims.unshift({ id: 'overworld', folder: e.name, size: Math.max(0, total - nested) });
    let size = 0; for (const f of folders) size += await cachedSize(path.join(SRV, f)); let mt = 0; try { mt = fs.statSync(path.join(dir, 'level.dat')).mtimeMs; } catch {}
    out.push({ name: e.name, active: e.name === lv, size, folders, dims, mtime: mt, ...levelInfo(dir) });
  }
  return out.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}

// ---- back-ups (tar.gz), consistent via save-off / save-all flush
const bIdx = () => jr(BIDX, []), bSave = a => fs.writeFileSync(BIDX, JSON.stringify(a, null, 1));
const bFile = r => { if (!r || !/^[\w.\-]+\.tar\.gz$/.test(r.file)) throw new Err(404, 'Back-up niet gevonden'); return path.join(BAK, r.file); };
async function makeBackup({ scope = 'full', world, trigger = 'manual', label = '' }) {
  if (S.status === 'starting' || S.status === 'stopping') throw new Err(409, 'Wacht tot de server online of offline is');
  let dirs = ['.'], excl = ['logs'];
  if (scope === 'world') { const w = (await listWorlds()).find(x => x.name === world); if (!w) throw new Err(404, 'Wereld niet gevonden'); dirs = w.folders; excl = []; }
  const id = stamp() + '-' + crypto.randomBytes(2).toString('hex'), file = (scope === 'world' ? 'wereld-' + world.replace(/[^\w\-]+/g, '_') : 'volledig') + '-' + id + '.tar.gz', out = path.join(BAK, file + '.part');
  const live = S.proc && S.status === 'online'; let off = false;
  if (live) { send('save-off'); off = true; try { await ask('save-all flush', /Saved the (game|world)/, 180000); } catch (e) { send('save-on'); throw new Error('Kon de wereld niet veilig opslaan: ' + e.message); } }
  try {
    try { await run('tar', ['-czf', out, ...excl.map(x => '--exclude=' + x), '-C', SRV, ...dirs]); }
    catch (e) { if (!(e.code === 1 && /changed as we read/.test(e.se))) throw e; log('Back-up: een bestand veranderde tijdens het lezen; de inhoud is gecontroleerd.', 'w'); }
    await run('tar', ['-tzf', out]); // integriteitscontrole
  } catch (e) { fs.rmSync(out, { force: true }); throw new Error('Back-up mislukt: ' + e.message); }
  finally { if (off) send('save-on'); }
  fs.renameSync(out, path.join(BAK, file));
  const rec = { id, file, t: Date.now(), size: fs.statSync(path.join(BAK, file)).size, scope, world: world || null, trigger, label, mc: cfg ? cfg.version : null };
  const a = bIdx(); a.push(rec); bSave(a); log('Back-up klaar: ' + file + ' (' + mb(rec.size) + ')', 'ok'); emit('backups', {}); return rec;
}
function pruneAuto() { const k = Math.max(1, +app.backup.keep || 7), a = bIdx(), auto = a.filter(r => r.trigger === 'auto').sort((x, y) => y.t - x.t), del = auto.slice(k); for (const r of del) { try { fs.rmSync(bFile(r), { force: true }); } catch {} } if (del.length) { bSave(a.filter(r => !del.includes(r))); log(del.length + ' oude automatische back-up(s) verwijderd.'); } }
async function job(kind, label, fn) {
  if (S.busy) throw new Err(409, 'Er is al een taak bezig: ' + (S.busy === true ? 'installatie' : S.busy));
  const id = crypto.randomBytes(4).toString('hex'); S.busy = label; push(); emit('job', { id, kind, state: 'run', label });
  fn().then(r => emit('job', { id, kind, state: 'done', label, result: r })).catch(e => { log(label + ' mislukt: ' + e.message, 'e'); emit('job', { id, kind, state: 'error', label, error: e.message }); }).finally(() => { S.busy = false; push(); emit('backups', {}); emit('worlds', {}); });
  return id;
}
async function tarCheck(f) { // lijst controleren: geen absolute paden of ..
  const l = (await run('tar', ['-tzf', f])).split('\n').filter(Boolean); if (!l.length) throw new Err(400, 'Het archief is leeg');
  for (const x of l) if (/^([\/\\]|[a-zA-Z]:)/.test(x) || x.split(/[\/\\]/).includes('..')) throw new Err(400, 'Onveilig archief: ' + x.slice(0, 60)); return l;
}
async function extractTo(f, dir) { fs.mkdirSync(dir, { recursive: true }); try { await run('tar', ['-xf', f, '-C', dir, '--no-same-owner']); } catch (e) { await run('tar', ['-xf', f, '-C', dir]); } }
async function restoreBackup(rec) {
  const f = bFile(rec); if (!fs.existsSync(f)) throw new Err(404, 'Bestand van de back-up ontbreekt'); await tarCheck(f);
  log('Veiligheidskopie maken van de huidige staat...'); await makeBackup({ scope: 'full', trigger: 'pre-restore', label: 'Voor herstel van ' + rec.file });
  const tmp = path.join(TMP, 'restore-' + stamp()), tr = path.join(TRASH, stamp() + '-restore'); await extractTo(f, tmp); fs.mkdirSync(tr, { recursive: true });
  for (const e of fs.readdirSync(tmp)) { const dst = path.join(SRV, e); if (fs.existsSync(dst)) mv(dst, path.join(tr, e)); mv(path.join(tmp, e), dst); }
  fs.rmSync(tmp, { recursive: true, force: true }); wCache.clear(); log('Back-up hersteld: ' + rec.file + '. Oude bestanden staan in data/trash/', 'ok'); return { restored: rec.file };
}
async function replaceWorld(name, upload) {
  const wl = await listWorlds(), w = wl.find(x => x.name === name); if (!w) throw new Err(404, 'Wereld niet gevonden');
  await tarCheck(upload).catch(async e => { throw e; });
  log('Back-up van "' + name + '" voor het vervangen...'); await makeBackup({ scope: 'world', world: name, trigger: 'pre-replace', label: 'Voor vervangen van ' + name });
  const tmp = path.join(TMP, 'world-' + stamp()); await extractTo(upload, tmp);
  let root = tmp; if (!fs.existsSync(path.join(root, 'level.dat'))) { const sub = fs.readdirSync(tmp, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(tmp, e.name, 'level.dat'))); if (sub.length !== 1) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Err(400, 'Geen level.dat gevonden: dit lijkt geen Minecraft-wereld'); } root = path.join(tmp, sub[0].name); }
  const tr = path.join(TRASH, stamp() + '-world-' + name.replace(/\W+/g, '_')); fs.mkdirSync(tr, { recursive: true });
  for (const f of w.folders) mv(path.join(SRV, f), path.join(tr, f)); mv(root, path.join(SRV, name)); fs.rmSync(tmp, { recursive: true, force: true }); wCache.clear();
  log('Wereld "' + name + '" vervangen. De oude staat staat in data/trash/', 'ok'); return { replaced: name };
}
let lastAutoDay = '';
setInterval(() => {
  const b = app.backup; if (!b.auto || S.busy || S.status === 'starting' || S.status === 'stopping' || S.status === 'installing' || S.status === 'setup') return;
  const d = new Date(); let due = false;
  if (b.mode === 'interval') due = Date.now() - (b.last || 0) >= Math.max(1, b.everyH) * 3600e3;
  else if (d.toTimeString().slice(0, 5) === b.at && lastAutoDay !== d.toDateString()) { lastAutoDay = d.toDateString(); due = true; }
  if (!due) return; b.last = Date.now(); saveApp();
  job('backup', 'Automatische back-up', async () => { const r = await makeBackup({ scope: b.scope === 'world' ? 'world' : 'full', world: levelName(), trigger: 'auto' }); pruneAuto(); return r; }).catch(() => {});
}, 30000);

// ---- app-instellingen en opstarten bij inloggen (Linux/macOS/Windows)
const home = os.homedir(), bootFile = process.platform === 'linux' ? path.join(home, '.config', 'autostart', 'blokwerk.desktop') : process.platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'nl.blokwerk.app.plist') : null;
async function bootGet() { if (bootFile) return fs.existsSync(bootFile); try { await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Blokwerk']); return true; } catch { return false; } }
async function bootSet(on) {
  if (process.platform === 'win32') { const k = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (on) await run('reg', ['add', k, '/v', 'Blokwerk', '/t', 'REG_SZ', '/d', 'cmd /c start "" /min "' + path.join(ROOT, 'Blokwerk.bat') + '" boot', '/f']); else await run('reg', ['delete', k, '/v', 'Blokwerk', '/f']).catch(() => {}); return; }
  if (!on) return fs.rmSync(bootFile, { force: true });
  const x = path.join(ROOT, 'Blokwerk.command'); fs.mkdirSync(path.dirname(bootFile), { recursive: true });
  fs.writeFileSync(bootFile, process.platform === 'linux' ? '[Desktop Entry]\nType=Application\nName=Blokwerk\nExec=bash "' + x + '" boot\nTerminal=false\n' : '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>nl.blokwerk.app</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>' + x + '</string><string>boot</string></array><key>RunAtLoad</key><true/></dict></plist>\n');
}
async function settingsOut() { const b = app.backup; return { autoStart: app.autoStart, crashRestart: app.crashRestart, restartAt: app.restartAt, backup: { auto: b.auto, mode: b.mode, at: b.at, everyH: b.everyH, keep: b.keep, scope: b.scope, last: b.last }, ram: cfg && cfg.ram, flags: cfg && cfg.flags, boot: await bootGet(), platform: process.platform, hasPassword: !!app.auth }; }
function settingsIn(o) {
  const bad = m => { throw new Err(400, m); };
  if ('autoStart' in o) app.autoStart = !!o.autoStart; if ('crashRestart' in o) app.crashRestart = !!o.crashRestart;
  if ('restartAt' in o) { if (o.restartAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.restartAt)) bad('Tijd moet HH:MM zijn'); app.restartAt = o.restartAt || ''; }
  if (o.backup) { const b = o.backup, a = app.backup; if ('auto' in b) a.auto = !!b.auto; if ('mode' in b) a.mode = pick(b.mode, ['daily', 'interval'], 'daily');
    if ('at' in b) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.at)) bad('Tijd moet HH:MM zijn'); a.at = b.at; } if ('everyH' in b) { const n = +b.everyH; if (!(n >= 1 && n <= 168)) bad('Interval: 1 tot 168 uur'); a.everyH = Math.floor(n); }
    if ('keep' in b) { const n = +b.keep; if (!(n >= 1 && n <= 100)) bad('Bewaar 1 tot 100 back-ups'); a.keep = Math.floor(n); } if ('scope' in b) a.scope = pick(b.scope, ['full', 'world'], 'full'); }
  if (('ram' in o || 'flags' in o) && cfg) { if (S.proc || S.busy) bad('Stop eerst de server om het geheugen aan te passen'); if ('ram' in o) { const n = +o.ram; if (!(n >= 1 && n <= 128)) bad('Geheugen: 1 tot 128 GB'); cfg.ram = Math.floor(n); } if ('flags' in o) cfg.flags = !!o.flags; fs.writeFileSync(CFG, JSON.stringify(cfg, null, 1)); }
  saveApp(); push();
}

// ---- HTTP
const json = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const readBody = (req, max = 2e6) => new Promise((ok, no) => { let b = '', n = 0; req.on('data', d => { n += d.length; if (n > max) { no(new Err(413, 'Verzoek te groot')); req.destroy(); return; } b += d; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(new Err(400, 'Ongeldige JSON')); } }); req.on('error', no); });
async function rawUpload(req, res, max) {
  const len = +req.headers['content-length']; if (!len) throw new Err(411, 'Leeg bestand'); if (len > max) { res.setHeader('Connection', 'close'); throw new Err(413, 'Bestand te groot (max ' + mb(max) + ')'); }
  const tmp = path.join(TMP, crypto.randomBytes(8).toString('hex')), out = fs.createWriteStream(tmp); let n = 0;
  try { await new Promise((ok, no) => { req.on('data', d => { n += d.length; if (n > max) { no(new Err(413, 'Bestand te groot')); req.unpipe(out); out.destroy(); } }); req.on('error', no); out.on('error', no); out.on('finish', ok); req.on('aborted', () => no(new Err(400, 'Upload afgebroken'))); req.pipe(out); }); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return { tmp, size: n };
}
function sendFile(res, f, name, type) {
  const st = fs.statSync(f); res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + name.replace(/[^\w.\- ]/g, '_') + '"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
}
const DONE = Symbol('done'), B = (v, d) => v === undefined ? d : v;
const needOff = () => { if (S.proc || S.starting) throw new Err(409, 'Stop eerst de server'); };
const needTpl = (c, m) => { if (!c) throw new Err(400, m); };
const GET = {
  '/api/state': () => ({ ...state(), logs }),
  '/api/metrics': ({ q }) => { const r = +q.get('range') || 60, since = Date.now() - r * 1000; return { range: r, samples: M.hist.filter(s => s.t >= since) }; },
  '/api/settings': () => settingsOut(),
  '/api/players': () => playersOut(),
  '/api/mods': () => ({ items: listMods(), type: cfg && cfg.type, version: cfg && cfg.version, running: !!S.proc }),
  '/api/mods/download': ({ q, res }) => { const f = modPath(q.get('dir'), q.get('file')); if (!fs.existsSync(f)) throw new Err(404, 'Niet gevonden'); sendFile(res, f, path.basename(f)); return DONE; },
  '/api/files': ({ q }) => { const p = safe(q.get('path')); if (!fs.statSync(p).isDirectory()) throw new Err(400, 'Dit is geen map'); const items = fs.readdirSync(p).filter(n => !fs.lstatSync(path.join(p, n)).isSymbolicLink()).map(n => { try { return fileInfo(path.join(p, n)); } catch { return null; } }).filter(Boolean).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)); return { path: relOf(p), items }; },
  '/api/files/read': ({ q }) => {
    const p = safe(q.get('path')), rel = relOf(p), st = fs.statSync(p); if (locked(rel)) throw new Err(403, 'Dit bestand is beveiligd en niet beschikbaar in de browser');
    if (!st.isFile()) throw new Err(400, 'Dit is geen bestand'); if (st.size > 2e6) throw new Err(413, 'Bestand is te groot om te bewerken (max 2 MB). Download het in plaats daarvan.'); if (!EDIT.test(p)) throw new Err(415, 'Dit bestandstype kan niet in de browser worden bewerkt');
    let t = fs.readFileSync(p, 'utf8'); if (t.includes('\0')) throw new Err(415, 'Dit is een binair bestand'); if (path.basename(p) === 'server.properties') t = maskProps(t);
    return { path: rel, size: st.size, mtime: st.mtimeMs, content: t };
  },
  '/api/files/download': ({ q, res }) => { const p = safe(q.get('path')), rel = relOf(p); if (locked(rel)) throw new Err(403, 'Dit bestand is beveiligd'); if (!fs.statSync(p).isFile()) throw new Err(400, 'Dit is geen bestand'); sendFile(res, p, path.basename(p)); return DONE; },
  '/api/files/search': ({ q }) => { const s = String(q.get('q') || '').toLowerCase().trim(); if (s.length < 2) throw new Err(400, 'Typ minstens 2 tekens'); const out = []; search(s, SRV, out, 0); return { items: out }; },
  '/api/config/props': () => { if (!cfg) throw new Err(404, 'Nog niet geïnstalleerd'); return propsOut(); },
  '/api/config/files': () => { // bekende en gevonden configuratiebestanden
    const known = ['eula.txt', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'].map(f => ({ path: f, group: 'Server', exists: fs.existsSync(path.join(SRV, f)) })), more = [];
    for (const d of ['config', 'plugins']) { const walk = (rel, depth) => { let es; try { es = fs.readdirSync(path.join(SRV, rel), { withFileTypes: true }); } catch { return; } for (const e of es) { const r = rel + '/' + e.name; if (e.isSymbolicLink()) continue; if (e.isDirectory()) { if (depth < 2) walk(r, depth + 1); } else if (EDIT.test(e.name) && !locked(r) && more.length < 300) more.push({ path: r, group: d === 'config' ? 'Config' : 'Plugins' }); } }; walk(d, 0); }
    return { files: [...known, ...more] };
  },
  '/api/backups': () => { const a = bIdx().filter(r => fs.existsSync(path.join(BAK, r.file))).sort((x, y) => y.t - x.t); let free = null; return { items: a, total: a.reduce((n, r) => n + r.size, 0), busy: S.busy, running: !!S.proc }; },
  '/api/backups/download': ({ q, res }) => { const r = bIdx().find(x => x.id === q.get('id')), f = bFile(r); if (!fs.existsSync(f)) throw new Err(404, 'Bestand ontbreekt'); sendFile(res, f, r.file, 'application/gzip'); return DONE; },
  '/api/worlds': async () => ({ worlds: await listWorlds(), level: levelName(), running: !!S.proc }),
  '/api/crashes': () => ({ items: fs.readdirSync(CRASH).filter(f => /^crash-[\w-]+\.txt$/.test(f)).sort().reverse().map(f => ({ name: f, t: fs.statSync(path.join(CRASH, f)).mtimeMs, size: fs.statSync(path.join(CRASH, f)).size })) }),
  '/api/crashes/read': ({ q }) => { const n = String(q.get('name')); if (!/^crash-[\w-]+\.txt$/.test(n)) throw new Err(400, 'Ongeldige naam'); return { name: n, content: fs.readFileSync(path.join(CRASH, n), 'utf8') }; },
};
const POST = {
  '/api/install': o => { install(o).catch(e => log(e.message, 'e')); return { ok: true }; },
  '/api/update/check': async () => { await checkUpdate(); return { ok: true }; },
  '/api/update/url': async o => { const u = String(o.url || '').trim(); if (u && !okUrl(u)) throw new Err(400, 'Alleen https-adressen zijn toegestaan'); app.updateUrl = u; saveApp(); await checkUpdate(); return { ok: true }; },
  '/api/update/apply': async () => { await applyUpdate(); return { ok: true }; },
  '/api/start': async () => { if (S.busy) throw new Err(409, 'Wacht tot de taak "' + S.busy + '" klaar is'); if (S.proc || S.starting) throw new Err(409, 'De server draait al'); await start(); return { ok: true }; },
  '/api/stop': () => { if (typeof S.busy === 'string') throw new Err(409, 'Wacht tot de taak "' + S.busy + '" klaar is'); if (!S.proc) throw new Err(409, 'De server draait niet'); stop(); return { ok: true }; },
  '/api/restart': () => { if (S.busy) throw new Err(409, 'Wacht tot de taak "' + S.busy + '" klaar is'); if (S.status !== 'online') throw new Err(409, 'De server is niet online'); stop(() => start().catch(e => log(e.message, 'e'))); return { ok: true }; },
  '/api/forcestop': o => { if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); if (!S.proc) throw new Err(409, 'De server draait niet'); forceStop(); return { ok: true }; },
  '/api/cmd': o => {
    const c = String(o.cmd || '').trim().replace(/^\//, ''); if (!c) throw new Err(400, 'Leeg commando'); if (c.length > 256) throw new Err(400, 'Commando te lang (max 256 tekens)');
    if (/[\x00-\x1f\x7f]/.test(c)) throw new Err(400, 'Het commando bevat ongeldige tekens'); if (S.status !== 'online' && S.status !== 'starting') throw new Err(409, 'Server draait niet');
    if (!send(c)) throw new Err(409, 'Server draait niet'); log('> ' + c, 'u'); return { ok: true, status: 'verzonden' };
  },
  '/api/player': o => { playerAction(o); setTimeout(() => emit('players', {}), 900); return { ok: true }; },
  '/api/mods/toggle': o => { const f = modPath(o.dir, o.file), en = !/\.disabled$/i.test(f), to = en ? f + '.disabled' : f.replace(/\.disabled$/i, ''); if (!fs.existsSync(f)) throw new Err(404, 'Niet gevonden'); if (fs.existsSync(to)) throw new Err(409, 'Er bestaat al een bestand met die naam'); fs.renameSync(f, to); return { ok: true, enabled: !en, restart: !!S.proc }; },
  '/api/mods/delete': o => { if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); const it = Array.isArray(o.items) ? o.items.slice(0, 200) : []; let n = 0; for (const x of it) { const f = modPath(x.dir, x.file); if (fs.existsSync(f)) { fs.rmSync(f); n++; } } return { ok: true, deleted: n, restart: !!S.proc }; },
  '/api/files/write': o => {
    const p = safe(o.path), rel = relOf(p); if (locked(rel)) throw new Err(403, 'Dit bestand is beveiligd'); if (!EDIT.test(p)) throw new Err(415, 'Dit bestandstype kan niet worden bewerkt');
    let t = String(o.content == null ? '' : o.content); if (t.length > 2e6) throw new Err(413, 'Te groot'); if (t.includes('\0')) throw new Err(400, 'Ongeldige tekens');
    const ex = fs.existsSync(p); if (ex && !fs.statSync(p).isFile()) throw new Err(400, 'Dit is geen bestand'); if (ex && o.mtime && Math.abs(fs.statSync(p).mtimeMs - o.mtime) > 1) throw new Err(409, 'Het bestand is ondertussen gewijzigd (door de server of een ander). Laad het opnieuw.');
    if (path.basename(p) === 'server.properties' && ex) t = unmask(t, fs.readFileSync(p, 'utf8'));
    const err = validate(rel, t); if (err) throw new Err(400, err); if (ex) snap(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t);
    return { ok: true, mtime: fs.statSync(p).mtimeMs, restart: !!S.proc };
  },
  '/api/files/mkdir': o => { const d = safe(o.path), n = cleanName(o.name), p = path.join(d, n); safe(relOf(p)); if (fs.existsSync(p)) throw new Err(409, 'Bestaat al'); fs.mkdirSync(p); return { ok: true }; },
  '/api/files/rename': o => {
    const p = safe(o.path), rel = relOf(p), n = cleanName(o.name), to = path.join(path.dirname(p), n); safe(relOf(to)); if (!rel) throw new Err(400, 'Kan de hoofdmap niet hernoemen');
    if (locked(rel) || locked(relOf(to))) throw new Err(403, 'Dit bestand is beveiligd'); if (PROT.has(rel)) throw new Err(403, 'Dit bestand is nodig voor de server en kan niet hernoemd worden');
    if (S.proc && /^(world|[^\/]+\/level\.dat)/.test(rel) && fs.existsSync(path.join(p, 'level.dat'))) throw new Err(409, 'Stop de server voordat je een wereldmap hernoemt');
    if (!fs.existsSync(p)) throw new Err(404, 'Niet gevonden'); if (fs.existsSync(to)) throw new Err(409, 'Bestaat al'); fs.renameSync(p, to); return { ok: true };
  },
  '/api/files/delete': o => {
    if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); const items = (Array.isArray(o.paths) ? o.paths : [o.path]).slice(0, 200);
    for (const x of items) { const p = safe(x), rel = relOf(p); if (!rel) throw new Err(400, 'Kan de hoofdmap niet verwijderen'); if (locked(rel)) throw new Err(403, 'Beveiligd bestand: ' + rel); if (PROT.has(rel)) throw new Err(403, rel + ' is nodig voor de server en kan niet verwijderd worden');
      if (S.proc && fs.existsSync(path.join(p, 'level.dat'))) throw new Err(409, 'Stop de server voordat je een wereldmap verwijdert'); }
    const tr = path.join(TRASH, stamp() + '-bestanden'); fs.mkdirSync(tr, { recursive: true }); let n = 0;
    for (const x of items) { const p = safe(x); if (fs.existsSync(p)) { mv(p, path.join(tr, relOf(p).replace(/\//g, '__'))); n++; } } // naar de prullenbak i.p.v. definitief
    return { ok: true, deleted: n, trash: 'data/trash/' };
  },
  '/api/config/props': o => propsIn(o.values),
  '/api/backups/create': async o => { const scope = pick(o.scope, ['full', 'world'], 'full'); let w = o.world; if (scope === 'world') { w = String(w || levelName()); } const id = await job('backup', 'Back-up maken', () => makeBackup({ scope, world: w, trigger: pick(o.trigger, ['manual', 'download'], 'manual'), label: String(o.label || '').slice(0, 80) })); return { ok: true, job: id }; },
  '/api/backups/delete': o => { if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); const a = bIdx(), ids = Array.isArray(o.ids) ? o.ids : [o.id]; const del = a.filter(r => ids.includes(r.id)); for (const r of del) fs.rmSync(bFile(r), { force: true }); bSave(a.filter(r => !del.includes(r))); return { ok: true, deleted: del.length }; },
  '/api/backups/prune': o => { if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); const k = Math.floor(+o.keep); if (!(k >= 1 && k <= 1000)) throw new Err(400, 'Bewaar minstens 1 back-up'); const a = bIdx().sort((x, y) => y.t - x.t), del = a.slice(k); for (const r of del) fs.rmSync(bFile(r), { force: true }); bSave(a.filter(r => !del.includes(r))); return { ok: true, deleted: del.length }; },
  '/api/backups/restore': async o => { if (!o.confirm) throw new Err(400, 'Bevestiging nodig'); needOff(); const r = bIdx().find(x => x.id === o.id); bFile(r); const id = await job('restore', 'Back-up herstellen', () => restoreBackup(r)); return { ok: true, job: id }; },
  '/api/worlds/new': o => {
    needOff(); const n = String(o.name || '').trim(); if (!/^[\w][\w \-]{0,39}$/.test(n)) throw new Err(400, 'Gebruik 1-40 letters, cijfers, spaties, - of _'); if (fs.existsSync(path.join(SRV, n))) throw new Err(409, 'Er bestaat al een map met die naam');
    const seed = String(o.seed || '').trim(); if (/[\r\n]/.test(seed) || seed.length > 60) throw new Err(400, 'Ongeldige seed');
    const f = path.join(SRV, 'server.properties'); let t = readTxt(f); snap(f); const set = (k, v) => { const re = new RegExp('^' + k.replace(/[.\-]/g, '\\$&') + '=.*$', 'm'); t = re.test(t) ? t.replace(re, k + '=' + v) : t.replace(/\n?$/, '\n') + k + '=' + v + '\n'; };
    set('level-name', n); set('level-seed', seed); fs.writeFileSync(f, t); wCache.clear(); log('Nieuwe wereld "' + n + '" wordt aangemaakt bij de volgende start.', 'ok'); return { ok: true };
  },
  '/api/worlds/activate': async o => { needOff(); const w = (await listWorlds()).find(x => x.name === o.name); if (!w) throw new Err(404, 'Wereld niet gevonden'); const f = path.join(SRV, 'server.properties'); let t = readTxt(f); snap(f); t = /^level-name=.*$/m.test(t) ? t.replace(/^level-name=.*$/m, 'level-name=' + w.name) : t + '\nlevel-name=' + w.name + '\n'; fs.writeFileSync(f, t); return { ok: true }; },
  '/api/settings': o => { settingsIn(o); return { ok: true }; },
  '/api/settings/boot': async o => { await bootSet(!!o.enabled); return { ok: true, boot: await bootGet() }; },
};
const UPLOADS = {
  '/api/mods/upload': async ({ q, req, res }) => {
    const name = modName(cleanName(q.get('name'))); if (!/\.jar$/i.test(name)) throw new Err(400, 'Alleen .jar-bestanden');
    const up = await rawUpload(req, res, 512 * 1048576);
    try {
      if (!sniff(up.tmp, 'jar')) throw new Err(415, 'Dit is geen geldig JAR-bestand'); let info; try { info = jarInfo(up.tmp); } catch (e) { throw new Err(415, e.message); }
      let dir = loaderDir(info.loader); const force = q.get('dir'); if (!dir) { if (['mods', 'plugins'].includes(force)) dir = force; else throw new Err(422, 'Kon niet bepalen of dit een mod of plugin is'); }
      if (cfg && cfg.type === 'vanilla') throw new Err(422, 'Vanilla-servers kunnen geen mods of plugins laden. Installeer Paper, Purpur of Fabric.');
      const dst = path.join(SRV, dir, name); fs.mkdirSync(path.dirname(dst), { recursive: true });
      const other = dst + '.disabled'; if ((fs.existsSync(dst) || fs.existsSync(other)) && q.get('overwrite') !== '1') throw new Err(409, name + ' staat er al');
      fs.rmSync(other, { force: true }); mv(up.tmp, dst);
      const st = fs.statSync(dst); return { ok: true, dir, file: name, info, warn: compat(info, dir), restart: !!S.proc, size: st.size };
    } finally { fs.rmSync(up.tmp, { force: true }); }
  },
  '/api/files/upload': async ({ q, req, res }) => {
    const d = safe(q.get('path')), name = cleanName(q.get('name')), ext = path.extname(name).slice(1).toLowerCase(), rel = relOf(path.join(d, name));
    if (!UPX.has(ext)) throw new Err(415, 'Bestandstype .' + (ext || '?') + ' is niet toegestaan'); if (locked(rel) || locked(name)) throw new Err(403, 'Beveiligde bestandsnaam');
    if (!fs.statSync(d).isDirectory()) throw new Err(400, 'Doelmap bestaat niet'); const dst = path.join(d, name); safe(relOf(dst)); if (fs.existsSync(dst) && q.get('overwrite') !== '1') throw new Err(409, name + ' bestaat al');
    const up = await rawUpload(req, res, 1024 * 1048576);
    try { if (!sniff(up.tmp, ext)) throw new Err(415, 'De inhoud past niet bij het bestandstype .' + ext); if (fs.existsSync(dst)) snap(dst); mv(up.tmp, dst); return { ok: true, size: up.size }; } finally { fs.rmSync(up.tmp, { force: true }); }
  },
  '/api/worlds/replace': async ({ q, req, res }) => {
    needOff(); const w = String(q.get('world') || ''); if (q.get('confirm') !== w || !w) throw new Err(400, 'Typ de naam van de wereld ter bevestiging');
    if (!(await listWorlds()).some(x => x.name === w)) throw new Err(404, 'Wereld niet gevonden'); const name = q.get('name') || ''; if (!/\.(tar\.gz|tgz)$/i.test(name)) throw new Err(415, 'Upload een .tar.gz-bestand (bijv. een back-up uit Blokwerk)');
    const up = await rawUpload(req, res, 8192 * 1048576); if (!sniff(up.tmp, 'gz')) { fs.rmSync(up.tmp, { force: true }); throw new Err(415, 'Dit is geen geldig .tar.gz-bestand'); }
    const id = await job('replace', 'Wereld vervangen', async () => { try { return await replaceWorld(w, up.tmp); } finally { fs.rmSync(up.tmp, { force: true }); } }).catch(e => { fs.rmSync(up.tmp, { force: true }); throw e; }); return { ok: true, job: id };
  },
};
const HTML = () => fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
async function handle(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end(); }
  const u = new URL(req.url, 'http://x'), url = u.pathname, q = u.searchParams, nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML().replace(/%NONCE%/g, nonce)); }
  if (req.method === 'GET' && url === '/api/auth') { const s = getSession(req); return json(res, 200, { setup: !app.auth, authed: !!s, csrf: s && s.csrf, version: VERSION }); }
  if (req.method === 'POST') { const o = req.headers.origin; if (o && o !== 'http://' + req.headers.host) throw new Err(403, 'Ongeldige herkomst'); if (!req.headers['x-blokwerk']) throw new Err(403, 'Ontbrekende header'); }
  if (req.method === 'POST' && url.startsWith('/api/auth/')) {
    const o = await readBody(req, 1e4), now = Date.now();
    if (url === '/api/auth/setup') { if (app.auth) throw new Err(403, 'Wachtwoord is al ingesteld'); if (String(o.code) !== setupCode) throw new Err(403, 'Onjuiste setup-code. Je vindt de code in het terminalvenster van Blokwerk.'); if (!goodPw(o.password)) throw new Err(400, 'Kies een wachtwoord van minstens 8 tekens'); setPw(o.password); setupCode = ''; return json(res, 200, { ok: true, csrf: newSession(res).csrf }); }
    if (url === '/api/auth/login') {
      if (fails.until > now) throw new Err(429, 'Te veel pogingen. Probeer het over ' + Math.ceil((fails.until - now) / 1000) + ' seconden opnieuw.');
      if (!checkPw(o.password)) { fails.n++; if (fails.n >= 5) { fails.until = now + Math.min(300, 15 * 2 ** (fails.n - 5)) * 1000; } await new Promise(r => setTimeout(r, 400)); throw new Err(401, 'Onjuist wachtwoord'); }
      fails = { n: 0, until: 0 }; return json(res, 200, { ok: true, csrf: newSession(res).csrf });
    }
    const s = getSession(req); if (!s || req.headers['x-blokwerk'] !== s.csrf) throw new Err(401, 'Niet ingelogd');
    if (url === '/api/auth/logout') { sess.delete(s.id); res.setHeader('Set-Cookie', 'bw=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (url === '/api/auth/password') { if (!checkPw(o.current)) throw new Err(403, 'Huidig wachtwoord klopt niet'); if (!goodPw(o.next)) throw new Err(400, 'Nieuw wachtwoord: minstens 8 tekens'); setPw(o.next); for (const k of sess.keys()) if (k !== s.id) sess.delete(k); return json(res, 200, { ok: true }); }
    throw new Err(404, 'Onbekend');
  }
  const s = getSession(req); if (!s) throw new Err(401, 'Niet ingelogd');
  if (req.method === 'GET') {
    if (url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('retry: 2000\n\nevent: state\ndata: ' + JSON.stringify(state()) + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    const h = GET[url]; if (!h) throw new Err(404, 'Onbekend'); const r = await h({ q, req, res }); if (r !== DONE) json(res, 200, r); return;
  }
  if (req.method !== 'POST' || req.headers['x-blokwerk'] !== s.csrf) throw new Err(403, 'Ongeldig verzoek (CSRF)');
  if (UPLOADS[url]) { const r = await UPLOADS[url]({ q, req, res }); return json(res, 200, r); }
  const h = POST[url]; if (!h) throw new Err(404, 'Onbekend'); const o = await readBody(req); json(res, 200, await h(o));
}
const srv = http.createServer((req, res) => { handle(req, res).catch(e => { if (e.status === 401) return json(res, 401, { error: e.message, login: true }); if (!(e instanceof Err)) console.error(e); if (!res.headersSent) json(res, e.status || 500, { error: e instanceof Err ? e.message : 'Interne fout: ' + e.message, fields: e.fields }); else res.destroy(); }); });
srv.requestTimeout = 0; srv.headersTimeout = 30000;
function open(u) {
  const c = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(c[0], c[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
function listen() {
  srv.once('error', e => { if (e.code === 'EADDRINUSE' && PORT < 3020) { PORT++; listen(); } else { console.error(e.message); process.exit(1); } });
  srv.listen(PORT, '127.0.0.1', () => { const u = 'http://localhost:' + PORT; console.log('\nBlokwerk ' + VERSION + ' draait op ' + u + '\nDruk op Ctrl+C om te stoppen.\n'); if (setupCode) console.log('Eerste keer? Vul in de browser deze setup-code in: ' + setupCode + '\n'); if (!process.env.NO_OPEN) open(u); });
}
listen();
setTimeout(() => { if (app.updateUrl) checkUpdate(); }, 4000); setInterval(() => { if (app.updateUrl) checkUpdate(); }, 6 * 3600e3);
setInterval(() => { for (const [k, v] of sess) if (v.exp < Date.now()) sess.delete(k); }, 600e3);
let bye = false;
const quit = () => { if (bye) return; bye = true; console.log('\nAfsluiten...'); if (S.proc) { stop(() => process.exit(0)); setTimeout(() => process.exit(0), 50000); } else process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
process.on('unhandledRejection', e => { console.error('Onverwachte fout:', e && e.message || e); });
