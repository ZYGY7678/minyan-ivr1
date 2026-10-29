"use strict";
// בוט תשובות אוטומטי לפורום NodeBB
// - מתחבר כמשתמש רגיל (שם משתמש + סיסמה), בלי טוקן ניהול
// - הגדרות (סינון נושאים, שעות פעילות, מגבלות) נשלטות מכפתור בפורום דרך Control API
// - דורש Node 18+ (fetch מובנה), בלי תלויות חיצוניות

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- משתני סביבה ----------
const FORUM = (process.env.FORUM_URL || "https://mitmachim.top").replace(/\/$/, "");
const USER = process.env.BOT_USER;
const PASS = process.env.BOT_PASS;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const POLL_MS = (parseInt(process.env.POLL_SECONDS, 10) || 120) * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const botCredentialsConfigured = () => Boolean(USER && PASS && GEMINI_KEY);
if (!botCredentialsConfigured()) {
  console.warn("השרת יעלה במצב הגדרה חלקית; יש להגדיר BOT_USER, BOT_PASS ו-GEMINI_KEY ב-Render לפני הפעלת הבוט.");
}
if (!ADMIN_TOKEN) {
  console.warn("ADMIN_TOKEN חסר; ממשק השליטה לא יהיה זמין עד להגדרתו ב-Render.");
}

// ---------- הגדרות ומצב (נשמרים בקובץ) ----------
const DEFAULT_SETTINGS = {
  enabled: false, // כבוי כברירת מחדל, מדליקים מהכפתור בפורום
  filters: ["unanswered"], // all | unanswered | unread | unsolved (כולם חייבים להתקיים יחד)
  categories: [], // מזהי קטגוריות (cid). ריק = כל הקטגוריות
  maxPerHour: 4,
  maxAgeMinutes: 180, // לא עונים על נושאים ישנים מזה
  solvedTags: ["נפתר", "solved"], // תגית או סימון שמעידים שנושא נפתר
  signature: "\n\n---\n*תשובה זו נכתבה אוטומטית על ידי בוט.*",
  schedule: {
    alwaysOn: false,
    timezone: "Asia/Jerusalem",
    pauseShabbat: false, // השהיה משוערת: שישי 13:00 עד מוצ"ש 21:00
    windows: [{ days: [0, 1, 2, 3, 4, 5], from: "08:00", to: "22:00" }], // 0=ראשון ... 6=שבת
  },
};

let state = { settings: DEFAULT_SETTINGS, answered: {} };

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(raw.settings || {}) });
    state.answered = raw.answered || {};
  } catch (_) {
    /* קובץ לא קיים עדיין */
  }
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // שומרים רק 500 נושאים אחרונים כדי שהקובץ לא יתנפח
    const entries = Object.entries(state.answered).sort((a, b) => b[1] - a[1]).slice(0, 500);
    state.answered = Object.fromEntries(entries);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("שמירת מצב נכשלה:", e.message);
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  const out = {};
  out.enabled = !!s.enabled;
  const allowed = ["all", "unanswered", "unread", "unsolved"];
  out.filters = Array.isArray(s.filters) ? s.filters.filter((f) => allowed.includes(f)) : d.filters;
  if (!out.filters.length) out.filters = ["all"];
  out.categories = Array.isArray(s.categories)
    ? s.categories.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  out.maxPerHour = Math.min(60, Math.max(1, parseInt(s.maxPerHour, 10) || d.maxPerHour));
  out.maxAgeMinutes = Math.min(10080, Math.max(5, parseInt(s.maxAgeMinutes, 10) || d.maxAgeMinutes));
  out.solvedTags = Array.isArray(s.solvedTags) ? s.solvedTags.map(String).filter(Boolean).slice(0, 10) : d.solvedTags;
  out.signature = typeof s.signature === "string" ? s.signature.slice(0, 300) : d.signature;
  const sc = s.schedule || {};
  const windows = Array.isArray(sc.windows) ? sc.windows : d.schedule.windows;
  out.schedule = {
    alwaysOn: !!sc.alwaysOn,
    timezone: typeof sc.timezone === "string" && sc.timezone ? sc.timezone : d.schedule.timezone,
    pauseShabbat: !!sc.pauseShabbat,
    windows: windows
      .map((w) => ({
        days: Array.isArray(w.days) ? w.days.map(Number).filter((n) => n >= 0 && n <= 6) : [],
        from: TIME_RE.test(w.from) ? w.from : "08:00",
        to: TIME_RE.test(w.to) ? w.to : "22:00",
      }))
      .filter((w) => w.days.length)
      .slice(0, 14),
  };
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: out.schedule.timezone });
  } catch (_) {
    out.schedule.timezone = d.schedule.timezone;
  }
  return out;
}

// ---------- יומן ----------
const logBuf = [];
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logBuf.push(line);
  if (logBuf.length > 80) logBuf.shift();
}

// ---------- שעות פעילות ----------
const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10);

function nowParts(tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[p.weekday], min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}

function inSchedule() {
  const sc = state.settings.schedule;
  const { day, min } = nowParts(sc.timezone);
  if (sc.pauseShabbat) {
    if (day === 5 && min >= 13 * 60) return false;
    if (day === 6 && min < 21 * 60) return false;
  }
  if (sc.alwaysOn) return true;
  const prev = (day + 6) % 7;
  for (const w of sc.windows) {
    const from = toMin(w.from), to = toMin(w.to);
    if (from <= to) {
      if (w.days.includes(day) && min >= from && min < to) return true;
    } else {
      // חלון שחוצה חצות
      if (w.days.includes(day) && min >= from) return true;
      if (w.days.includes(prev) && min < to) return true;
    }
  }
  return false;
}

// ---------- התחברות ל-NodeBB ----------
let cookies = {};
let csrf = "";
let botUid = null;

const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

function saveCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

async function req(p, opts = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; ForumHelperBot/2.0)",
    Cookie: cookieHeader(),
    ...(opts.headers || {}),
  };
  if (csrf && opts.method && opts.method !== "GET") headers["x-csrf-token"] = csrf;
  const res = await fetch(FORUM + p, { redirect: "follow", ...opts, headers });
  saveCookies(res);
  return res;
}

async function refreshConfig() {
  const res = await req("/api/config");
  const cfg = await res.json();
  csrf = cfg.csrf_token;
  return cfg;
}

async function login() {
  cookies = {};
  botUid = null;
  await refreshConfig();
  const body = new URLSearchParams({ username: USER, password: PASS, remember: "on" });
  const res = await req("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" },
    body,
  });
  if (res.status >= 400) throw new Error(`התחברות נכשלה: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const cfg = await refreshConfig();
  let uid = cfg.loggedInUser?.uid || cfg.uid;
  if (!uid) {
    const me = await req("/api/me");
    if (me.ok) uid = (await me.json()).uid;
  }
  if (!uid) throw new Error("ההתחברות לא הצליחה (אין uid). בדוק שם משתמש, סיסמה, ואימות דו-שלבי");
  botUid = uid;
  log(`מחובר כ-uid ${botUid}`);
}

async function getJson(p) {
  let res = await req(p);
  if (res.status === 401 || res.status === 403) {
    await login();
    res = await req(p);
  }
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json();
}

// ---------- Gemini ----------
const SYSTEM_PROMPT = `אתה עוזר ידידותי בפורום בעברית המבוסס על NodeBB.
כללים:
- ענה בעברית ברורה וקצרה, בטון נעים וענייני.
- כתוב ב-Markdown של NodeBB: **הדגשה**, רשימות עם -, קוד בתוך בלוק קוד עם שם שפה, ציטוט עם >.
- אל תשתמש ב-HTML.
- התחל בתיוג מי שאתה עונה לו בפורמט @שם_משתמש.
- אם אינך יודע או שהשאלה לא ברורה, אמור זאת וביקש הבהרה. אל תמציא.
- אל תענה על נושאים פוליטיים, רפואיים או משפטיים רגישים. במקרה כזה החזר בדיוק: SKIP
- אם אין מה להוסיף (אין שאלה או בקשה), החזר בדיוק: SKIP`;

async function askGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 1500 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

// ---------- לוגיקה ----------
const stripHtml = (s) =>
  (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

let repliesLog = [];
function repliesLastHour() {
  const hourAgo = Date.now() - 3600_000;
  repliesLog = repliesLog.filter((t) => t > hourAgo);
  return repliesLog.length;
}

function isSolved(t) {
  const tags = (t.tags || []).map((x) => (x.value || x).toString());
  const solvedTags = state.settings.solvedTags;
  if (t.isSolved || t.solved === 1 || t.solved === true) return true;
  if (tags.some((tag) => solvedTags.includes(tag))) return true;
  return solvedTags.some((w) => (t.title || "").includes(w));
}

async function answerTopic(tid, { force = false } = {}) {
  const topic = await getJson(`/api/topic/${tid}`);
  if (topic.locked || topic.deleted) return "הנושא נעול או נמחק";
  const posts = topic.posts || [];
  if (!posts.length) return "אין פוסטים";
  const last = posts[posts.length - 1];
  if (!force && String(last.uid) === String(botUid)) return "הבוט כבר ענה אחרון";

  const first = posts[0];
  const recent = posts.length > 1 ? posts.slice(-6) : [];
  const ctx = [first, ...recent.filter((p) => p.pid !== first.pid)]
    .map((p) => `@${p.user?.username || "?"}:\n${stripHtml(p.content).slice(0, 2500)}`)
    .join("\n\n---\n\n");
  const prompt = `כותרת: ${topic.title}
תגיות: ${(topic.tags || []).map((t) => t.value).join(", ")}

שרשור:
${ctx}

כתוב תגובה שעונה למשתמש @${last.user?.username || ""}.`;

  const answer = await askGemini(prompt);
  if (!answer || answer.trim() === "SKIP") return "דילוג (המודל החליט לא לענות)";

  const body = { content: answer + state.settings.signature };
  if (posts.length > 1 && last.pid) body.toPid = last.pid;
  const res = await req(`/api/v3/topics/${tid}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`פרסום נכשל ${res.status} ${(await res.text()).slice(0, 300)}`);
  repliesLog.push(Date.now());
  return "נענה";
}

let busy = false;

async function tick() {
  const s = state.settings;
  if (!botCredentialsConfigured() || busy || !s.enabled || !inSchedule()) return;
  busy = true;
  try {
    if (!botUid) await login();
    const recent = await getJson("/api/recent");
    let unreadSet = null;
    if (s.filters.includes("unread")) {
      const un = await getJson("/api/unread");
      unreadSet = new Set((un.topics || []).map((t) => String(t.tid)));
    }
    const now = Date.now();
    for (const t of recent.topics || []) {
      if (!state.settings.enabled || !inSchedule()) break;
      if (state.answered[t.tid]) continue;
      if (t.locked || t.deleted) continue;
      if (String(t.uid) === String(botUid)) continue;
      if (s.categories.length && !s.categories.includes(Number(t.cid))) continue;
      const lastActivity = t.lastposttime || t.timestamp;
      if (now - lastActivity > s.maxAgeMinutes * 60_000) continue;
      if (s.filters.includes("unanswered") && t.postcount > 1) continue;
      if (unreadSet && !unreadSet.has(String(t.tid))) continue;
      if (s.filters.includes("unsolved") && isSolved(t)) continue;
      if (repliesLastHour() >= s.maxPerHour) {
        log("הגעת למגבלת התגובות לשעה");
        break;
      }
      state.answered[t.tid] = now; // מסמנים מראש כדי לא לנסות שוב ושוב
      saveState();
      try {
        const r = await answerTopic(t.tid);
        log(`נושא ${t.tid} "${t.title}": ${r}`);
      } catch (e) {
        log(`שגיאה בנושא ${t.tid}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 15_000)); // הפסקה בין תגובות
    }
  } catch (e) {
    log(`שגיאת סבב: ${e.message}`);
    botUid = null;
  } finally {
    busy = false;
  }
}

// ---------- Control API (לכפתור בפורום) ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 100_000) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function statusObj() {
  return {
    settings: state.settings,
    status: {
      loggedIn: !!botUid,
      botConfigured: botCredentialsConfigured(),
      inSchedule: inSchedule(),
      repliesLastHour: repliesLastHour(),
      serverTime: new Date().toISOString(),
      log: logBuf.slice(-25),
    },
  };
}

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, "http://localhost");
  rs.setHeader("Access-Control-Allow-Origin", "*");
  rs.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
  rs.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (rq.method === "OPTIONS") { rs.statusCode = 204; return rs.end(); }

  const json = (code, obj) => {
    rs.statusCode = code;
    rs.setHeader("Content-Type", "application/json; charset=utf-8");
    rs.end(JSON.stringify(obj));
  };

  if (url.pathname === "/" || url.pathname === "/health") return rs.end("ok");

  if (url.pathname.startsWith("/control/")) {
    if (rq.headers["x-admin-token"] !== ADMIN_TOKEN) return json(401, { error: "unauthorized" });
    try {
      if (url.pathname === "/control/settings" && rq.method === "GET") return json(200, statusObj());
      if (url.pathname === "/control/settings" && rq.method === "POST") {
        const body = await readBody(rq);
        state.settings = sanitizeSettings({ ...state.settings, ...body });
        saveState();
        log("הגדרות עודכנו מהפורום");
        setTimeout(tick, 500);
        return json(200, statusObj());
      }
      if (url.pathname === "/control/answer-now" && rq.method === "POST") {
        const body = await readBody(rq);
        const tid = parseInt(body.tid, 10);
        if (!tid) return json(400, { error: "missing tid" });
        if (!botUid) await login();
        const r = await answerTopic(tid, { force: true });
        state.answered[tid] = Date.now();
        saveState();
        log(`ידני, נושא ${tid}: ${r}`);
        return json(200, { result: r });
      }
      return json(404, { error: "not found" });
    } catch (e) {
      log(`שגיאת control: ${e.message}`);
      return json(500, { error: e.message });
    }
  }
  json(404, { error: "not found" });
});

loadState();
saveState();
server.listen(process.env.PORT || 3000, () => log("השרת עלה"));
setInterval(tick, POLL_MS);
setTimeout(tick, 5000);
