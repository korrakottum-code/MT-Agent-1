// หน้านี้อ่านอย่างเดียว ไม่มีปุ่มแก้ไขงานใด ๆ ทีมสั่งงานผ่านไลน์เหมือนเดิม
// ข้อความทุกอย่างมาจากแชท จึงใส่ผ่าน textContent เท่านั้น ห้ามต่อเป็น HTML
const API = window.BOARD_API || "https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/team-board";
const STATUS = { TODO: "ยังไม่เสร็จ", DOING: "ยังไม่เสร็จ", REVIEW: "ยังไม่เสร็จ", BLOCKED: "ยังไม่เสร็จ" };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const thaiDue = (v) =>
  new Date(v).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น.";
const thaiDate = (v) =>
  new Date(v.length === 10 ? `${v}T12:00:00+07:00` : v)
    .toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" });

// token อยู่ใน fragment ไม่ถูกส่งไปกับ request ของหน้าเว็บ อ่านแล้วลบออกจากแถบที่อยู่
let token = "";
try {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fromHash) {
    sessionStorage.setItem("board_token", fromHash);
    history.replaceState(null, "", location.pathname);
  }
  token = sessionStorage.getItem("board_token") || "";
} catch {
  token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
}

let people = [];

function showMessage(text) {
  $("msg").hidden = false;
  $("msg").textContent = text;
  $("bar").hidden = true;
  $("list").replaceChildren();
  $("sub").textContent = "";
}

async function load() {
  if (!token) return showMessage("เปิดหน้านี้จากลิงก์ที่แงวส่งให้ พิมพ์บอกแงวในไลน์ว่า \"ขอลิงก์บอร์ด\"");
  let res;
  try {
    res = await fetch(`${API}?days=${$("days").value}`, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    return showMessage("โหลดข้อมูลไม่สำเร็จ ลองรีเฟรชอีกครั้ง");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showMessage(data.error || "โหลดข้อมูลไม่สำเร็จ");
  people = data.people || [];
  $("msg").hidden = true;
  $("bar").hidden = false;
  const stamp = new Date(data.generated_at).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short",
  });
  $("sub").textContent = `งานที่สั่งกันในไลน์ ใครถืองานอะไร ใครสั่ง ส่งเมื่อไหร่ · อัปเดต ${stamp}`;

  const current = $("group").value;
  const names = [...new Set(people.flatMap((p) => p.groups))].sort((a, b) => a.localeCompare(b, "th"));
  $("group").replaceChildren(new Option("ทุกกลุ่ม", ""), ...names.map((n) => new Option(n, n)));
  $("group").value = names.includes(current) ? current : "";
  render();
}

function taskRow(t) {
  const li = el("li", "task");
  li.append(el("span", `pill ${t.status}`, STATUS[t.status] || t.status));
  if (t.overdue) li.append(el("span", "pill late", "เลยกำหนด"));
  li.append(document.createTextNode(t.title));
  const bits = [];
  if (t.ordered_by) bits.push(`สั่งโดย ${t.ordered_by}`);
  bits.push(t.due_at ? `ส่ง ${thaiDue(t.due_at)}` : "ไม่มีกำหนดส่ง");
  if (t.branch) bits.push(t.branch);
  if (t.monday_code) bits.push(t.monday_code);
  if (t.blocked_reason) bits.push(`ติด: ${t.blocked_reason}`);
  if (bits.length) li.append(el("div", "tmeta", bits.join(" · ")));
  return li;
}

function card(p) {
  const c = el("article", "card");
  const h = el("h2", "", p.name);
  if (p.line_name && p.line_name !== p.name) h.append(el("small", "", p.line_name));
  c.append(h);

  const meta = el("div", "meta");
  const parts = [];
  if (p.groups.length) parts.push(p.groups.join(", "));
  if (p.closed_recent) parts.push(`เสร็จแล้ว ${p.closed_recent} งานในช่วงนี้`);
  meta.textContent = parts.join(" · ");
  c.append(meta);

  if (p.open_tasks.length) {
    c.append(el("h3", "", `งานที่ยังไม่เสร็จ (${p.open_tasks.length})`));
    const ul = el("ul");
    p.open_tasks.forEach((t) => ul.append(taskRow(t)));
    c.append(ul);
  }
  if (p.pending.length) {
    c.append(el("h3", "", "ยังไม่ติ๊กในรายงานล่าสุด"));
    const ul = el("ul");
    p.pending.forEach((x) => {
      const li = el("li");
      li.append(el("span", "box", "☐"), document.createTextNode(x));
      ul.append(li);
    });
    c.append(ul);
  }
  if (p.done.length) {
    const d = el("details");
    d.append(el("summary", "", `ทำเสร็จแล้ว ${p.done.length} รายการ`));
    const ul = el("ul");
    p.done.forEach((x) => {
      const li = el("li");
      li.append(el("span", "tick", "✓"), document.createTextNode(`${x.text} `), el("span", "tmeta", thaiDate(x.date)));
      ul.append(li);
    });
    d.append(ul);
    c.append(d);
  }
  if (!p.open_tasks.length && !p.pending.length && !p.done.length) {
    c.append(el("p", "empty", "ไม่มีงานค้าง"));
  }
  return c;
}

function render() {
  const q = $("q").value.trim().toLowerCase();
  const group = $("group").value;
  const onlyOpen = $("onlyOpen").checked;
  const shown = people.filter((p) => {
    if (group && !p.groups.includes(group)) return false;
    if (onlyOpen && !p.open_tasks.length && !p.pending.length) return false;
    if (!q) return true;
    return [p.name, p.line_name, ...p.open_tasks.map((t) => t.title), ...p.pending]
      .some((v) => String(v ?? "").toLowerCase().includes(q));
  });
  $("list").replaceChildren(...shown.map(card));
  if (!shown.length) $("list").append(el("p", "empty", "ไม่พบข้อมูลตามตัวกรองนี้"));
}

$("q").addEventListener("input", render);
$("group").addEventListener("change", render);
$("onlyOpen").addEventListener("change", render);
$("days").addEventListener("change", load);
load();
