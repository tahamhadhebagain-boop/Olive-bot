'use strict';
/*
 ╔══════════════════════════════════════════════════════════╗
 ║  🫒 OLIVE BOT — بوت مسنجر (fca-unofficial) في ملف واحد   ║
 ╚══════════════════════════════════════════════════════════╝
 المتغيرات المطلوبة (Railway ← Variables):
   APPSTATE = كوكيز حساب البوت (JSON كامل)
   ADMIN_ID = ايدي المطور الأساسي بالأرقام (أو رابط حسابه)
 اختيارية:
   DATA_DIR (مسار الـ Volume مثل /data) • MIN_SPAM_SECONDS • YT_MAX_MINUTES
   YT_COOKIES • YTDLP_EXTRA_ARGS

 هيكل الملف: كل قسم "__def('...')" بالأسفل هو ملف مستقل سابقاً
 (src/* = المحرّك، commands/* = الأوامر، index = نقطة التشغيل).
*/

const __nodeRequire = require;
const __defs = {};
const __cache = {};
const __def = (key, fn) => { __defs[key] = fn; };
const __commandFiles = () =>
  Object.keys(__defs).filter((k) => k.startsWith('commands/')).sort().map((k) => k.slice(9) + '.js');

function __resolve(from, request) {
  const base = from.split('/').slice(0, -1);
  for (const part of request.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/').replace(/\.js$/, '');
}

function __load(key) {
  if (__cache[key]) return __cache[key].exports;
  if (!__defs[key]) throw new Error('module not found: ' + key);
  const module = { exports: {} };
  __cache[key] = module;
  const req = (r) => (r.startsWith('.') ? __load(__resolve(key, r)) : __nodeRequire(r));
  __defs[key](module, module.exports, req);
  return module.exports;
}

// ══════════════ src/config ══════════════
__def('src/config', function (module, exports, require) {
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const TMP_DIR = path.join(os.tmpdir(), 'olive-bot');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

module.exports = {
  DATA_DIR,
  TMP_DIR,
  ADMIN_ID: (process.env.ADMIN_ID || '').trim(),
  PORT: num(process.env.PORT, 3000),
  MIN_SPAM_SECONDS: num(process.env.MIN_SPAM_SECONDS, 2),
  YT_MAX_MINUTES: num(process.env.YT_MAX_MINUTES, 15),
  YT_COOKIES: process.env.YT_COOKIES || '',
  YTDLP_EXTRA_ARGS: (process.env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
};
});

// ══════════════ src/state ══════════════
__def('src/state', function (module, exports, require) {
'use strict';
// حالة وقت التشغيل (لا تُحفظ على القرص)
module.exports = {
  startedAt: Date.now(),
  lastEventAt: Date.now(),
  api: null,
  botID: null,
  adminID: null,
  cookies: [], // appState، يُستخدم لجلب صفحات الحسابات
  spam: new Map(), // threadID -> job
  tasks: new Map(), // threadID -> Set<{cancelled}>
  sent: new Map(), // threadID -> [messageID...] آخر رسائل البوت
};
});

// ══════════════ src/store ══════════════
__def('src/store', function (module, exports, require) {
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'store.json');

// locked = true  → الأوامر للمطورين فقط (الافتراضي)
const data = { locked: true, devs: [], threads: {}, spam: {} };

function load() {
  try {
    Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] load failed:', e.message);
  }
}

function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function thread(id) {
  if (!data.threads[id]) data.threads[id] = {};
  return data.threads[id];
}

module.exports = { data, load, save, thread };
});

// ══════════════ src/utils ══════════════
__def('src/utils', function (module, exports, require) {
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TMP_DIR } = require('./config');
const state = require('./state');
const store = require('./store');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errMsg(e) {
  if (e == null) return 'خطأ غير معروف';
  if (typeof e === 'string') return e;
  const m = e.errorDescription || e.error || e.message;
  if (m) return String(m).slice(0, 200);
  try {
    return JSON.stringify(e).slice(0, 200);
  } catch (_) {
    return 'خطأ غير معروف';
  }
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}ي`, h && `${h}س`, m && `${m}د`, `${s % 60}ث`].filter(Boolean).join(' ');
}

/* ───────── الصلاحيات ───────── */
const isAdmin = (id) => Boolean(state.adminID) && String(id) === String(state.adminID);
const isDev = (id) => isAdmin(id) || store.data.devs.includes(String(id));

/* ───────── مغلّفات الـ API ───────── */
function call(api, method, ...args) {
  return new Promise((resolve, reject) => {
    if (typeof api[method] !== 'function') {
      return reject(new Error(`api.${method} غير متوفرة في نسخة fca هذه`));
    }
    try {
      api[method](...args, (err, data) => (err ? reject(err) : resolve(data)));
    } catch (e) {
      reject(e);
    }
  });
}

function trackSent(threadID, messageID) {
  const arr = state.sent.get(threadID) || [];
  arr.push(messageID);
  if (arr.length > 50) arr.shift();
  state.sent.set(threadID, arr);
}
const lastSent = (threadID, n) => (state.sent.get(threadID) || []).slice(-n).reverse();
function forgetSent(threadID, messageID) {
  const arr = state.sent.get(threadID);
  if (arr) state.sent.set(threadID, arr.filter((m) => m !== messageID));
}

// يرجع معلومات الرسالة، أو null عند الفشل (لا يرمي أخطاء)
function send(api, threadID, message, { track = true, replyTo } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const cb = (err, info) => {
      if (done) return;
      done = true;
      if (err) {
        console.error('[send]', errMsg(err));
        return resolve(null);
      }
      if (track && info && info.messageID) trackSent(threadID, info.messageID);
      resolve(info || {});
    };
    try {
      api.sendMessage(message, threadID, cb, replyTo);
    } catch (e) {
      cb(e);
    }
  });
}

/* ───────── ملفات مؤقتة وتحميل ───────── */
const tmpFile = (ext) => path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);

async function rmSafe(...files) {
  for (const f of files.flat()) {
    try {
      await fs.promises.unlink(f);
    } catch (_) {}
  }
}

async function download(url, file, { headers = {}, timeout = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(file, buf);
  return { size: buf.length, type: res.headers.get('content-type') || '' };
}

/* ───────── استخراج ايدي الحساب ───────── */
const cookieHeader = () =>
  (state.cookies || [])
    .map((c) => `${c.key || c.name}=${c.value}`)
    .join('; ');

function extractUidSync(text) {
  const t = String(text || '').trim();
  if (/^\d{5,}$/.test(t)) return t;
  let m = t.match(/[?&]id=(\d{5,})/); // profile.php?id=
  if (m) return m[1];
  m = t.match(/(?:facebook|fb)\.com\/people\/[^/]+\/(\d{5,})/);
  if (m) return m[1];
  m = t.match(/fb:\/\/profile\/(\d{5,})/);
  if (m) return m[1];
  return null;
}

// يقبل: ايدي رقمي، profile.php?id=، /people/..، أو رابط باسم مستخدم (يُجلب من صفحة الحساب)
async function resolveUid(input) {
  const direct = extractUidSync(input);
  if (direct) return direct;

  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)(facebook|fb)\.com$/i.test(parsed.hostname)) return null;
  parsed.hostname = 'www.facebook.com';

  const res = await fetch(parsed.href, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieHeader(),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const fromUrl = extractUidSync(res.url);
  if (fromUrl && fromUrl !== state.botID) return fromUrl;

  const html = await res.text();
  for (const re of [/fb:\/\/profile\/(\d{5,})/, /"entity_id":"(\d{5,})"/]) {
    const m = html.match(re);
    if (m && m[1] !== state.botID) return m[1];
  }
  return null;
}

// الهدف: تاغ > ايدي/رابط في النص > الرد على رسالة
async function resolveTargets(ctx, { reply = true } = {}) {
  const { event } = ctx;
  let rest = ctx.args || '';
  const ids = [];
  const failed = [];

  const mentions = event.mentions ? Object.entries(event.mentions) : [];
  if (mentions.length) {
    for (const [id, text] of mentions) {
      ids.push(String(id));
      if (text) rest = rest.split(text).join(' ');
    }
  } else {
    const re = /(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook|fb)\.com\/\S+|\b\d{6,}\b/gi;
    for (const raw of rest.match(re) || []) {
      const m = raw.replace(/[)\].,;!؟،]+$/, '');
      let uid = null;
      try {
        uid = await resolveUid(m);
      } catch (_) {}
      if (uid) ids.push(uid);
      else failed.push(m);
      rest = rest.replace(raw, ' ');
    }
    if (!ids.length && reply && event.messageReply && event.messageReply.senderID) {
      ids.push(String(event.messageReply.senderID));
    }
  }
  return { ids: [...new Set(ids)], rest: rest.replace(/\s+/g, ' ').trim(), failed };
}

/* ───────── طوابير ومهام ───────── */
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => {});
  return next;
}

const hits = new Map();
// يمنع حلقات الصراع مع بوت/مشرف آخر يعيد التغيير باستمرار
function rateOk(key, max = 15, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

function beginTask(threadID) {
  const task = { cancelled: false };
  const set = state.tasks.get(threadID) || new Set();
  set.add(task);
  state.tasks.set(threadID, set);
  return task;
}
function endTask(threadID, task) {
  const set = state.tasks.get(threadID);
  if (set) set.delete(task);
}
function cancelAllTasks() {
  let n = 0;
  for (const set of state.tasks.values()) {
    for (const t of set) {
      t.cancelled = true;
      n++;
    }
  }
  return n;
}

module.exports = {
  UA, sleep, errMsg, fmtDuration, isAdmin, isDev,
  call, send, trackSent, lastSent, forgetSent,
  tmpFile, rmSafe, download,
  extractUidSync, resolveUid, resolveTargets,
  enqueue, rateOk, beginTask, endTask, cancelAllTasks,
};
});

// ══════════════ src/spam ══════════════
__def('src/spam', function (module, exports, require) {
'use strict';
const state = require('./state');
const store = require('./store');
const { send } = require('./utils');

function stop(threadID, { persist = true } = {}) {
  const job = state.spam.get(threadID);
  if (job) {
    job.stopped = true;
    clearTimeout(job.timer);
    state.spam.delete(threadID);
  }
  if (persist && store.data.spam[threadID]) {
    delete store.data.spam[threadID];
    store.save();
  }
  return Boolean(job);
}

function start(api, threadID, message, seconds, { persist = true } = {}) {
  stop(threadID, { persist: false });
  const job = { message, seconds, stopped: false, timer: null, failures: 0 };
  state.spam.set(threadID, job);
  if (persist) {
    store.data.spam[threadID] = { message, seconds };
    store.save();
  }

  // إرسال تلقائي: لا يرد على أحد، وكل مرة بعد مرور المدة
  const tick = async () => {
    if (job.stopped) return;
    const res = await send(api, threadID, message, { track: false });
    if (job.stopped) return;
    if (res) {
      job.failures = 0;
    } else if (++job.failures >= 5) {
      console.error(`[spam] توقف في ${threadID} بعد 5 إخفاقات متتالية`);
      stop(threadID);
      return;
    }
    job.timer = setTimeout(tick, seconds * 1000);
  };
  tick();
}

function stopAll() {
  const n = state.spam.size;
  for (const id of [...state.spam.keys()]) stop(id);
  store.data.spam = {};
  store.save();
  return n;
}

// يستأنف السبام المحفوظ بعد إعادة تشغيل الاستضافة
function resumeAll(api) {
  let i = 0;
  for (const [tid, j] of Object.entries(store.data.spam)) {
    setTimeout(() => {
      if (store.data.spam[tid]) start(api, tid, j.message, j.seconds, { persist: false });
    }, 3000 * ++i);
  }
}

module.exports = { start, stop, stopAll, resumeAll };
});

// ══════════════ src/registry ══════════════
__def('src/registry', function (module, exports, require) {
'use strict';
const fs = require('fs');
const path = require('path');

const map = new Map();
const list = [];
const norm = (s) => String(s).trim().toLowerCase();

function load() {
  map.clear();
  list.length = 0;
  for (const file of __commandFiles()) {
    const cmd = require('../commands/' + file);
    if (!Array.isArray(cmd.names) || !cmd.names.length || typeof cmd.run !== 'function') {
      throw new Error(`commands/${file}: يجب تصدير names و run`);
    }
    cmd.file = file;
    for (const n of [...cmd.names, ...(cmd.hidden || [])]) {
      const key = norm(n);
      if (map.has(key)) throw new Error(`commands/${file}: الاسم "${key}" مستخدم في ${map.get(key).file}`);
      map.set(key, cmd);
    }
    list.push(cmd);
  }
  return list.length;
}

const find = (word) => map.get(norm(word));

module.exports = { load, find, list };
});

// ══════════════ src/handler ══════════════
__def('src/handler', function (module, exports, require) {
'use strict';
const registry = require('./registry');
const store = require('./store');
const state = require('./state');
const { send, call, isAdmin, isDev, errMsg } = require('./utils');

const seen = new Set();
function isDuplicate(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return false;
}

async function onMessage(api, event) {
  if (isDuplicate(event.messageID)) return;
  const body = typeof event.body === 'string' ? event.body.trim() : '';
  if (!body) return;

  const senderID = String(event.senderID);
  if (senderID === state.botID) return;

  // بدون بادئة: الكلمة الأولى هي اسم الأمر
  const first = body.split(/\s+/)[0];
  const cmd = registry.find(first);
  if (!cmd) return;

  const dev = isDev(senderID);
  const admin = isAdmin(senderID);
  if (cmd.adminOnly && !admin) return;
  if (cmd.devOnly && !dev) return;
  if (!dev && store.data.locked) return; // الأوامر مقفولة → للمطورين فقط

  const args = body.slice(first.length).trim();
  if (cmd.noArgs && args) return; // أوامر بلا وسائط لا تُفعَّل وسط كلام عادي

  const threadID = String(event.threadID);
  const ctx = {
    api,
    event,
    args,
    threadID,
    senderID,
    isDev: dev,
    isAdmin: admin,
    send: (msg, opts) => send(api, threadID, msg, opts),
    call: (method, ...a) => call(api, method, ...a),
  };

  if (cmd.groupOnly && event.isGroup === false) {
    return ctx.send('ℹ️ هذا الأمر يعمل داخل المجموعات فقط.');
  }

  try {
    await cmd.run(ctx);
  } catch (e) {
    console.error(`[cmd:${cmd.names[0]}]`, e);
    await ctx.send(`❌ حدث خطأ: ${errMsg(e)}`);
  }
}

module.exports = { onMessage };
});

// ══════════════ src/protect ══════════════
__def('src/protect', function (module, exports, require) {
'use strict';
// حماية اسم المجموعة والكنيات: أي تغيير أو حذف يعيده البوت
const store = require('./store');
const state = require('./state');
const { call, sleep, enqueue, rateOk, errMsg } = require('./utils');

async function onLogEvent(api, event) {
  const threadID = String(event.threadID);
  const author = String(event.author);
  const t = store.data.threads[threadID];
  if (!t) return;
  if (author === state.botID) return; // تغييرات البوت نفسه لا تُعاد (تجنّب الحلقات)
  const data = event.logMessageData || {};

  switch (event.logMessageType) {
    case 'log:thread-name': {
      if (!t.name) return;
      if ((data.name || '') === t.name) return;
      if (!rateOk(`name:${threadID}`)) return console.warn(`[protect] صراع على الاسم في ${threadID} — تم الإيقاف مؤقتاً`);
      enqueue(`prot:${threadID}`, async () => {
        try {
          await call(api, 'setTitle', t.name, threadID);
        } catch (e) {
          console.error('[protect:name]', errMsg(e));
        }
        await sleep(1200);
      });
      break;
    }

    case 'log:user-nickname': {
      if (!t.nick) return;
      const uid = String(data.participant_id);
      const expected = (t.nick.overrides && t.nick.overrides[uid]) ?? t.nick.all;
      if ((data.nickname || '') === expected) return;
      if (!rateOk(`nick:${threadID}:${uid}`)) return console.warn(`[protect] صراع على كنية ${uid} — تم الإيقاف مؤقتاً`);
      enqueue(`prot:${threadID}`, async () => {
        try {
          await call(api, 'changeNickname', expected, threadID, uid);
        } catch (e) {
          console.error('[protect:nick]', errMsg(e));
        }
        await sleep(1200);
      });
      break;
    }

    case 'log:subscribe': {
      // عضو جديد → يأخذ الكنية المحمية مباشرة
      if (!t.nick) return;
      for (const p of data.addedParticipants || []) {
        const uid = String(p.userFbId);
        enqueue(`prot:${threadID}`, async () => {
          try {
            await call(api, 'changeNickname', t.nick.all, threadID, uid);
          } catch (e) {
            console.error('[protect:join]', errMsg(e));
          }
          await sleep(1200);
        });
      }
      break;
    }
  }
}

module.exports = { onLogEvent };
});

// ══════════════ commands/add ══════════════
__def('commands/add', function (module, exports, require) {
'use strict';
const { resolveTargets, errMsg, sleep } = require('../src/utils');

module.exports = {
  names: ['add'],
  category: 'members',
  hint: '+ رابط حساب',
  desc: 'إضافة عضو للمجموعة',
  groupOnly: true,
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx, { reply: false });
    if (!ids.length) {
      return void (await ctx.send(failed.length ? `⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}` : '✏️ الاستخدام: add رابط الحساب'));
    }
    for (const id of ids) {
      try {
        await ctx.call('addUserToGroup', id, ctx.threadID);
        await ctx.send(`✅ تمت إضافة ${id}`);
      } catch (e) {
        await ctx.send(`❌ تعذرت إضافة ${id}: ${errMsg(e)}`);
      }
      await sleep(700);
    }
  },
};
});

// ══════════════ commands/del ══════════════
__def('commands/del', function (module, exports, require) {
'use strict';
const state = require('../src/state');
const { lastSent, forgetSent, sleep, errMsg } = require('../src/utils');

module.exports = {
  names: ['del', 'clear'],
  category: 'tools',
  hint: '(رد على رسالة البوت)',
  desc: 'حذف رسالة للبوت بالرد عليها (أو آخر N رسائل: del 5)',
  async run({ event, args, threadID, send, call }) {
    const reply = event.messageReply;

    if (reply) {
      if (String(reply.senderID) !== state.botID) {
        return void (await send('ℹ️ أستطيع حذف رسائلي أنا فقط.'));
      }
      try {
        await call('unsendMessage', reply.messageID);
        forgetSent(threadID, reply.messageID);
      } catch (e) {
        await send(`❌ تعذر الحذف: ${errMsg(e)}`);
      }
      return;
    }

    // بدون رد: حذف آخر رسائل للبوت في هذه المحادثة
    const n = args ? parseInt(args, 10) : 1;
    if (!Number.isInteger(n) || n < 1) {
      return void (await send('✏️ الاستخدام: رد على رسالة البوت ثم اكتب del\nأو: del 5 لحذف آخر 5 رسائل'));
    }
    const ids = lastSent(threadID, Math.min(n, 20));
    if (!ids.length) return void (await send('ℹ️ لا توجد رسائل حديثة للبوت. رد على رسالة البوت لحذفها.'));
    for (const id of ids) {
      try {
        await call('unsendMessage', id);
        forgetSent(threadID, id);
      } catch (_) {}
      await sleep(500);
    }
  },
};
});

// ══════════════ commands/dev ══════════════
__def('commands/dev', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const { resolveTargets } = require('../src/utils');

module.exports = {
  names: ['dev'],
  category: 'admin',
  hint: '(رد / تاغ / رابط / ايدي)',
  desc: 'إعطاء صلاحية مطور للبوت',
  adminOnly: true,
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx);
    if (!ids.length) {
      return void (await ctx.send(failed.length ? `⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}` : '✏️ الاستخدام: رد على رسالة العضو أو تاغ ثم اكتب dev'));
    }
    const added = [];
    for (const id of ids) {
      if (!store.data.devs.includes(id)) {
        store.data.devs.push(id);
        added.push(id);
      }
    }
    store.save();
    await ctx.send(added.length ? `✅ أصبح مطوراً: ${added.join(' , ')}` : 'ℹ️ هو مطور بالفعل.');
  },
};
});

// ══════════════ commands/group ══════════════
__def('commands/group', function (module, exports, require) {
'use strict';
const fs = require('fs');
const store = require('../src/store');
const { tmpFile, download, rmSafe } = require('../src/utils');

module.exports = {
  names: ['group', 'gc', 'gp'],
  category: 'group',
  desc: 'عرض معلومات المجموعة',
  noArgs: true,
  groupOnly: true,
  async run({ send, call, threadID }) {
    const info = await call('getThreadInfo', threadID);
    const t = store.data.threads[threadID] || {};
    const body = [
      `🏠 الاسم: ${info.threadName || info.name || 'بدون اسم'}`,
      `🆔 الايدي: ${threadID}`,
      `👥 الأعضاء: ${(info.participantIDs || []).length}`,
      `👑 المشرفون: ${(info.adminIDs || []).length}`,
      `💬 عدد الرسائل: ${info.messageCount ?? 'غير معروف'}`,
      `😀 الإيموجي: ${info.emoji || 'الافتراضي'}`,
      `🔐 الموافقة على الأعضاء: ${info.approvalMode ? 'مفعّلة' : 'معطّلة'}`,
      `🛡 حماية الاسم: ${t.name ? 'مفعّلة' : 'معطّلة'}`,
      `🛡 حماية الكنيات: ${t.nick ? 'مفعّلة' : 'معطّلة'}`,
    ].join('\n');

    let file = null;
    let attachment;
    if (info.imageSrc) {
      try {
        file = tmpFile('jpg');
        await download(info.imageSrc, file);
        attachment = fs.createReadStream(file);
      } catch (_) {
        attachment = undefined;
      }
    }
    await send(attachment ? { body, attachment } : body);
    if (file) await rmSafe(file);
  },
};
});

// ══════════════ commands/health ══════════════
__def('commands/health', function (module, exports, require) {
'use strict';
const os = require('os');
const store = require('../src/store');
const state = require('../src/state');
const { fmtDuration } = require('../src/utils');

module.exports = {
  names: ['health'],
  hidden: ['helath'], // الكتابة الخاطئة الشائعة
  category: 'general',
  order: 2,
  desc: 'عرض حالة البوت',
  noArgs: true,
  async run({ send }) {
    const mem = process.memoryUsage();
    const protectedGroups = Object.values(store.data.threads).filter((t) => t.name || t.nick).length;
    await send(
      [
        '🟢 البوت يعمل',
        `⏱ مدة التشغيل: ${fmtDuration(Date.now() - state.startedAt)}`,
        `📡 آخر حدث: قبل ${fmtDuration(Date.now() - state.lastEventAt)}`,
        `🧠 الذاكرة: ${(mem.rss / 1048576).toFixed(0)} MB`,
        `🖥 Node ${process.version} • ${os.platform()} • حمل ${os.loadavg()[0].toFixed(2)}`,
        `🔒 الأوامر: ${store.data.locked ? 'للمطورين فقط' : 'مفتوحة للجميع'}`,
        `👑 المطورون: ${store.data.devs.length + (state.adminID ? 1 : 0)}`,
        `🛡 مجموعات محمية: ${protectedGroups}`,
        `🔁 سبام نشط: ${state.spam.size}`,
      ].join('\n')
    );
  },
};
});

// ══════════════ commands/kick ══════════════
__def('commands/kick', function (module, exports, require) {
'use strict';
const state = require('../src/state');
const { resolveTargets, isAdmin, errMsg, sleep } = require('../src/utils');

module.exports = {
  names: ['kick', 'طرد'],
  category: 'members',
  hint: '(رد / تاغ / ايدي)',
  desc: 'طرد عضو من المجموعة',
  groupOnly: true,
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx);
    if (!ids.length) {
      return void (await ctx.send(failed.length ? `⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}` : '✏️ الاستخدام: رد على رسالة العضو أو تاغ ثم اكتب kick'));
    }
    for (const id of ids) {
      if (id === state.botID) {
        await ctx.send('😅 لن أطرد نفسي.');
        continue;
      }
      if (isAdmin(id)) {
        await ctx.send('🚫 لا يمكن طرد المطور الأساسي.');
        continue;
      }
      try {
        await ctx.call('removeUserFromGroup', id, ctx.threadID);
      } catch (e) {
        await ctx.send(`❌ تعذر طرد ${id}: ${errMsg(e)}`);
      }
      await sleep(700);
    }
  },
};
});

// ══════════════ commands/lock ══════════════
__def('commands/lock', function (module, exports, require) {
'use strict';
const store = require('../src/store');

module.exports = {
  names: ['lock'],
  category: 'admin',
  desc: 'قفل الأوامر: تعمل للمطورين فقط',
  noArgs: true,
  devOnly: true,
  async run({ send }) {
    store.data.locked = true;
    store.save();
    await send('🔒 تم قفل الأوامر — للمطورين فقط.');
  },
};
});

// ══════════════ commands/menu ══════════════
__def('commands/menu', function (module, exports, require) {
'use strict';
const store = require('../src/store');

const CATS = [
  ['general', '📌 عام'],
  ['group', '🏠 المجموعة'],
  ['members', '👥 الأعضاء'],
  ['tools', '🧰 أدوات'],
  ['admin', '👑 المطورين'],
];

module.exports = {
  names: ['up', 'menu', 'bot', 'olive', 'taha'],
  category: 'general',
  order: 0,
  desc: 'عرض هذه القائمة',
  noArgs: true,
  async run({ send }) {
    const { list } = require('../src/registry'); // تحميل متأخر لتجنب الاعتماد الدائري
    const out = ['🫒 ━━━ OLIVE BOT ━━━ 🫒', store.data.locked ? '🔒 الأوامر: للمطورين فقط' : '🔓 الأوامر: مفتوحة للجميع'];
    for (const [key, title] of CATS) {
      const cmds = list.filter((c) => c.category === key).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
      if (!cmds.length) continue;
      out.push('', title);
      for (const c of cmds) {
        out.push(`• ${c.names.join(' / ')}${c.hint ? ' ' + c.hint : ''}`, `   ↳ ${c.desc}`);
      }
    }
    await send(out.join('\n'));
  },
};
});

// ══════════════ commands/name ══════════════
__def('commands/name', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const { errMsg } = require('../src/utils');

module.exports = {
  names: ['nam', 'name', 'نيم'],
  category: 'group',
  hint: '+ اسم  (أو off لإيقاف الحماية)',
  desc: 'تغيير اسم المجموعة وحمايته من التغيير والحذف',
  groupOnly: true,
  async run({ send, call, args, threadID }) {
    if (!args) return void (await send('✏️ الاستخدام:\nnam اسم المجموعة\nnam off ← إيقاف الحماية'));

    const t = store.thread(threadID);
    if (/^(off|stop|الغاء|إلغاء)$/i.test(args)) {
      delete t.name;
      store.save();
      return void (await send('🔓 تم إيقاف حماية اسم المجموعة.'));
    }

    try {
      await call('setTitle', args, threadID);
    } catch (e) {
      return void (await send(`❌ تعذر تغيير الاسم: ${errMsg(e)}`));
    }
    t.name = args;
    store.save();
    await send(`✅ تم تغيير الاسم وحمايته:\n${args}`);
  },
};
});

// ══════════════ commands/nick ══════════════
__def('commands/nick', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const { resolveTargets, errMsg, sleep } = require('../src/utils');

module.exports = {
  names: ['nick'],
  category: 'members',
  hint: '(رد/تاغ) + الكنية',
  desc: 'تغيير كنية عضو واحد',
  groupOnly: true,
  async run(ctx) {
    const { ids, rest } = await resolveTargets(ctx);
    if (!ids.length || !rest) {
      return void (await ctx.send('✏️ الاستخدام: رد على رسالة العضو (أو تاغ) ثم اكتب:\nnick الكنية'));
    }
    const t = store.data.threads[ctx.threadID];
    for (const id of ids) {
      try {
        await ctx.call('changeNickname', rest, ctx.threadID, id);
        // إن كانت حماية الكنيات مفعّلة نستثني هذا العضو كي لا تُعاد كنيته
        if (t && t.nick) {
          t.nick.overrides = t.nick.overrides || {};
          t.nick.overrides[id] = rest;
          store.save();
        }
      } catch (e) {
        await ctx.send(`❌ تعذر تغيير كنية ${id}: ${errMsg(e)}`);
      }
      await sleep(600);
    }
  },
};
});

// ══════════════ commands/nicks ══════════════
__def('commands/nicks', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const { sleep, beginTask, endTask } = require('../src/utils');

module.exports = {
  names: ['nicks'],
  category: 'group',
  hint: '+ الكنية  (أو off لإيقاف الحماية)',
  desc: 'تغيير كنيات كل الأعضاء لكنية واحدة وحمايتها',
  groupOnly: true,
  async run({ send, call, args, threadID }) {
    if (!args) return void (await send('✏️ الاستخدام:\nnicks الكنية\nnicks off ← إيقاف الحماية'));

    const t = store.thread(threadID);
    if (/^(off|stop|الغاء|إلغاء)$/i.test(args)) {
      delete t.nick;
      store.save();
      return void (await send('🔓 تم إيقاف حماية الكنيات.'));
    }

    const info = await call('getThreadInfo', threadID);
    const ids = (info.participantIDs || []).map(String);
    const current = info.nicknames || {};

    t.nick = { all: args, overrides: {} };
    store.save();

    await send(`⏳ جاري تغيير كنيات ${ids.length} عضو إلى: ${args}`);
    const task = beginTask(threadID);
    let ok = 0;
    let fail = 0;
    try {
      for (const id of ids) {
        if (task.cancelled) break;
        if (current[id] === args) {
          ok++;
          continue;
        }
        try {
          await call('changeNickname', args, threadID, id);
          ok++;
        } catch (_) {
          fail++;
        }
        await sleep(900); // فاصل بسيط لتفادي حظر السرعة
      }
    } finally {
      endTask(threadID, task);
    }

    await send(
      task.cancelled
        ? `⏹ تم الإلغاء بعد تغيير ${ok} كنية.`
        : `✅ تم تغيير ${ok} كنية${fail ? ` (فشل ${fail})` : ''} وتفعيل الحماية.`
    );
  },
};
});

// ══════════════ commands/out ══════════════
__def('commands/out', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const state = require('../src/state');
const spam = require('../src/spam');

module.exports = {
  names: ['out', 'leave', 'bye'],
  category: 'group',
  desc: 'مغادرة البوت للمجموعة',
  noArgs: true,
  groupOnly: true,
  devOnly: true, // حتى لو فُتحت الأوامر للجميع
  async run({ send, call, threadID }) {
    await send('👋 وداعاً.. سأغادر المجموعة الآن.');
    await call('removeUserFromGroup', state.botID, threadID);
    spam.stop(threadID);
    delete store.data.threads[threadID];
    store.save();
  },
};
});

// ══════════════ commands/pin ══════════════
__def('commands/pin', function (module, exports, require) {
'use strict';
const fs = require('fs');
const { UA, tmpFile, download, rmSafe } = require('../src/utils');

const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

// المحاولة 1: واجهة البحث الداخلية لبنترست
async function viaApi(query) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
  const data = JSON.stringify({ options: { query, scope: 'pins', page_size: 30, rs: 'typed' }, context: {} });
  const url =
    'https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=' +
    encodeURIComponent(sourceUrl) +
    '&data=' + encodeURIComponent(data) +
    '&_=' + Date.now();
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Pinterest-AppState': 'active',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const results = (json && json.resource_response && json.resource_response.data && json.resource_response.data.results) || [];
  return results
    .map((r) => r && r.images && ((r.images['736x'] && r.images['736x'].url) || (r.images.orig && r.images.orig.url)))
    .filter(Boolean);
}

// المحاولة 2: استخراج روابط الصور من صفحة البحث
async function viaHtml(query) {
  const res = await fetch('https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(query), {
    headers: { ...HEADERS, Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  const html = (await res.text()).replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  return html.match(/https:\/\/i\.pinimg\.com\/(?:originals|736x|564x)\/[A-Za-z0-9_\/-]+\.(?:jpg|jpeg|png)/g) || [];
}

function unique(urls) {
  const byFile = new Map();
  for (const u of urls) {
    const key = u.split('/').pop();
    const prev = byFile.get(key);
    if (!prev || (!prev.includes('/736x/') && u.includes('/736x/'))) byFile.set(key, u);
  }
  return [...byFile.values()];
}

function pick(arr, n) {
  const pool = arr.slice(0, 12);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

module.exports = {
  names: ['pin'],
  category: 'tools',
  hint: '+ اسم الصورة',
  desc: 'إرسال 4 صور من Pinterest في رسالة واحدة',
  async run({ args, send }) {
    if (!args) return void (await send('✏️ الاستخدام: pin اسم الصورة'));

    let urls = [];
    try {
      urls = unique(await viaApi(args));
    } catch (_) {}
    if (urls.length < 4) {
      try {
        urls = unique([...urls, ...(await viaHtml(args))]);
      } catch (_) {}
    }
    if (!urls.length) return void (await send('❌ لم أجد صوراً لهذا البحث (أو أن Pinterest حجب الطلب).'));

    const chosen = pick(urls, 4);
    const files = [];
    try {
      const results = await Promise.allSettled(
        chosen.map(async (u, i) => {
          const f = tmpFile('jpg');
          const info = await download(u, f, { timeout: 20000 });
          if (info.size < 1024 || !/^image\//i.test(info.type)) throw new Error('ليست صورة');
          files[i] = f;
        })
      );
      void results;
      const ok = files.filter(Boolean);
      if (!ok.length) return void (await send('❌ تعذر تحميل الصور.'));
      await send({ body: `📌 ${args}`, attachment: ok.map((f) => fs.createReadStream(f)) });
    } finally {
      await rmSafe(files.filter(Boolean));
    }
  },
};
});

// ══════════════ commands/ping ══════════════
__def('commands/ping', function (module, exports, require) {
'use strict';

module.exports = {
  names: ['ping'],
  category: 'general',
  order: 1,
  desc: 'عرض سرعة الاستجابة (البينغ)',
  noArgs: true,
  async run({ event, send }) {
    const ts = Number(event.timestamp);
    const t0 = Date.now();
    const delay = Number.isFinite(ts) && ts > 0 ? Math.max(0, t0 - ts) : null;
    if (delay !== null) return void (await send(`🏓 Pong!\n⚡ ${delay}ms`));
    await send('🏓 Pong!');
    // لا يوجد توقيت للرسالة: نعرض زمن الإرسال بدلاً منه
    await send(`⚡ ${Date.now() - t0}ms`);
  },
};
});

// ══════════════ commands/rest ══════════════
__def('commands/rest', function (module, exports, require) {
'use strict';
const spam = require('../src/spam');
const { cancelAllTasks } = require('../src/utils');

module.exports = {
  names: ['rest'],
  category: 'tools',
  desc: 'إلغاء كل الأوامر الجارية (سبام وغيره) والراحة',
  noArgs: true,
  async run({ send }) {
    const spams = spam.stopAll();
    const tasks = cancelAllTasks();
    await send(`😴 ارتحت.\nسبام ملغى: ${spams} • مهام ملغاة: ${tasks}`);
  },
};
});

// ══════════════ commands/spam ══════════════
__def('commands/spam', function (module, exports, require) {
'use strict';
const { MIN_SPAM_SECONDS } = require('../src/config');
const spam = require('../src/spam');

module.exports = {
  names: ['spam'],
  category: 'tools',
  hint: '+ رسالة + المدة بالثواني',
  desc: 'إرسال الرسالة تلقائياً كل المدة حتى stop / spamoff / rest',
  async run({ api, args, threadID, send }) {
    const m = args.match(/^([\s\S]+?)\s+(\d+(?:\.\d+)?)$/);
    if (!m) return void (await send('✏️ الاستخدام:\nspam الرسالة 5\n(الرقم الأخير = المدة بالثواني)'));

    const message = m[1].trim();
    let seconds = Number(m[2]);
    let note = '';
    if (seconds < MIN_SPAM_SECONDS) {
      seconds = MIN_SPAM_SECONDS;
      note = `\nℹ️ أقل مدة مسموحة ${MIN_SPAM_SECONDS} ثانية.`;
    }
    spam.start(api, threadID, message, seconds);
    await send(`🔁 بدأ السبام كل ${seconds} ثانية.\nللإيقاف: stop أو spamoff أو rest${note}`);
  },
};
});

// ══════════════ commands/stop ══════════════
__def('commands/stop', function (module, exports, require) {
'use strict';
const spam = require('../src/spam');

module.exports = {
  names: ['stop', 'spamoff'],
  category: 'tools',
  desc: 'إيقاف السبام في هذه المحادثة',
  noArgs: true,
  async run({ threadID, send }) {
    await send(spam.stop(threadID) ? '⏹ تم إيقاف السبام.' : 'ℹ️ لا يوجد سبام نشط هنا.');
  },
};
});

// ══════════════ commands/uid ══════════════
__def('commands/uid', function (module, exports, require) {
'use strict';
const { resolveTargets } = require('../src/utils');

module.exports = {
  names: ['uid', 'id'],
  category: 'members',
  hint: '(رد / تاغ / رابط حساب)',
  desc: 'عرض ايدي الحساب (أرقام فقط)',
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx);
    if (ids.length) {
      await ctx.send(ids.join('\n'));
      if (failed.length) await ctx.send(`⚠️ تعذر استخراج: ${failed.join(' , ')}`);
      return;
    }
    if (failed.length) {
      return void (await ctx.send(`⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}\nجرّب رابط profile.php?id=… أو الرد على رسالته.`));
    }
    await ctx.send(ctx.senderID); // بدون هدف: ايدي المرسل نفسه
  },
};
});

// ══════════════ commands/undev ══════════════
__def('commands/undev', function (module, exports, require) {
'use strict';
const store = require('../src/store');
const { resolveTargets, isAdmin } = require('../src/utils');

module.exports = {
  names: ['undev'],
  category: 'admin',
  hint: '(رد / تاغ / رابط / ايدي)',
  desc: 'نزع صلاحية مطور',
  adminOnly: true,
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx);
    if (!ids.length) {
      return void (await ctx.send(failed.length ? `⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}` : '✏️ الاستخدام: رد على رسالة العضو أو تاغ ثم اكتب undev'));
    }
    const removed = [];
    for (const id of ids) {
      if (isAdmin(id)) {
        await ctx.send('🚫 لا يمكن نزع صلاحية المطور الأساسي.');
        continue;
      }
      const i = store.data.devs.indexOf(id);
      if (i !== -1) {
        store.data.devs.splice(i, 1);
        removed.push(id);
      }
    }
    store.save();
    if (removed.length) await ctx.send(`✅ تم نزع الصلاحية من: ${removed.join(' , ')}`);
    else await ctx.send('ℹ️ ليس مطوراً أصلاً.');
  },
};
});

// ══════════════ commands/unlock ══════════════
__def('commands/unlock', function (module, exports, require) {
'use strict';
const store = require('../src/store');

module.exports = {
  names: ['unlock'],
  category: 'admin',
  desc: 'فتح الأوامر لتعمل لجميع الأعضاء',
  noArgs: true,
  devOnly: true,
  async run({ send }) {
    store.data.locked = false;
    store.save();
    await send('🔓 تم فتح الأوامر لجميع الأعضاء.\n(أوامر out / lock / unlock / dev / undev تبقى للمطورين).');
  },
};
});

// ══════════════ commands/yt ══════════════
__def('commands/yt', function (module, exports, require) {
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { TMP_DIR, YT_MAX_MINUTES, YT_COOKIES, YTDLP_EXTRA_ARGS } = require('../src/config');
const { call, rmSafe, errMsg } = require('../src/utils');

const MAX_BYTES = 25 * 1024 * 1024; // حد مرفقات ماسنجر
let busy = false;
let cookiesFile = null;
let ytdlpPromise = null;

function getCookiesFile() {
  if (!YT_COOKIES) return null;
  if (!cookiesFile) {
    cookiesFile = path.join(TMP_DIR, 'yt-cookies.txt');
    fs.writeFileSync(cookiesFile, YT_COOKIES);
  }
  return cookiesFile;
}

// ffmpeg اختياري (حزمة ffmpeg-static): إن وُجد نحوّل إلى mp3، وإلا نرسل m4a مباشرة
function getFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

function runBin(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e.message) });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// يجهّز yt-dlp: المثبّت في النظام، أو يحمّل النسخة المستقلة مرة واحدة إلى /tmp
function ensureYtDlp() {
  if (!ytdlpPromise) {
    ytdlpPromise = (async () => {
      if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
      const sys = await runBin('yt-dlp', ['--version'], 15000);
      if (sys.code === 0) return 'yt-dlp';
      if (process.platform !== 'linux') throw new Error('ثبّت yt-dlp على جهازك');
      const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
      const file = path.join(TMP_DIR, asset);
      if (!fs.existsSync(file)) {
        const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, {
          redirect: 'follow',
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const part = file + '.part';
        fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
        fs.renameSync(part, file);
      }
      fs.chmodSync(file, 0o755);
      return file;
    })().catch((e) => {
      ytdlpPromise = null; // يعيد المحاولة في الطلب القادم
      throw e;
    });
  }
  return ytdlpPromise;
}

module.exports = {
  names: ['yt', 'song', 'yout', 'يوت'],
  category: 'tools',
  hint: '+ اسم الأغنية',
  desc: 'إرسال الأغنية المطلوبة (mp3)',
  async run({ api, args, threadID, send }) {
    if (!args) return void (await send('✏️ الاستخدام: yt اسم الأغنية'));
    if (busy) return void (await send('⏳ هناك تحميل جارٍ، انتظر قليلاً.'));
    busy = true;

    const id = crypto.randomBytes(5).toString('hex');
    const prefix = `yt-${id}`;
    const searching = await send(`🔎 جاري البحث والتحميل: ${args}\n(أول مرة قد تستغرق أطول)`, { track: false });
    try {
      let bin;
      try {
        bin = await ensureYtDlp();
      } catch (e) {
        return void (await send(`❌ تعذر تجهيز أداة التحميل yt-dlp: ${errMsg(e)}`));
      }

      const cookies = getCookiesFile();
      const ffmpeg = getFfmpeg();
      const audioArgs = ffmpeg
        ? ['-x', '--audio-format', 'mp3', '--audio-quality', '5', '--ffmpeg-location', ffmpeg]
        : ['-f', 'bestaudio[ext=m4a]/bestaudio'];

      const r = await runBin(
        bin,
        [
          `ytsearch5:${args}`,
          ...audioArgs,
          '--no-playlist', '--no-warnings',
          '--match-filter', `duration<=${YT_MAX_MINUTES * 60} & !is_live`,
          '--max-downloads', '1', // أول نتيجة مناسبة فقط
          '--print', '%(title)s', '--no-simulate',
          '-o', path.join(TMP_DIR, `${prefix}.%(ext)s`),
          ...(cookies ? ['--cookies', cookies] : []),
          ...YTDLP_EXTRA_ARGS,
        ],
        4 * 60 * 1000
      );

      const files = fs.readdirSync(TMP_DIR).filter((f) => f.startsWith(prefix + '.') && !/\.(part|ytdl)$/.test(f));
      const pick = files.find((f) => f.endsWith('.mp3')) || files.find((f) => f.endsWith('.m4a')) || files[0];
      if (!pick) {
        const tail = r.err.trim().split('\n').pop() || '';
        return void (await send(`❌ لم أجد نتيجة مناسبة (أقل من ${YT_MAX_MINUTES} دقيقة).${tail ? '\n' + tail.slice(0, 150) : ''}`));
      }
      const file = path.join(TMP_DIR, pick);
      if (fs.statSync(file).size > MAX_BYTES) {
        return void (await send('❌ الملف أكبر من 25MB — جرّب أغنية أقصر.'));
      }
      const title = r.out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || args;
      await send({ body: `🎵 ${title}`, attachment: fs.createReadStream(file) });
    } finally {
      busy = false;
      await rmSafe(fs.readdirSync(TMP_DIR).filter((f) => f.startsWith(prefix + '.')).map((f) => path.join(TMP_DIR, f)));
      if (searching && searching.messageID) call(api, 'unsendMessage', searching.messageID).catch(() => {});
    }
  },
};
});

// ══════════════ index ══════════════
__def('index', function (module, exports, require) {
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const config = require('./src/config');
const store = require('./src/store');
const state = require('./src/state');
const registry = require('./src/registry');
const spam = require('./src/spam');
const { onMessage } = require('./src/handler');
const { onLogEvent } = require('./src/protect');
const { resolveUid, errMsg } = require('./src/utils');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('SIGTERM', () => process.exit(0));

/* ───────── الكوكيز ───────── */
function loadAppState() {
  let raw = (process.env.APPSTATE || '').trim();
  if (!raw) {
    const file = path.join(__dirname, 'appstate.json');
    if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
  }
  if (!raw) throw new Error('لا توجد كوكيز: ضع المتغير APPSTATE (على Railway) أو ملف appstate.json (محلياً)');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('صيغة الكوكيز غير صحيحة (يجب أن تكون مصفوفة JSON)');
  return parsed;
}

/* ───────── خادم صحي بسيط (لـ Railway) ───────── */
function startHttp() {
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OLIVE BOT OK');
    })
    .listen(config.PORT, () => console.log(`[http] listening on ${config.PORT}`));
}

/* ───────── الاستماع للأحداث ───────── */
let handle = null;
let retry = 0;
let relistenTimer = null;

function stopListener(h) {
  try {
    if (typeof h === 'function') h();
    else if (h && typeof h.stopListening === 'function') h.stopListening();
  } catch (_) {}
}

async function dispatch(api, event) {
  if (!event) return;
  if (event.type === 'message' || event.type === 'message_reply') return onMessage(api, event);
  if (event.type === 'event') return onLogEvent(api, event);
}

function onListenError(api, err) {
  let text = errMsg(err);
  try {
    text += ' ' + JSON.stringify(err);
  } catch (_) {}
  console.error('[listen] error:', text.slice(0, 300));

  if (/not_logged_in|not logged in|account_inactive|checkpoint|login_approvals/i.test(text)) {
    console.error('[bot] الكوكيز منتهية أو الحساب عليه تحقق — حدّث APPSTATE ثم أعد النشر.');
    process.exit(2);
  }
  if (relistenTimer) return;
  const delay = Math.min(60000, 3000 * 2 ** retry++);
  relistenTimer = setTimeout(() => {
    relistenTimer = null;
    listen(api);
  }, delay);
}

function listen(api) {
  stopListener(handle);
  handle = api.listenMqtt((err, event) => {
    if (err) return onListenError(api, err);
    retry = 0;
    state.lastEventAt = Date.now();
    dispatch(api, event).catch((e) => console.error('[event]', e));
  });
}

/* ───────── التشغيل ───────── */
async function onReady(api) {
  state.api = api;
  state.botID = String(api.getCurrentUserID());

  let admin = config.ADMIN_ID;
  if (admin && !/^\d+$/.test(admin)) admin = await resolveUid(admin).catch(() => null);
  state.adminID = admin || null;

  console.log(`[bot] logged in as ${state.botID} | admin: ${state.adminID || 'غير محدد!'}`);
  if (!state.adminID) console.warn('[bot] ⚠️ ADMIN_ID غير محدد أو غير صالح — لن يستجيب البوت لأحد.');

  listen(api);
  spam.resumeAll(api);
}

function main() {
  store.load();
  console.log(`[bot] ${registry.load()} أوامر جاهزة`);
  startHttp();

  let appState;
  try {
    appState = loadAppState();
  } catch (e) {
    console.error('[bot]', e.message);
    process.exit(1);
  }
  state.cookies = appState;

  const login = require('fca-unofficial');
  login(
    { appState },
    { listenEvents: true, selfListen: false, autoMarkDelivery: false, logLevel: 'error' },
    (err, api) => {
      if (err) {
        console.error('[login] فشل تسجيل الدخول:', errMsg(err));
        process.exit(1);
      }
      onReady(api).catch((e) => {
        console.error('[bot] startup error:', e);
        process.exit(1);
      });
    }
  );
}

main();
});

// ═══════════════ التشغيل ═══════════════
__load('index');
