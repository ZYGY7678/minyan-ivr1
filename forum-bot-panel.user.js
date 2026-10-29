// ==UserScript==
// @name         פאנל שליטה בבוט הפורום
// @namespace    zygy.forum.bot
// @version      1.0.0
// @description  כפתור על גבי הפורום לשליטה בבוט: סינון נושאים, שעות פעילות, הפעלה וכיבוי
// @match        https://mitmachim.top/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const DAYS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
  let current = null;

  const css = `
  #fbot-btn{position:fixed;bottom:16px;left:16px;z-index:99999;width:48px;height:48px;border-radius:50%;
    border:none;background:#2d6cdf;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
  #fbot-panel{position:fixed;bottom:74px;left:16px;z-index:99999;width:340px;max-height:80vh;overflow:auto;
    background:#fff;color:#222;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.45);padding:12px;
    font:14px/1.4 sans-serif;direction:rtl;display:none}
  #fbot-panel h3{margin:0 0 8px;font-size:16px}
  #fbot-panel fieldset{border:1px solid #ccc;border-radius:6px;margin:8px 0;padding:6px}
  #fbot-panel legend{font-weight:bold;padding:0 4px}
  #fbot-panel label{display:block;margin:3px 0}
  #fbot-panel input[type=text],#fbot-panel input[type=password],#fbot-panel input[type=number],#fbot-panel select{
    width:100%;box-sizing:border-box;padding:4px;margin:2px 0}
  #fbot-panel input[type=time]{padding:3px}
  #fbot-panel button{padding:6px 10px;margin:4px 2px;border:none;border-radius:5px;background:#2d6cdf;color:#fff;cursor:pointer}
  #fbot-panel button.gray{background:#777}
  #fbot-panel .win{border:1px dashed #aaa;border-radius:5px;padding:4px;margin:4px 0}
  #fbot-panel .day{display:inline-block;margin-left:6px}
  #fbot-log{background:#111;color:#9f9;font:11px monospace;direction:ltr;white-space:pre-wrap;max-height:120px;overflow:auto;padding:4px;border-radius:4px}
  #fbot-msg{color:#b00;min-height:18px}
  #fbot-topic{position:fixed;bottom:16px;left:76px;z-index:99999;padding:8px 12px;border:none;border-radius:20px;
    background:#444;color:#fff;cursor:pointer;display:none}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- קריאה לשרת ----------
  function call(method, path, body) {
    return new Promise((resolve, reject) => {
      const server = (GM_getValue("server", "") || "").replace(/\/$/, "");
      const token = GM_getValue("token", "");
      if (!server || !token) return reject(new Error("הגדר כתובת שרת וטוקן"));
      GM_xmlhttpRequest({
        method,
        url: server + path,
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 60000,
        onload: (r) => {
          let j = null;
          try { j = JSON.parse(r.responseText); } catch (_) {}
          if (r.status >= 200 && r.status < 300) resolve(j);
          else reject(new Error((j && j.error) || "שגיאה " + r.status));
        },
        onerror: () => reject(new Error("אין חיבור לשרת")),
        ontimeout: () => reject(new Error("תם הזמן")),
      });
    });
  }

  // ---------- בניית הממשק ----------
  const btn = document.createElement("button");
  btn.id = "fbot-btn";
  btn.textContent = "🤖";
  btn.title = "בקרת הבוט";
  const panel = document.createElement("div");
  panel.id = "fbot-panel";
  const topicBtn = document.createElement("button");
  topicBtn.id = "fbot-topic";
  topicBtn.textContent = "🤖 שהבוט יענה כאן";

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function winHtml(w, i) {
    const days = DAYS.map((d, n) =>
      `<span class="day"><label style="display:inline"><input type="checkbox" data-w="${i}" data-day="${n}" ${w.days.includes(n) ? "checked" : ""}> ${d}</label></span>`).join("");
    return `<div class="win">${days}<br>
      מ-<input type="time" data-w="${i}" data-k="from" value="${w.from}">
      עד <input type="time" data-w="${i}" data-k="to" value="${w.to}">
      <button class="gray" data-del="${i}">מחק</button></div>`;
  }

  function render() {
    const s = current ? current.settings : null;
    const st = current ? current.status : null;
    const conn = `
      <fieldset><legend>חיבור</legend>
        <input type="text" id="fb-server" placeholder="כתובת השרת (https://xxx.onrender.com)" value="${esc(GM_getValue("server", ""))}">
        <input type="password" id="fb-token" placeholder="ADMIN_TOKEN" value="${esc(GM_getValue("token", ""))}">
        <button id="fb-connect">התחבר / רענן</button>
      </fieldset>`;
    if (!s) {
      panel.innerHTML = `<h3>🤖 בקרת הבוט</h3>${conn}<div id="fbot-msg"></div>`;
    } else {
      panel.innerHTML = `<h3>🤖 בקרת הבוט</h3>${conn}
      <fieldset><legend>מצב</legend>
        <label><input type="checkbox" id="fb-enabled" ${s.enabled ? "checked" : ""}> הבוט פעיל</label>
        <div>פרטי בוט מוגדרים: ${st.botConfigured ? "כן" : "לא — יש להגדיר BOT_USER, BOT_PASS ו-GEMINI_KEY ב-Render"}</div>
        <div>מחובר לפורום: ${st.loggedIn ? "כן" : "לא"} | בתוך שעות הפעילות: ${st.inSchedule ? "כן" : "לא"} | תגובות בשעה האחרונה: ${st.repliesLastHour}</div>
      </fieldset>
      <fieldset><legend>אילו נושאים לענות</legend>
        <label><input type="checkbox" data-f="all" ${s.filters.includes("all") ? "checked" : ""}> הכל (ללא סינון)</label>
        <label><input type="checkbox" data-f="unanswered" ${s.filters.includes("unanswered") ? "checked" : ""}> רק בלי תגובות</label>
        <label><input type="checkbox" data-f="unread" ${s.filters.includes("unread") ? "checked" : ""}> רק שלא נקראו</label>
        <label><input type="checkbox" data-f="unsolved" ${s.filters.includes("unsolved") ? "checked" : ""}> רק שלא נפתרו</label>
        <label>קטגוריות (מספרים, מופרדים בפסיק, ריק = כולן)
          <input type="text" id="fb-cats" value="${esc(s.categories.join(","))}"></label>
        <label>תגיות שמסמנות "נפתר" (מופרדות בפסיק)
          <input type="text" id="fb-solved" value="${esc(s.solvedTags.join(","))}"></label>
      </fieldset>
      <fieldset><legend>מגבלות</legend>
        <label>מקסימום תגובות לשעה <input type="number" id="fb-max" min="1" max="60" value="${s.maxPerHour}"></label>
        <label>לא לענות על נושאים ישנים מ (דקות) <input type="number" id="fb-age" min="5" value="${s.maxAgeMinutes}"></label>
      </fieldset>
      <fieldset><legend>שעות פעילות</legend>
        <label><input type="checkbox" id="fb-always" ${s.schedule.alwaysOn ? "checked" : ""}> פעיל תמיד (מתעלם מהשעות)</label>
        <label><input type="checkbox" id="fb-shabbat" ${s.schedule.pauseShabbat ? "checked" : ""}> השהיה משוערת בשבת (שישי 13:00 עד מוצ"ש 21:00)</label>
        <label>אזור זמן <input type="text" id="fb-tz" value="${esc(s.schedule.timezone)}"></label>
        <div id="fb-wins">${s.schedule.windows.map(winHtml).join("")}</div>
        <button class="gray" id="fb-addwin">+ הוסף חלון זמן</button>
      </fieldset>
      <button id="fb-save">שמור</button>
      <div id="fbot-msg"></div>
      <div id="fbot-log">${esc(st.log.join("\\n"))}</div>`;
    }
    bind();
  }

  function msg(t, ok) {
    const m = panel.querySelector("#fbot-msg");
    if (m) { m.style.color = ok ? "#080" : "#b00"; m.textContent = t; }
  }

  function readForm() {
    const s = JSON.parse(JSON.stringify(current.settings));
    s.enabled = panel.querySelector("#fb-enabled").checked;
    s.filters = [...panel.querySelectorAll("[data-f]")].filter((x) => x.checked).map((x) => x.dataset.f);
    s.categories = panel.querySelector("#fb-cats").value.split(",").map((x) => parseInt(x, 10)).filter((n) => n > 0);
    s.solvedTags = panel.querySelector("#fb-solved").value.split(",").map((x) => x.trim()).filter(Boolean);
    s.maxPerHour = parseInt(panel.querySelector("#fb-max").value, 10) || 4;
    s.maxAgeMinutes = parseInt(panel.querySelector("#fb-age").value, 10) || 180;
    s.schedule.alwaysOn = panel.querySelector("#fb-always").checked;
    s.schedule.pauseShabbat = panel.querySelector("#fb-shabbat").checked;
    s.schedule.timezone = panel.querySelector("#fb-tz").value.trim() || "Asia/Jerusalem";
    s.schedule.windows = s.schedule.windows.map((w, i) => ({
      days: [...panel.querySelectorAll(`[data-w="${i}"][data-day]`)].filter((x) => x.checked).map((x) => +x.dataset.day),
      from: panel.querySelector(`[data-w="${i}"][data-k="from"]`).value || "08:00",
      to: panel.querySelector(`[data-w="${i}"][data-k="to"]`).value || "22:00",
    }));
    return s;
  }

  async function refresh() {
    try {
      current = await call("GET", "/control/settings");
      render();
    } catch (e) {
      current = null;
      render();
      msg(e.message, false);
    }
  }

  function bind() {
    const q = (s) => panel.querySelector(s);
    q("#fb-connect").onclick = () => {
      GM_setValue("server", q("#fb-server").value.trim());
      GM_setValue("token", q("#fb-token").value.trim());
      refresh();
    };
    if (!current) return;
    q("#fb-addwin").onclick = () => {
      current.settings = readForm();
      current.settings.schedule.windows.push({ days: [0, 1, 2, 3, 4, 5], from: "08:00", to: "22:00" });
      render();
    };
    panel.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () => {
        current.settings = readForm();
        current.settings.schedule.windows.splice(+b.dataset.del, 1);
        render();
      };
    });
    q("#fb-save").onclick = async () => {
      try {
        const body = readForm();
        current = await call("POST", "/control/settings", body);
        render();
        msg("נשמר", true);
      } catch (e) { msg(e.message, false); }
    };
  }

  btn.onclick = () => {
    const open = panel.style.display === "block";
    panel.style.display = open ? "none" : "block";
    if (!open) refresh();
  };

  // כפתור "שהבוט יענה בנושא הזה"
  function currentTid() {
    const w = unsafeWindow;
    return (w.ajaxify && w.ajaxify.data && w.ajaxify.data.tid) || null;
  }
  function updateTopicBtn() {
    topicBtn.style.display = /\/topic\//.test(location.pathname) && currentTid() ? "block" : "none";
  }
  topicBtn.onclick = async () => {
    const tid = currentTid();
    if (!tid) return;
    if (!confirm("לשלוח לבוט לענות בנושא הזה עכשיו?")) return;
    topicBtn.textContent = "ממתין...";
    try {
      const r = await call("POST", "/control/answer-now", { tid });
      alert("תוצאה: " + r.result);
    } catch (e) { alert(e.message); }
    topicBtn.textContent = "🤖 שהבוט יענה כאן";
  };
  setInterval(updateTopicBtn, 1500);

  document.body.append(btn, panel, topicBtn);
})();
