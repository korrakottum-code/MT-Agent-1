// MT Agent — Admin Console (หน้าเว็บ)
// ข้อมูลทุกอย่างมาจาก edge function admin-console ด้วย bearer token ที่ได้จากลิงก์ใช้ครั้งเดียว
// แท็บที่ข้อมูลเยอะโหลดตอนเปิดแท็บนั้นครั้งแรก ไม่ดึงทุกอย่างตอนเปิดหน้า

const API = "https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/admin-console";
let DATA = null;
const STATE = {
  reminders: null, checklist: null, chats: null, groups: null, usage: null, health: null,
  chat: null, chatId: null, usageDays: 30, showOpened: false, editBranch: null,
};
let current = "events";

// token มาทาง fragment ซึ่งไม่ถูกส่งไปเซิร์ฟเวอร์ใด ๆ — ย้ายเข้า sessionStorage แล้วล้าง URL ทันที
(function grabToken() {
  const m = location.hash.match(/(?:^|[#&])s=([^&]+)/);
  if (m) {
    try { sessionStorage.setItem("mt_admin", decodeURIComponent(m[1])); } catch (_) {}
    history.replaceState(null, "", location.pathname + location.search);
  }
})();
const token = () => { try { return sessionStorage.getItem("mt_admin"); } catch (_) { return null; } };

// ---------------------------------------------------------------- ตัวช่วย

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (iso, opt) => iso ? new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", ...opt }) : "";
const thaiDate = (iso) => fmt(iso, { dateStyle: "medium", timeStyle: "short" });
const thaiDay = (ymd) => ymd ? new Date(ymd + "T00:00:00+07:00").toLocaleDateString("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }) : "";
const money = (n) => "$" + Number(n || 0).toFixed(2);

// "5 นาทีก่อน" / "อีก 3 ชม." ใช้ทุกที่ที่ต้องรู้ว่าเกิดเมื่อไรเทียบกับตอนนี้
function rel(iso) {
  if (!iso) return "—";
  const d = (new Date(iso).getTime() - Date.now()) / 1000;
  const a = Math.abs(d);
  const v = a < 90 ? "ไม่กี่วินาที" : a < 3600 ? Math.round(a / 60) + " นาที" : a < 86400 * 2 ? Math.round(a / 3600) + " ชม."
    : Math.round(a / 86400) + " วัน";
  return d < 0 ? v + "ก่อน" : "อีก " + v;
}
const daysAgo = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity;

// datetime-local ไม่รู้จักเขตเวลา แปลงเป็นเวลาไทยไปกลับเอง
const toLocalInput = (iso) => iso ? new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16) : "";
const fromLocalInput = (v) => v ? v + ":00+07:00" : null;

function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = "none"; }, 3500);
}

function lockOut(reason) {
  try { sessionStorage.removeItem("mt_admin"); } catch (_) {}
  $("app").hidden = true;
  const g = $("gate");
  g.style.display = "grid";
  if (reason) g.querySelector("h1").textContent = "🔒 " + reason;
}

async function api(path, options) {
  const t = token();
  if (!t) { lockOut(); return null; }
  const res = await fetch(API + path, {
    ...options,
    headers: { ...(options && options.headers), authorization: "Bearer " + t },
  });
  if (res.status === 401) { lockOut("เซสชันหมดอายุแล้ว"); return null; }
  return res.json();
}

// ทำคำสั่งแล้วโหลดแท็บปัจจุบันใหม่ จะได้เห็นผลจริงจากฐานข้อมูล ไม่ใช่ค่าที่หน้าเว็บเดาเอา
async function act(payload, label) {
  const out = await api("/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!out) return null;
  if (out.error) { toast(out.error, true); return null; }
  toast(out.note ? label + " · " + out.note : label);
  if (!out.logout) {
    if (["events", "users", "dash"].includes(current)) await loadData();
    else await show(current, true);
  }
  return out;
}

// ---------------------------------------------------------------- แท็บ

const TABS = {
  events: { render: renderEvents },
  reminders: { load: () => api("/reminders"), key: "reminders", render: renderReminders },
  checklist: { load: () => api("/checklist"), key: "checklist", render: renderChecklist },
  chats: { load: () => api("/chats"), key: "chats", render: renderChats },
  groups: { load: () => api("/groups"), key: "groups", render: renderGroups },
  users: { render: renderUsers },
  usage: { load: () => api("/usage?days=" + STATE.usageDays), key: "usage", render: renderUsage },
  health: { load: () => api("/health"), key: "health", render: renderHealth },
  dash: { render: renderDash },
};

async function show(tab, force) {
  current = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  Object.keys(TABS).forEach((k) => { $("tab-" + k).hidden = k !== tab; });
  const t = TABS[tab];
  if (t.load && (force || STATE[t.key] == null)) {
    if (STATE[t.key] == null) $("tab-" + tab).innerHTML = "<div class='empty'>กำลังโหลด…</div>";
    const out = await t.load();
    if (!out) return;
    STATE[t.key] = out;
    if (tab === "health") paintHealthDot();
  }
  if (DATA) $("tab-" + tab).innerHTML = t.render();
}

const refreshBtn = "<button class='small' data-act='refresh'>รีเฟรช</button>";

async function loadData() {
  const out = await api("/data");
  if (!out) return;
  DATA = out;
  $("gate").style.display = "none";
  $("app").hidden = false;
  $("who").textContent = DATA.me.display_name + " · ADMIN";
  $("badge").textContent = DATA.events.length ? "(" + DATA.events.length + ")" : "";
  await show(current);
}

// ---------------------------------------------------------------- คิวยืนยัน

function renderEvents() {
  const list = DATA.events;
  if (!list.length) {
    return "<div class='empty'>ไม่มีรายการรอยืนยัน 🎉<br><span style='font-size:13px'>ระบบอ่านบทสนทนาในกลุ่มทุก 3 ชั่วโมง " +
      "กลุ่มที่คนคุยกันน้อยกว่า 3 ข้อความจะถูกข้าม</span></div>";
  }
  const people = DATA.users.filter((u) => u.is_active);
  return list.map((e) => {
    const owner = people.map((u) => `<option value="${u.id}"${u.id === e.owner_user_id ? " selected" : ""}>${esc(u.display_name)}</option>`).join("");
    return `<div class="card" data-ev="${esc(e.id)}">
      <div class="row"><span class="tag ${esc(e.type)}">${esc(e.type)}</span><b class="grow">${esc(e.title)}</b>
        <span class="muted">${esc(e.group_name)}</span></div>
      ${e.detail ? `<div class="muted" style="margin-top:6px">${esc(e.detail)}</div>` : ""}
      ${e.source_excerpt ? `<div class="excerpt">${esc(e.source_excerpt)}</div>` : ""}
      <div class="row" style="margin-top:10px"><span class="muted">${e.due_at ? "⏰ " + thaiDate(e.due_at) + " · " : ""}
        มั่นใจ ${Math.round((e.confidence || 0) * 100)}% · จับได้ ${thaiDate(e.created_at)}</span></div>
      <div class="row" style="margin-top:10px">
        ${e.type === "DECISION" ? "<span class='muted'>ข้อตกลง — ยืนยันแล้วเก็บเป็นความจำองค์กร ไม่สร้างเป็นงาน</span>"
          : `<label class="muted">มอบให้ <select class="owner">${owner}</select></label>`}
        <span class="grow"></span>
        <button class="primary" data-act="ev-go">ยืนยัน</button>
        <button class="danger" data-act="ev-no">ปัดทิ้ง</button>
      </div></div>`;
  }).join("");
}

// ---------------------------------------------------------------- ตัวเตือน

const REPEAT = { "": "ครั้งเดียว", daily: "ทุกวัน", weekdays: "ทุกวันทำงาน", weekly: "ทุกสัปดาห์" };

function renderReminders() {
  const r = STATE.reminders;
  const opts = (map, cur) => Object.entries(map).map(([v, l]) => `<option value="${v}"${(cur ?? "") === v ? " selected" : ""}>${l}</option>`).join("");
  const pending = r.pending.map((x) => `<div class="card" data-rem="${esc(x.id)}">
      <div class="row">
        <span class="tag ${x.kind === "AGENT" ? "accent" : ""}">${x.kind === "AGENT" ? "คิดใหม่ทุกรอบ" : "ข้อความตายตัว"}</span>
        <span class="tag">${REPEAT[x.repeat_rule ?? ""]}</span>
        <span class="muted grow">${esc(x.chat)}</span>
        <span class="muted">ส่งครั้งถัดไป <b style="color:var(--text)">${thaiDate(x.remind_at)}</b> (${rel(x.remind_at)})</span>
      </div>
      ${x.last_error ? `<div class="banner warn" style="margin:10px 0 0">⚠️ ส่งไม่ออกล่าสุด ${rel(x.last_failed_at)}: ${esc(x.last_error)}
        ${x.fail_count > 1 ? `(พลาดมาแล้ว ${x.fail_count} ครั้ง)` : ""}</div>` : ""}
      <textarea class="msg" style="margin-top:10px">${esc(x.message)}</textarea>
      <div class="row" style="margin-top:8px">
        <label class="muted">เวลา <input type="datetime-local" class="at" value="${toLocalInput(x.remind_at)}"></label>
        <label class="muted">รอบ <select class="rep">${opts(REPEAT, x.repeat_rule)}</select></label>
        <label class="muted">ชนิด <select class="kind">${opts({ TEXT: "ข้อความตายตัว", AGENT: "คิดใหม่ทุกรอบ" }, x.kind)}</select></label>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="muted grow">ตั้งโดย ${esc(x.created_by ?? "?")}${x.target && x.target !== x.created_by ? " · เตือน " + esc(x.target) : ""}
          · ส่งล่าสุด ${x.sent_at ? rel(x.sent_at) : "ยังไม่เคยส่ง"}${x.repeat_count ? ` · ส่งไปแล้ว ${x.repeat_count} รอบ` : ""}</span>
        <button class="primary small" data-act="rem-save">บันทึก</button>
        <button class="small" data-act="rem-now">ส่งตอนนี้</button>
        <button class="danger small" data-act="rem-cancel">ยกเลิก</button>
      </div></div>`).join("");

  const recent = r.recent.length ? `<div class="card scroll"><h3>ส่งแล้ว / ยกเลิก ใน 7 วัน</h3><table>
      <tr><th>แชท</th><th>ข้อความ</th><th>สถานะ</th><th>ส่งเมื่อ</th></tr>
      ${r.recent.map((x) => `<tr><td>${esc(x.chat)}</td><td>${esc(String(x.message).slice(0, 80))}</td>
        <td><span class="tag ${x.status === "SENT" ? "ok" : ""}">${x.status === "SENT" ? "ส่งแล้ว" : "ยกเลิก"}</span>
          ${x.last_error ? `<span class="bad"> ⚠️ ${esc(x.last_error)}</span>` : ""}</td>
        <td class="muted">${x.sent_at ? thaiDate(x.sent_at) : "—"}</td></tr>`).join("")}</table></div>` : "";

  return `<div class="row" style="margin-bottom:12px"><span class="muted grow">ตัวเตือนที่รอส่ง ${r.pending.length} อัน ·
      แบบ <b>คิดใหม่ทุกรอบ</b> ข้อความคือคำสั่งที่แงวจะทำตอนถึงเวลา เช่น สรุปเช็กลิสต์ของวันนั้น</span>${refreshBtn}</div>
    ${pending || "<div class='empty'>ไม่มีตัวเตือนที่รอส่ง</div>"}${recent}`;
}

// ---------------------------------------------------------------- เช็กลิสต์เปิดสาขา

function daysLeft(ymd, today) {
  return Math.round((new Date(ymd + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000);
}

function renderChecklist() {
  const c = STATE.checklist;
  const items = c.config.items || [];
  const start = c.config.start_days_before ?? 14;
  const ready = c.config.ready_days_before ?? 7;
  const list = c.branches.filter((b) => STATE.showOpened || b.open_date >= c.today);

  const edit = STATE.editBranch;
  const editing = edit === "new" ? {} : c.branches.find((b) => b.id === edit);
  const form = editing ? `<div class="card" id="branchForm" data-id="${esc(editing.id ?? "")}">
      <h3>${editing.id ? "แก้สาขา " + esc(editing.name) : "เพิ่มสาขา"}</h3>
      <div class="row">
        <label class="muted">ชื่อ <input type="text" class="f-name" value="${esc(editing.name)}" size="16"></label>
        <label class="muted">แบรนด์ <input type="text" class="f-brand" value="${esc(editing.brand ?? "CLASS CLINIC")}" size="12"></label>
        <label class="muted">วันเปิด <input type="date" class="f-date" value="${esc(editing.open_date ?? "")}"></label>
        <label class="muted">ชื่อย่อ <input type="text" class="f-alias" value="${esc((editing.aliases ?? []).join(", "))}" placeholder="PLD" size="10"></label>
      </div>
      <label class="muted" style="display:block;margin-top:8px">หมายเหตุ <input type="text" class="f-note" value="${esc(editing.note ?? "")}" style="width:100%"></label>
      <div class="row" style="margin-top:10px"><span class="grow"></span>
        <button data-act="chk-cancel">ยกเลิก</button><button class="primary" data-act="chk-save">บันทึก</button></div></div>` : "";

  const rows = list.map((b) => {
    const left = daysLeft(b.open_date, c.today);
    const missing = items.filter((i) => !(b.items?.[i.key]?.done)).length;
    const badge = left < 0 ? `<span class="tag">เปิดแล้ว</span>`
      : left < ready && missing ? `<span class="tag bad">อีก ${left} วัน · เลยเส้นพร้อม</span>`
      : left <= start ? `<span class="tag accent">อีก ${left} วัน</span>`
      : `<span class="muted">อีก ${left} วัน</span>`;
    const owner = `<select data-act="chk-owner" data-id="${esc(b.id)}"><option value="">—</option>
      ${c.people.map((p) => `<option value="${p.id}"${p.id === b.owner_user_id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
    const cells = items.map((i) => {
      const s = b.items?.[i.key] || {};
      const tip = s.at ? `${s.done ? "ติ๊ก" : "เอาออก"}โดย ${s.by ?? "?"} ${thaiDate(s.at)}${s.note ? " · " + s.note : ""}` : "ยังไม่มีใครติ๊ก";
      return `<td class="chk" title="${esc(tip)}"><label><input type="checkbox" data-act="chk-item" data-id="${esc(b.id)}" data-key="${esc(i.key)}"${s.done ? " checked" : ""}>
        ${s.done && s.by ? `<span class="muted" style="font-size:11px">${esc(s.by)}</span>` : ""}</label></td>`;
    }).join("");
    return `<tr class="${left < 0 ? "off" : ""}">
      <td><b>${esc(b.name)}</b> <span class="tag">${esc(b.brand ?? "")}</span>
        ${(b.aliases ?? []).length ? `<span class="muted"> · ${esc(b.aliases.join(", "))}</span>` : ""}
        ${b.note ? `<div class="muted" style="font-size:12px;margin-top:3px">${esc(b.note)}</div>` : ""}</td>
      <td style="white-space:nowrap">${thaiDay(b.open_date)}<br>${badge}</td>
      ${cells}
      <td>${owner}</td>
      <td style="white-space:nowrap"><button class="small" data-act="chk-edit" data-id="${esc(b.id)}">แก้</button>
        <button class="small danger" data-act="chk-remove" data-id="${esc(b.id)}">ซ่อน</button></td></tr>`;
  }).join("");

  return `<div class="row" style="margin-bottom:12px">
      <span class="muted grow">เริ่มเตรียม ${start} วันก่อนเปิด · ทุกข้อต้องพร้อมก่อนเปิด ${ready} วัน ·
        ติ๊กจากที่นี่ หรือบอกแงวในแชท เช่น "เพจปลวกแดงสร้างแล้ว"</span>
      <label class="muted"><input type="checkbox" data-act="chk-opened"${STATE.showOpened ? " checked" : ""}> แสดงสาขาที่เปิดแล้ว</label>
      <button class="small" data-act="chk-new">+ เพิ่มสาขา</button>${refreshBtn}</div>
    ${form}
    <div class="card scroll"><table>
      <tr><th>สาขา</th><th>วันเปิด</th>${items.map((i) => `<th class="chk" style="white-space:normal;min-width:72px">${esc(i.label)}</th>`).join("")}
        <th>เจ้าของ</th><th></th></tr>
      ${rows || `<tr><td colspan="${items.length + 4}" class="empty">ไม่มีสาขาที่กำลังจะเปิด</td></tr>`}
    </table></div>`;
}

// ---------------------------------------------------------------- แชท

function renderChats() {
  const c = STATE.chats;
  const list = c.groups.map((g) => `<button data-act="chat-open" data-id="${esc(g.chat_id)}" class="${STATE.chatId === g.chat_id ? "on" : ""}">
      <b>${esc(g.name ?? "(ไม่มีชื่อ)")}</b>${g.active ? "" : " <span class='tag'>ปิดอยู่</span>"}<br>
      <span class="muted">${g.human_messages} ข้อความ/30 วัน · แงวตอบ ${g.answers} · ${g.last_used ? "ใช้ล่าสุด " + rel(g.last_used) : "ยังไม่เคยใช้แงว"}</span></button>`).join("");
  const flagged = `<button data-act="chat-flagged" class="${STATE.chatId === "__flagged" ? "on" : ""}">🚩 คำตอบที่ติดธงไว้ (${c.open_flags})</button>`;

  let right = "<div class='empty'>เลือกแชททางซ้ายเพื่ออ่านย้อนหลัง</div>";
  if (STATE.chat) {
    const msgs = STATE.chat.messages.map((m) => `<div class="msg ${m.bot ? "bot" : ""} ${m.flag ? "flagged" : ""}">
        <div class="row"><b>${esc(m.who)}</b><span class="muted grow">${thaiDate(m.at)}</span>
          ${m.bot ? (m.flag
            ? `<span class="tag bad">🚩 ${esc(m.flag.reason || "ติดธง")}</span><button class="small" data-act="unflag" data-id="${esc(m.flag.id)}">ปลดธง</button>`
            : `<button class="small" data-act="flag" data-id="${esc(m.id)}">ติดธง</button>`) : ""}</div>
        <div class="t">${esc(m.text)}</div></div>`).join("");
    right = `<div class="row" style="margin-bottom:10px"><b class="grow">${esc(STATE.chat.chat)}</b>
        <span class="muted">ใหม่ไปเก่า</span></div>
      <p class="muted" style="margin:0 0 10px">ข้อความทุกอันถูกบันทึกและแอดมินดูได้ แงวบอกพนักงานตามจริงเรื่องนี้ (กฎข้อ 16)
        ติดธงคำตอบที่แย่ไว้ เป็นกองตัวอย่างสำหรับแก้และเขียนข้อสอบเพิ่ม</p>
      ${msgs || "<div class='empty'>ไม่มีข้อความ</div>"}
      ${STATE.chat.more ? "<button data-act='chat-more' style='width:100%'>โหลดเก่ากว่านี้</button>" : ""}`;
  }
  return `<div class="row" style="margin-bottom:12px"><span class="grow"></span>${refreshBtn}</div>
    <div class="chatgrid"><div class="chatlist">${flagged}${list}</div><div>${right}</div></div>`;
}

async function openChat(id, append) {
  const flagged = id === "__flagged";
  const before = append && STATE.chat?.messages.length ? STATE.chat.messages[STATE.chat.messages.length - 1].at : null;
  const q = flagged ? "?flagged=1" : "?id=" + encodeURIComponent(id);
  const out = await api("/chat" + q + (before ? "&before=" + encodeURIComponent(before) : ""));
  if (!out) return;
  if (append && STATE.chat) {
    STATE.chat.messages = STATE.chat.messages.concat(out.messages);
    STATE.chat.more = out.more;
  } else {
    STATE.chat = out;
  }
  STATE.chatId = id;
  $("tab-chats").innerHTML = renderChats();
}

// ---------------------------------------------------------------- กลุ่ม

function renderGroups() {
  const rows = STATE.groups.groups.map((g) => `<tr data-grp="${esc(g.id)}" class="${g.is_active ? "" : "off"}">
      <td><input type="text" class="gname" value="${esc(g.group_name ?? "")}" size="22">
        <button class="small" data-act="grp-rename">บันทึก</button></td>
      <td class="num">${g.human_messages}</td><td class="num">${g.answers}</td>
      <td class="${daysAgo(g.last_used) > 7 ? "warn" : ""}">${g.last_used ? rel(g.last_used) : "ยังไม่เคยใช้"}</td>
      <td class="chk"><input type="checkbox" data-act="grp-monday"${g.monday_enabled ? " checked" : ""}></td>
      <td class="chk"><input type="checkbox" data-act="grp-active"${g.is_active ? " checked" : ""}></td></tr>`).join("");
  return `<div class="row" style="margin-bottom:12px"><span class="muted grow">เปลี่ยนชื่อที่นี่เปลี่ยนเฉพาะชื่อในระบบ ชื่อกลุ่มใน LINE ต้องเปลี่ยนในแอป ·
      Monday ผูกกับกลุ่ม ไม่ได้ผูกกับชื่อ เปลี่ยนชื่อแล้วไม่กระทบ</span>${refreshBtn}</div>
    <div class="card scroll"><table>
      <tr><th>ชื่อในระบบ</th><th class="num">ข้อความคน 30 วัน</th><th class="num">แงวตอบ</th><th>ใช้แงวล่าสุด</th>
        <th class="chk">Monday</th><th class="chk">ใช้งาน</th></tr>${rows}</table></div>`;
}

// ---------------------------------------------------------------- พนักงาน

function renderUsers() {
  const rows = DATA.users.map((u) => {
    const pending = String(u.line_user_id || "").startsWith("pending:");
    const roles = ["EMPLOYEE", "MANAGER", "EXECUTIVE", "ADMIN"].map((r) => `<option value="${r}"${r === u.role ? " selected" : ""}>${r}</option>`).join("");
    return `<tr data-u="${esc(u.id)}" class="${u.is_active ? "" : "off"}">
      <td><b>${esc(u.display_name)}</b>${pending ? " <span class='tag'>ยังไม่ผูก LINE</span>" : ""}</td>
      <td><select class="role">${roles}</select></td>
      <td><input type="text" class="job" value="${esc(u.job_title)}" placeholder="ตำแหน่ง" size="16"></td>
      <td><input type="text" class="dept" value="${esc(u.department)}" placeholder="แผนก" size="12"></td>
      <td style="text-align:right;white-space:nowrap"><button data-act="u-save">บันทึก</button>
        <button class="${u.is_active ? "danger" : ""}" data-act="u-toggle">${u.is_active ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button></td></tr>`;
  }).join("");
  return `<div class="card scroll"><table><tr><th>ชื่อ</th><th>สิทธิ์</th><th>ตำแหน่ง</th><th>แผนก</th><th></th></tr>${rows}</table></div>
    <p class="muted">เปลี่ยนสิทธิ์หรือแก้ตำแหน่งแล้วกดบันทึก · ทุกการเปลี่ยนแปลงถูกบันทึกลง audit log</p>`;
}

// ---------------------------------------------------------------- การใช้งาน

function renderUsage() {
  const u = STATE.usage;
  const spend = Object.fromEntries((u.spend || []).map((s) => [s.purpose, Number(s.usd || 0)]));
  const chatUsd = spend.chat || 0;
  const evalUsd = (spend.eval || 0) + (spend.gate || 0);
  const jobsUsd = Object.entries(spend).filter(([k]) => !["chat", "eval", "gate"].includes(k)).reduce((a, [, v]) => a + v, 0);
  const answers = u.people.reduce((a, p) => a + Number(p.answers || 0), 0);
  const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const stale = (iso) => daysAgo(iso) > 7 ? "warn" : "";

  const chats = u.chats.filter((c) => Number(c.answers) > 0 || Number(c.human_messages) > 0).map((c) => `<tr>
      <td>${esc(c.chat_name)}</td><td class="num">${c.answers}</td><td class="num">${c.people}</td><td class="num">${c.active_days}</td>
      <td class="${stale(c.last_used)}">${c.last_used ? rel(c.last_used) : "—"}</td><td class="num">${c.human_messages}</td>
      <td class="num">${money(Number(c.chat_usd) + Number(c.jobs_usd))}</td></tr>`).join("");
  const people = u.people.map((p) => `<tr>
      <td>${esc(p.display_name)} <span class="tag">${esc(p.role)}</span></td><td class="num">${p.answers}</td>
      <td class="num">${p.active_days}</td><td class="${stale(p.last_used)}">${rel(p.last_used)}</td>
      <td class="muted">${esc(p.chats)}</td><td class="num">${money(p.usd)}</td></tr>`).join("");

  return `<div class="row" style="margin-bottom:12px"><label class="muted">ช่วงเวลา
      <select data-act="usage-days">${[7, 30, 90].map((d) => `<option value="${d}"${d === u.days ? " selected" : ""}>${d} วัน</option>`).join("")}</select></label>
      <span class="grow"></span>${refreshBtn}</div>
    <div class="tiles">${tile(answers, "ครั้งที่แงวตอบคนจริง")}${tile(money(chatUsd), "ค่าตอบแชท")}
      ${tile(money(jobsUsd), "ค่างานอัตโนมัติ")}${tile(money(evalUsd), "ค่าข้อสอบ")}</div>
    ${evalUsd > chatUsd ? `<div class="banner warn">ค่าข้อสอบสูงกว่าค่าใช้งานจริง ${(evalUsd / Math.max(chatUsd, 0.01)).toFixed(1)} เท่า ·
      ข้อสอบรันเองทุกครั้งที่ push โค้ด และทุกครั้งที่สั่งรันเอง ระหว่างไล่แก้ให้ยิงเฉพาะข้อที่เกี่ยว (-Only) อย่ารันเต็มชุดซ้ำ ๆ</div>` : ""}
    <div class="card scroll"><h3>รายกลุ่ม</h3><table>
      <tr><th>แชท</th><th class="num">แงวตอบ</th><th class="num">คนใช้</th><th class="num">ใช้กี่วัน</th><th>ล่าสุด</th>
        <th class="num">ข้อความคน</th><th class="num">ค่าใช้จ่าย</th></tr>${chats}</table></div>
    <div class="card scroll"><h3>รายคน</h3><table>
      <tr><th>ใคร</th><th class="num">แงวตอบ</th><th class="num">ใช้กี่วัน</th><th>ล่าสุด</th><th>ใช้ที่ไหน</th><th class="num">ค่าใช้จ่าย</th></tr>${people}</table></div>
    <p class="muted">นับเฉพาะครั้งที่แงวตอบคนจริง ไม่รวมข้อสอบ (ข้อสอบยิงในนามคนจริงและจะทำให้ตัวเลขเพี้ยน) ·
      สีเหลือง = ไม่ได้ใช้เกิน 7 วัน · ค่าใช้จ่ายคิดจากตาราง model_prices ในฐานข้อมูล ยอดจริงดูที่บิลของแต่ละค่าย</p>`;
}

// ---------------------------------------------------------------- สุขภาพระบบ

const JOB_TH = {
  "due-reminders": "ตัวเตือน + เฝ้าโควตา", "checkin-summary": "สรุปเช็กชื่อ", "daily-summary": "สรุปเย็น",
  "morning-reminder": "ปลุกเช้า", "weekly-summary": "สรุปรายสัปดาห์", "extract-events": "อ่านแชทจับงาน",
  "daily-context": "สรุปบริบทกลางคืน",
};

function healthProblems(h) {
  const p = [];
  if (h.push_blocked) p.push("โควตา LINE หมด");
  if (h.quota?.pct >= 80) p.push(`โควตา LINE ใช้ไป ${h.quota.pct}%`);
  if ((h.jobs || []).some((j) => Number(j.failed_24h) > 0)) p.push("งานตามเวลาพลาดใน 24 ชม.");
  if ((h.failures || []).some((f) => daysAgo(f.at) < 1)) p.push("มีข้อความส่งไม่ออกใน 24 ชม.");
  return p;
}

function paintHealthDot() {
  const h = STATE.health;
  if (!h) return;
  $("healthDot").textContent = healthProblems(h).length ? "🔴" : "";
}

function renderHealth() {
  const h = STATE.health;
  const q = h.quota;
  const pctClass = q?.pct >= 95 ? "var(--bad)" : q?.pct >= 80 ? "var(--warn)" : "var(--ok)";
  const quota = !q ? "<span class='bad'>อ่านโควตาจาก LINE ไม่ได้</span>"
    : !q.limited ? "แพ็กเกจไม่จำกัดจำนวนข้อความ"
    : `<b style="font-size:22px">${q.used.toLocaleString()}</b> <span class="muted">จาก ${q.limit.toLocaleString()} ข้อความ (${q.pct}%)</span>
       <div class="bar"><i style="width:${Math.min(100, q.pct)}%;background:${pctClass}"></i></div>
       <span class="muted">เฉลี่ยวันละ ${q.per_day} · ${q.runs_out
         ? `<b class="warn">ถ้าใช้เท่านี้น่าจะหมดราว ${thaiDay(q.runs_out)}</b>` : "ใช้เท่านี้ไม่หมดก่อนสิ้นเดือน"}
       · แจ้งตั้มในแชทส่วนตัวเองที่ 80% และ 95%</span>`;
  const jobs = (h.jobs || []).map((j) => `<tr>
      <td>${esc(JOB_TH[j.jobname] || j.jobname)}<br><span class="muted">${esc(j.jobname)} · ${esc(j.schedule)}</span></td>
      <td>${j.last_start ? rel(j.last_start) : "ยังไม่เคยรัน"}</td>
      <td><span class="tag ${j.last_status === "succeeded" ? "ok" : "bad"}">${esc(j.last_status || "—")}</span></td>
      <td class="num">${j.runs_24h}</td><td class="num ${Number(j.failed_24h) > 0 ? "bad" : ""}">${j.failed_24h}</td></tr>`).join("");
  const fails = (h.failures || []).length ? (h.failures || []).map((f) => `<tr><td class="muted" style="white-space:nowrap">${thaiDate(f.at)}</td>
      <td><span class="tag bad">${esc(f.kind)}</span></td><td>${esc(f.detail)}</td></tr>`).join("")
    : "<tr><td class='ok'>ไม่มีอะไรพลาดใน 7 วัน ✅</td></tr>";
  const alerts = (h.pending_admin_alerts || []).length
    ? `<div class="card"><h3>เรื่องที่ค้างแจ้งตั้ม</h3><p class="muted" style="margin-top:0">ส่งเข้าแชทส่วนตัวไม่ได้ตอนเกิดเหตุ
        จะแนบไปกับคำตอบครั้งถัดไปที่ตั้มทักแงว</p>${h.pending_admin_alerts.map((a) => `<div class="excerpt">${esc(a.text)}</div>`).join("")}</div>` : "";
  const problems = healthProblems(h);

  return `<div class="row" style="margin-bottom:12px"><span class="grow">${problems.length
      ? `<span class="bad">🔴 ${problems.map(esc).join(" · ")}</span>` : "<span class='ok'>✅ ทุกอย่างปกติ</span>"}</span>${refreshBtn}</div>
    ${h.push_blocked ? `<div class="banner bad">⛔ ${esc(h.push_blocked.text)}</div>` : ""}
    <div class="card"><h3>โควตาข้อความ LINE เดือนนี้</h3>${quota}</div>
    <div class="tiles">
      <div class="tile"><div class="n ${daysAgo(h.last_chat_answer) > 1 ? "warn" : ""}">${rel(h.last_chat_answer)}</div><div class="l">แงวตอบแชทล่าสุด</div></div>
      <div class="tile"><div class="n">${h.leaks.count_30d}</div><div class="l">จับความคิดหลุดได้ใน 30 วัน${h.leaks.last_at ? " · ล่าสุด " + rel(h.leaks.last_at) : ""}</div></div>
      <div class="tile"><div class="n ${h.leaks.fell_back ? "warn" : ""}">${h.leaks.fell_back}</div><div class="l">ครั้งที่คัดไม่ได้ ต้องขอโทษแทน</div></div>
    </div>
    ${alerts}
    <div class="card scroll"><h3>งานตามเวลา</h3><table>
      <tr><th>งาน</th><th>รันล่าสุด</th><th>ผล</th><th class="num">รอบใน 24 ชม.</th><th class="num">พลาด</th></tr>${jobs}</table></div>
    <div class="card scroll"><h3>ส่งพลาดใน 7 วัน</h3><table>${fails}</table></div>`;
}

// ---------------------------------------------------------------- ภาพรวม

function renderDash() {
  const s = DATA.stats;
  const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const spend = Object.entries(s.spend_by_purpose).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">$${Number(v).toFixed(4)}</td></tr>`).join("");
  return `<div class="tiles">${tile(s.events_new, "รอยืนยัน")}${tile(s.tasks_open, "งานค้าง")}${tile(s.tasks_overdue, "เลยกำหนด")}
      ${tile(s.tasks_done, "งานเสร็จ")}${tile(s.users_active, "พนักงาน")}${tile(s.groups_active, "กลุ่ม")}</div>
    <div class="card"><b>ค่าโมเดล 30 วัน $${s.spend_usd.toFixed(2)}</b>
      <table style="margin-top:8px"><tr><th>ประเภทงาน</th><th class="num">ค่าใช้จ่าย</th></tr>${spend}</table>
      <p class="muted" style="margin-bottom:0">คิดจากราคาในตาราง model_prices ตามรุ่นที่ใช้จริงแต่ละครั้ง ·
        แยกรายคนรายกลุ่มดูที่แท็บการใช้งาน · ยอดจริงดูที่บิลของแต่ละค่าย</p></div>`;
}

// ---------------------------------------------------------------- เหตุการณ์

document.querySelectorAll("#tabs button").forEach((b) => { b.onclick = () => show(b.dataset.tab); });

$("logout").onclick = async () => {
  await act({ action: "logout" }, "ออกจากระบบแล้ว");
  lockOut();
};

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.tagName === "SELECT" || (btn.tagName === "INPUT" && btn.type !== "button")) return;
  const a = btn.dataset.act;
  const id = btn.dataset.id;

  if (a === "refresh") return show(current, true);

  // คิวยืนยัน
  if (a === "ev-go" || a === "ev-no") {
    const card = btn.closest("[data-ev]");
    btn.disabled = true;
    if (a === "ev-go") {
      const sel = card.querySelector(".owner");
      return act({ action: "confirm_event", event_id: card.dataset.ev, owner_user_id: sel ? sel.value : null }, "ยืนยันแล้ว");
    }
    return act({ action: "dismiss_event", event_id: card.dataset.ev }, "ปัดทิ้งแล้ว");
  }

  // ตัวเตือน
  if (a.startsWith("rem-")) {
    const card = btn.closest("[data-rem]");
    const rid = card.dataset.rem;
    if (a === "rem-save") {
      btn.disabled = true;
      const rep = card.querySelector(".rep").value;
      return act({
        action: "reminder_update", id: rid,
        message: card.querySelector(".msg").value,
        remind_at: fromLocalInput(card.querySelector(".at").value),
        repeat_rule: rep || null,
        kind: card.querySelector(".kind").value,
      }, "บันทึกตัวเตือนแล้ว");
    }
    if (a === "rem-now") { btn.disabled = true; return act({ action: "reminder_send_now", id: rid }, "ส่งตัวเตือนแล้ว"); }
    if (a === "rem-cancel") {
      if (!confirm("ยกเลิกตัวเตือนนี้?")) return;
      return act({ action: "reminder_cancel", id: rid }, "ยกเลิกแล้ว");
    }
  }

  // เช็กลิสต์
  if (a === "chk-new") { STATE.editBranch = "new"; return show("checklist"); }
  if (a === "chk-edit") { STATE.editBranch = id; return show("checklist"); }
  if (a === "chk-cancel") { STATE.editBranch = null; return show("checklist"); }
  if (a === "chk-save") {
    const f = $("branchForm");
    const payload = {
      name: f.querySelector(".f-name").value, brand: f.querySelector(".f-brand").value,
      open_date: f.querySelector(".f-date").value, note: f.querySelector(".f-note").value,
      aliases: f.querySelector(".f-alias").value.split(",").map((x) => x.trim()).filter(Boolean),
    };
    const out = f.dataset.id
      ? await act({ action: "checklist_update_branch", id: f.dataset.id, ...payload }, "บันทึกสาขาแล้ว")
      : await act({ action: "checklist_add_branch", ...payload }, "เพิ่มสาขาแล้ว");
    if (out) { STATE.editBranch = null; return show("checklist"); }
    return;
  }
  if (a === "chk-remove") {
    if (!confirm("ซ่อนสาขานี้จากเช็กลิสต์? (สถานะที่ติ๊กไว้ยังเก็บอยู่)")) return;
    return act({ action: "checklist_remove_branch", id }, "ซ่อนแล้ว");
  }

  // แชท
  if (a === "chat-open") return openChat(id);
  if (a === "chat-flagged") return openChat("__flagged");
  if (a === "chat-more") { btn.disabled = true; return openChat(STATE.chatId, true); }
  if (a === "flag" || a === "unflag") {
    const reason = a === "flag" ? prompt("ติดธงเพราะอะไร (ไม่ใส่ก็ได้)") : null;
    if (a === "flag" && reason === null) return;
    const out = await api("/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(a === "flag" ? { action: "flag_message", message_id: id, reason } : { action: "unflag_message", flag_id: id }),
    });
    if (!out || out.error) return toast(out?.error || "ไม่สำเร็จ", true);
    toast(a === "flag" ? "ติดธงแล้ว" : "ปลดธงแล้ว");
    STATE.chats = await api("/chats");
    return openChat(STATE.chatId);
  }

  // กลุ่ม
  if (a === "grp-rename") {
    const tr = btn.closest("[data-grp]");
    btn.disabled = true;
    return act({ action: "group_rename", id: tr.dataset.grp, name: tr.querySelector(".gname").value }, "เปลี่ยนชื่อแล้ว");
  }

  // พนักงาน
  const tr = btn.closest("[data-u]");
  if (tr && (a === "u-save" || a === "u-toggle")) {
    const uid = tr.dataset.u;
    const before = DATA.users.find((u) => u.id === uid);
    btn.disabled = true;
    if (a === "u-save") {
      const role = tr.querySelector(".role").value;
      if (role !== before.role) {
        const r = await act({ action: "set_user_role", user_id: uid, role }, "เปลี่ยนสิทธิ์แล้ว");
        if (!r) { btn.disabled = false; return; }
      }
      return act({ action: "set_user_profile", user_id: uid, job_title: tr.querySelector(".job").value,
        department: tr.querySelector(".dept").value }, "บันทึกแล้ว");
    }
    if (before.is_active && !confirm("ปิดใช้งาน " + before.display_name + " ?")) { btn.disabled = false; return; }
    return act({ action: "set_user_active", user_id: uid, active: !before.is_active }, "อัปเดตแล้ว");
  }
});

// checkbox กับ select เปลี่ยนค่าแล้วบันทึกทันที ไม่ต้องกดปุ่มอีก
document.addEventListener("change", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  if (a === "chk-item") {
    el.disabled = true;
    return act({ action: "checklist_set_item", id: el.dataset.id, item_key: el.dataset.key, done: el.checked },
      el.checked ? "ติ๊กแล้ว" : "เอาติ๊กออกแล้ว");
  }
  if (a === "chk-owner") return act({ action: "checklist_update_branch", id: el.dataset.id, owner_user_id: el.value || null }, "ตั้งเจ้าของแล้ว");
  if (a === "chk-opened") { STATE.showOpened = el.checked; return show("checklist"); }
  if (a === "usage-days") { STATE.usageDays = Number(el.value); return show("usage", true); }
  if (a === "grp-monday" || a === "grp-active") {
    const gid = el.closest("[data-grp]").dataset.grp;
    if (a === "grp-monday" && !el.checked && !confirm("ปิด Monday ในกลุ่มนี้? แงวจะหาการ์ดและส่งรูปจาก Monday ในกลุ่มนี้ไม่ได้")) {
      el.checked = true;
      return;
    }
    el.disabled = true;
    return a === "grp-monday"
      ? act({ action: "group_set_monday", id: gid, enabled: el.checked }, el.checked ? "เปิด Monday แล้ว" : "ปิด Monday แล้ว")
      : act({ action: "group_set_active", id: gid, active: el.checked }, el.checked ? "เปิดกลุ่มแล้ว" : "ปิดกลุ่มแล้ว");
  }
});

if (token()) {
  loadData().then(async () => {
    // ดึงสุขภาพระบบไว้ตั้งแต่เปิดหน้า จะได้ขึ้นจุดแดงที่แท็บถ้ามีอะไรผิดปกติ โดยไม่ต้องกดเข้าไปดูเอง
    const h = await api("/health");
    if (h) { STATE.health = h; paintHealthDot(); }
  });
}
