// MT Agent 1 — Admin Console (ฝั่ง API)
//
// หน้าเว็บอยู่ที่ GitHub Pages (web/index.html) ฟังก์ชันนี้ทำหน้าที่
//   GET  ?t=<link>    แลกลิงก์ใช้ครั้งเดียว → สร้าง session → เด้งไปหน้าเว็บพร้อม token ใน fragment
//   GET  /data        คิวยืนยัน พนักงาน และตัวเลขภาพรวม (โหลดตอนเปิดหน้า)
//   GET  /reminders /health /usage /checklist /chats /chat /groups  ข้อมูลของแต่ละแท็บ โหลดตอนเปิดแท็บนั้น
//   POST /action      คำสั่งที่เปลี่ยนข้อมูล ทุกคำสั่งลง audit_logs
//
// ทำไมไม่ใช้คุกกี้: หน้าเว็บอยู่คนละโดเมนกับ API คุกกี้จึงเป็น third-party
// ซึ่ง Safari บล็อกโดยปริยายและ Chrome กำลังเลิกรองรับ — console จะพังโดยไม่มีอาการให้เห็น
// ใช้ bearer token ที่หน้าเว็บเก็บใน sessionStorage แทน แถมได้ผลพลอยได้คือ CSRF ทำไม่ได้เลย
// เพราะไม่มี credential ที่เบราว์เซอร์แนบให้เอง ทุก request ต้องมี JS ใส่ header เอง
//
// token เดินทางผ่าน URL fragment (#s=...) ซึ่งเบราว์เซอร์ไม่ส่งไปเซิร์ฟเวอร์
// จึงไม่โผล่ใน access log ของ GitHub และไม่ติดไปกับ Referer

import { createClient } from "jsr:@supabase/supabase-js@2";
import { describePushBlocked, getPushBlocked } from "../_shared/line_delivery.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SESSION_HOURS = 8;
const CONSOLE_URL = "https://korrakottum-code.github.io/MT-Agent-1/";
const ALLOWED_ORIGIN = "https://korrakottum-code.github.io";

const cors = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
  "vary": "origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ตั๋วที่ใช้ได้ต้องยังไม่หมดอายุ ยังไม่ถูกเพิกถอน และ (ถ้าเป็นลิงก์) ยังไม่เคยถูกใช้
async function resolveTicket(token: string, kind: "LINK" | "SESSION") {
  if (!token) return null;
  const { data } = await supabase.from("admin_sessions")
    .select("id, user_id, kind, expires_at, used_at, revoked_at")
    .eq("token_hash", await sha256(token)).eq("kind", kind).maybeSingle();
  if (!data || data.revoked_at) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  if (kind === "LINK" && data.used_at) return null;

  const { data: user } = await supabase.from("users")
    .select("id, display_name, role, is_active").eq("id", data.user_id).maybeSingle();
  // อ่าน role สดทุกครั้ง — ถอด ADMIN ออกแล้ว session ที่ยังไม่หมดอายุต้องใช้ไม่ได้ทันที
  if (!user || !user.is_active || user.role !== "ADMIN") return null;
  return { ticket: data, user };
}

async function audit(userId: string, action: string, input: unknown, result: unknown, status: string) {
  await supabase.from("audit_logs").insert({
    user_id: userId, action, tool_name: "admin_console", input, result, status,
  });
}

// ---------------------------------------------------------------- อ่านข้อมูล

async function loadData() {
  const [events, users, groups, taskRows, spendRows] = await Promise.all([
    supabase.from("events")
      .select("id, type, title, detail, due_at, confidence, source_excerpt, chat_id, owner_user_id, created_at")
      .eq("status", "NEW").order("created_at", { ascending: false }).limit(100),
    supabase.from("users")
      .select("id, display_name, role, job_title, department, is_active, line_user_id").order("created_at"),
    supabase.from("groups").select("id, line_group_id, group_name, is_active").order("created_at"),
    supabase.from("tasks").select("status, due_at"),
    // รวมในฐานข้อมูล เดิมดึงทั้งตารางมาบวกเองซึ่งโดนตัดที่ 1,000 แถว และคิดด้วยราคา Claude ทั้งที่ใช้ Gemini
    supabase.rpc("admin_spend", { p_days: 30 }),
  ]);

  const nameOf = new Map((users.data ?? []).map((u) => [u.id, u.display_name]));
  const groupOf = new Map((groups.data ?? []).map((g) => [g.line_group_id, g.group_name]));

  const now = Date.now();
  const tasks = taskRows.data ?? [];
  const open = tasks.filter((t) => t.status === "TODO" || t.status === "DOING");

  const byPurpose: Record<string, number> = {};
  let spend = 0;
  for (const r of spendRows.data ?? []) {
    byPurpose[r.purpose] = Number(r.usd ?? 0);
    spend += Number(r.usd ?? 0);
  }
  const round = (n: number) => Math.round(n * 10000) / 10000;

  return {
    events: (events.data ?? []).map((e) => ({
      ...e,
      group_name: groupOf.get(e.chat_id) ?? "แชทส่วนตัว",
      owner_name: e.owner_user_id ? nameOf.get(e.owner_user_id) ?? null : null,
    })),
    users: users.data ?? [],
    stats: {
      users_active: (users.data ?? []).filter((u) => u.is_active).length,
      groups_active: (groups.data ?? []).filter((g) => g.is_active).length,
      tasks_open: open.length,
      tasks_overdue: open.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length,
      tasks_done: tasks.filter((t) => t.status === "DONE").length,
      events_new: (events.data ?? []).length,
      spend_usd: round(spend),
      spend_by_purpose: Object.fromEntries(Object.entries(byPurpose).map(([k, v]) => [k, round(v)])),
    },
  };
}

// ---------------------------------------------------------------- ข้อมูลของแต่ละแท็บ

async function nameMaps() {
  const [{ data: users }, { data: groups }] = await Promise.all([
    supabase.from("users").select("id, display_name, line_user_id, is_active, role").order("display_name"),
    supabase.from("groups").select("id, line_group_id, group_name, is_active"),
  ]);
  return {
    users: users ?? [],
    userName: new Map((users ?? []).map((u) => [u.id, u.display_name])),
    lineName: new Map((users ?? []).map((u) => [u.line_user_id, u.display_name])),
    chatName: (chatId: string | null) => {
      if (!chatId) return "?";
      const g = (groups ?? []).find((x) => x.line_group_id === chatId);
      if (g) return g.group_name ?? "(ไม่มีชื่อกลุ่ม)";
      const u = (users ?? []).find((x) => x.line_user_id === chatId);
      return u ? `แชทส่วนตัว · ${u.display_name}` : "แชทส่วนตัว";
    },
  };
}

// ตัวเตือนทั้งหมดในที่เดียว รวมผลการส่งจริง 12-13 ต.ค. ตัวเตือนหายไปวันครึ่งโดยไม่มีใครเห็น
async function loadReminders() {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const [{ data: pending }, { data: recent }, maps] = await Promise.all([
    supabase.from("reminders").select("*").eq("status", "PENDING").order("remind_at", { ascending: true }).limit(200),
    supabase.from("reminders").select("*").neq("status", "PENDING").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(100),
    nameMaps(),
  ]);
  const shape = (r: any) => ({
    id: r.id, chat: maps.chatName(r.chat_id), message: r.message, kind: r.kind ?? "TEXT",
    status: r.status, remind_at: r.remind_at, repeat_rule: r.repeat_rule, repeat_until: r.repeat_until,
    repeat_count: r.repeat_count, sent_at: r.sent_at, last_error: r.last_error,
    last_failed_at: r.last_failed_at, fail_count: r.fail_count ?? 0,
    created_by: maps.userName.get(r.created_by_user_id) ?? null,
    target: maps.userName.get(r.target_user_id) ?? null, created_at: r.created_at,
  });
  return { pending: (pending ?? []).map(shape), recent: (recent ?? []).map(shape) };
}

// สุขภาพระบบ: โควตา LINE งานตามเวลา และสิ่งที่พลาดไป เห็นเองได้ ไม่ต้องรอลูกค้าบ่น
async function loadHealth() {
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
  const headers = { Authorization: `Bearer ${token}` };
  const since7 = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const [quotaRes, usedRes, blocked, jobs, failures, leaks, lastChat, pendingAlerts] = await Promise.all([
    fetch("https://api.line.me/v2/bot/message/quota", { headers }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers }).then((r) => r.ok ? r.json() : null).catch(() => null),
    getPushBlocked(supabase),
    supabase.rpc("admin_job_health"),
    supabase.from("audit_logs").select("action, tool_name, result, input, created_at")
      .eq("status", "ERROR").gte("created_at", since7)
      .in("tool_name", ["line_push", "line_reply", "due_reminders"]).order("created_at", { ascending: false }).limit(30),
    supabase.from("audit_logs").select("created_at, result").eq("action", "leak_caught").gte("created_at", since30)
      .order("created_at", { ascending: false }).limit(50),
    supabase.from("token_usage").select("created_at").eq("purpose", "chat").order("created_at", { ascending: false }).limit(1),
    supabase.from("org_settings").select("value").eq("key", "admin_alerts_pending").maybeSingle(),
  ]);

  let quota: any = null;
  if (quotaRes) {
    const limit = quotaRes.type === "limited" ? Number(quotaRes.value ?? 0) : null;
    const used = Number(usedRes?.totalUsage ?? 0);
    const bkk = new Date(Date.now() + 7 * 3600_000);
    const day = bkk.getUTCDate();
    const perDay = used / Math.max(1, day);
    const daysLeft = limit && perDay > 0 ? Math.floor((limit - used) / perDay) : null;
    quota = {
      limited: limit !== null, limit, used,
      pct: limit ? Math.round((used / limit) * 1000) / 10 : null,
      per_day: Math.round(perDay * 10) / 10,
      runs_out: daysLeft !== null && daysLeft >= 0
        ? new Date(bkk.getTime() + daysLeft * 24 * 3600_000).toISOString().slice(0, 10) : null,
    };
  }
  let alerts: any[] = [];
  try { alerts = pendingAlerts.data?.value ? JSON.parse(pendingAlerts.data.value) : []; } catch { /* ข้อมูลเสีย */ }

  return {
    quota,
    push_blocked: blocked ? { ...blocked, text: describePushBlocked(blocked) } : null,
    jobs: jobs.data ?? [],
    failures: (failures.data ?? []).map((f) => ({
      at: f.created_at, kind: f.action === "reply_undelivered" ? "ตอบแชทไม่ถึง" : f.tool_name === "line_push" ? "ส่งข้อความไม่ออก" : "ตัวเตือนพลาด",
      detail: f.tool_name === "line_push"
        ? `${(f.result as any)?.quota ? "โควตาหมด" : `LINE ${(f.result as any)?.status ?? ""}`} · ${(f.input as any)?.preview ?? ""}`
        : JSON.stringify(f.result).slice(0, 160),
    })),
    leaks: {
      count_30d: (leaks.data ?? []).length,
      fell_back: (leaks.data ?? []).filter((l: any) => l.result?.fell_back).length,
      last_at: leaks.data?.[0]?.created_at ?? null,
    },
    last_chat_answer: lastChat.data?.[0]?.created_at ?? null,
    pending_admin_alerts: alerts,
  };
}

async function loadUsage(days: number) {
  const [people, chats, spend] = await Promise.all([
    supabase.rpc("admin_usage_people", { p_days: days }),
    supabase.rpc("admin_usage_chats", { p_days: days }),
    supabase.rpc("admin_spend", { p_days: days }),
  ]);
  return { days, people: people.data ?? [], chats: chats.data ?? [], spend: spend.data ?? [] };
}

async function loadChecklist() {
  const [{ data: cfgRow }, { data: branches }, maps] = await Promise.all([
    supabase.from("org_settings").select("value").eq("key", "branch_checklist").maybeSingle(),
    supabase.from("branch_openings").select("*").eq("active", true).order("open_date", { ascending: true }),
    nameMaps(),
  ]);
  let config: any = { items: [], start_days_before: 14, ready_days_before: 7 };
  try { config = JSON.parse(cfgRow?.value ?? "{}"); } catch { /* ใช้ค่าเริ่มต้น */ }
  return {
    config,
    today: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
    branches: (branches ?? []).map((b) => ({ ...b, owner_name: b.owner_user_id ? maps.userName.get(b.owner_user_id) ?? null : null })),
    people: maps.users.filter((u) => u.is_active).map((u) => ({ id: u.id, name: u.display_name })),
  };
}

// รายชื่อแชทพร้อมกิจกรรมล่าสุด ไว้เลือกเปิดอ่าน
async function loadChats() {
  const { data } = await supabase.rpc("admin_usage_chats", { p_days: 30 });
  const { data: groups } = await supabase.from("groups").select("line_group_id, group_name, is_active");
  const { data: flags } = await supabase.from("message_flags").select("id").eq("resolved", false);
  return {
    groups: (groups ?? []).filter((g) => !(g.group_name ?? "").startsWith("SIMTEST"))
      .map((g) => {
        const u = (data ?? []).find((c: any) => c.chat_id === g.line_group_id);
        return { chat_id: g.line_group_id, name: g.group_name, active: g.is_active,
          human_messages: u?.human_messages ?? 0, answers: u?.answers ?? 0, last_used: u?.last_used ?? null };
      })
      .sort((a, b) => b.human_messages - a.human_messages),
    open_flags: (flags ?? []).length,
  };
}

// อ่านแชทย้อนหลัง หน้าละ 60 ข้อความ ใหม่ไปเก่า ติดธงคำตอบที่แย่ได้
// แงวบอกพนักงานตามจริงอยู่แล้วว่าแอดมินดูประวัติได้ (กฎข้อ 16) หน้านี้จึงไม่ได้เปิดอะไรเกินที่บอกไว้
async function loadChat(chatId: string, before: string | null, flaggedOnly: boolean) {
  const maps = await nameMaps();
  let q = supabase.from("messages").select("id, line_user_id, message_text, message_type, created_at")
    .order("created_at", { ascending: false }).limit(60);
  if (flaggedOnly) {
    const { data: f } = await supabase.from("message_flags").select("message_id").eq("resolved", false);
    const ids = (f ?? []).map((x) => x.message_id);
    if (ids.length === 0) return { chat: "ที่ติดธงไว้", messages: [], more: false };
    q = q.in("id", ids);
  } else {
    q = q.eq("line_group_id", chatId);
  }
  if (before) q = q.lt("created_at", before);
  const { data: msgs } = await q;
  const ids = (msgs ?? []).map((m) => m.id);
  const { data: flags } = ids.length
    ? await supabase.from("message_flags").select("message_id, reason, id").in("message_id", ids).eq("resolved", false)
    : { data: [] as any[] };
  const flagOf = new Map((flags ?? []).map((f) => [f.message_id, f]));
  return {
    chat: flaggedOnly ? "คำตอบที่ติดธงไว้" : maps.chatName(chatId),
    messages: (msgs ?? []).map((m) => ({
      id: m.id, at: m.created_at, bot: m.line_user_id === "bot",
      who: m.line_user_id === "bot" ? "แงว" : maps.lineName.get(m.line_user_id) ?? "?",
      text: m.message_text, type: m.message_type,
      flag: flagOf.get(m.id) ? { id: flagOf.get(m.id).id, reason: flagOf.get(m.id).reason } : null,
    })),
    more: (msgs ?? []).length === 60,
  };
}

async function loadGroups() {
  const [{ data: groups }, { data: usage }] = await Promise.all([
    supabase.from("groups").select("id, line_group_id, group_name, department, is_active, monday_enabled, created_at").order("created_at"),
    supabase.rpc("admin_usage_chats", { p_days: 30 }),
  ]);
  return {
    groups: (groups ?? []).filter((g) => !(g.group_name ?? "").startsWith("SIMTEST")).map((g) => {
      const u = (usage ?? []).find((c: any) => c.chat_id === g.line_group_id);
      return { ...g, human_messages: u?.human_messages ?? 0, answers: u?.answers ?? 0, last_used: u?.last_used ?? null };
    }),
  };
}

// ---------------------------------------------------------------- เขียนข้อมูล

async function doAction(user: { id: string; display_name: string }, body: any) {
  switch (String(body?.action ?? "")) {
    // ตรรกะเดียวกับ tool confirm_event ในแชท จะได้ไม่มีสองมาตรฐาน
    case "confirm_event": {
      const { data: ev } = await supabase.from("events").select("*").eq("id", body.event_id).maybeSingle();
      if (!ev) return { error: "ไม่พบรายการนี้" };
      if (ev.status !== "NEW") {
        return { error: ev.status === "CONVERTED" ? "รายการนี้ยืนยันไปแล้ว" : "รายการนี้ถูกปัดทิ้งไปแล้ว" };
      }
      // DECISION เก็บเป็นข้อตกลงขององค์กรเฉย ๆ ไม่ต้องกลายเป็นงานให้ใครทำ
      const makeTask = ev.type !== "DECISION";
      let task: any = null;
      if (makeTask) {
        const { data: created, error: taskErr } = await supabase.from("tasks").insert({
          title: ev.title,
          description: ev.detail ?? ev.source_excerpt ?? null,
          owner_user_id: body.owner_user_id || ev.owner_user_id || user.id,
          created_by_user_id: user.id,
          group_id: ev.group_id,
          due_at: ev.due_at ?? null,
          priority: "NORMAL",
        }).select("id, title, due_at").single();
        if (taskErr) return { error: taskErr.message };
        task = created;
      }
      const { error } = await supabase.from("events").update({
        status: "CONVERTED",
        task_id: task?.id ?? null,
        reviewed_by_user_id: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq("id", ev.id);
      if (error) return { error: error.message };
      return { ok: true, confirmed: ev.title, created_task: task };
    }

    case "dismiss_event": {
      const { data, error } = await supabase.from("events").update({
        status: "DISMISSED",
        reviewed_by_user_id: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq("id", body.event_id).eq("status", "NEW").select("id, title").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบรายการนี้ หรือถูกตัดสินไปแล้ว" };
      return { ok: true, dismissed: data.title };
    }

    case "set_user_role": {
      if (!["EMPLOYEE", "MANAGER", "EXECUTIVE", "ADMIN"].includes(String(body.role))) {
        return { error: "role ไม่ถูกต้อง" };
      }
      // กันไม่ให้ ADMIN ลดสิทธิ์ตัวเองจนไม่เหลือใครเข้า console ได้
      if (body.user_id === user.id && body.role !== "ADMIN") {
        return { error: "ลดสิทธิ์ ADMIN ของตัวเองผ่านหน้าจอนี้ไม่ได้ — ให้ ADMIN คนอื่นทำให้" };
      }
      const { data, error } = await supabase.from("users")
        .update({ role: body.role, updated_at: new Date().toISOString() })
        .eq("id", body.user_id).select("display_name, role").single();
      if (error) return { error: error.message };
      return { ok: true, updated: data };
    }

    case "set_user_active": {
      if (body.user_id === user.id) return { error: "ปิดใช้งานบัญชีตัวเองไม่ได้" };
      const { data, error } = await supabase.from("users")
        .update({ is_active: body.active === true, updated_at: new Date().toISOString() })
        .eq("id", body.user_id).select("display_name, is_active").single();
      if (error) return { error: error.message };
      return { ok: true, updated: data };
    }

    case "set_user_profile": {
      const patch: any = { updated_at: new Date().toISOString() };
      if (typeof body.job_title === "string") patch.job_title = body.job_title.trim() || null;
      if (typeof body.department === "string") patch.department = body.department.trim() || null;
      if (Object.keys(patch).length === 1) return { error: "ไม่ได้ระบุว่าจะแก้อะไร" };
      const { data, error } = await supabase.from("users")
        .update(patch).eq("id", body.user_id).select("display_name, job_title, department").single();
      if (error) return { error: error.message };
      return { ok: true, updated: data };
    }

    // ---------------------------------------------------------- ตัวเตือน
    case "reminder_update": {
      const patch: any = {};
      if (typeof body.message === "string") {
        if (!body.message.trim()) return { error: "ข้อความว่างไม่ได้" };
        patch.message = body.message.trim();
      }
      if (body.remind_at) {
        const t = new Date(body.remind_at);
        if (isNaN(t.getTime())) return { error: "เวลาไม่ถูกต้อง" };
        patch.remind_at = t.toISOString();
      }
      if (body.kind !== undefined) {
        if (!["TEXT", "AGENT"].includes(body.kind)) return { error: "ชนิดไม่ถูกต้อง" };
        patch.kind = body.kind;
      }
      if (body.repeat_rule !== undefined) {
        if (![null, "daily", "weekdays", "weekly"].includes(body.repeat_rule)) return { error: "รอบเตือนไม่ถูกต้อง" };
        patch.repeat_rule = body.repeat_rule;
      }
      if (Object.keys(patch).length === 0) return { error: "ไม่ได้ระบุว่าจะแก้อะไร" };
      // แก้แล้วให้ลองส่งได้ทันทีตามเวลาใหม่ ไม่ติดช่วงพักหลังส่งพลาด
      patch.last_failed_at = null;
      const { data, error } = await supabase.from("reminders").update(patch)
        .eq("id", body.id).eq("status", "PENDING").select("id, message, remind_at, kind, repeat_rule").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบตัวเตือนนี้ หรือส่ง/ยกเลิกไปแล้ว" };
      return { ok: true, updated: data };
    }

    case "reminder_cancel": {
      const { data, error } = await supabase.from("reminders").update({ status: "CANCELLED" })
        .eq("id", body.id).eq("status", "PENDING").select("id, message").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบตัวเตือนนี้ หรือส่ง/ยกเลิกไปแล้ว" };
      return { ok: true, cancelled: data.message };
    }

    // ส่งตอนนี้ = เลื่อนเวลามาเป็นตอนนี้ แล้วให้งานตามเวลา (ทุกนาที) หยิบไปส่งตามทางปกติ
    // ไม่ส่งจากตรงนี้เอง จะได้มีทางเดียวที่ส่งและนับผลการส่ง
    case "reminder_send_now": {
      const { data, error } = await supabase.from("reminders")
        .update({ remind_at: new Date().toISOString(), last_failed_at: null })
        .eq("id", body.id).eq("status", "PENDING").select("id, message").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบตัวเตือนนี้ หรือส่ง/ยกเลิกไปแล้ว" };
      return { ok: true, queued: data.message, note: "จะถูกส่งภายในหนึ่งนาที" };
    }

    // ---------------------------------------------------------- เช็กลิสต์เปิดสาขา
    case "checklist_add_branch": {
      const name = String(body.name ?? "").trim();
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.open_date ?? ""))) return { error: "ต้องมีชื่อสาขาและวันเปิด" };
      const { data: ads } = await supabase.from("groups").select("line_group_id").eq("monday_enabled", true).limit(1);
      const { data, error } = await supabase.from("branch_openings").insert({
        name, brand: body.brand || null, open_date: body.open_date,
        aliases: Array.isArray(body.aliases) ? body.aliases.map((a: string) => String(a).trim()).filter(Boolean) : [],
        owner_user_id: body.owner_user_id || null, note: body.note || null, chat_id: ads?.[0]?.line_group_id ?? null,
      }).select("id, name, open_date").single();
      if (error) return { error: error.code === "23505" ? "มีสาขาชื่อนี้ในวันเปิดนี้อยู่แล้ว" : error.message };
      return { ok: true, added: data };
    }

    case "checklist_update_branch": {
      const patch: any = { updated_at: new Date().toISOString() };
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
      if (body.brand !== undefined) patch.brand = body.brand || null;
      if (body.open_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.open_date))) return { error: "วันเปิดไม่ถูกต้อง" };
        patch.open_date = body.open_date;
      }
      if (Array.isArray(body.aliases)) patch.aliases = body.aliases.map((a: string) => String(a).trim()).filter(Boolean);
      if (body.owner_user_id !== undefined) patch.owner_user_id = body.owner_user_id || null;
      if (body.note !== undefined) patch.note = body.note || null;
      const { data, error } = await supabase.from("branch_openings").update(patch)
        .eq("id", body.id).select("id, name, open_date").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบสาขานี้" };
      return { ok: true, updated: data };
    }

    // ซ่อน ไม่ลบ สถานะที่ติ๊กไว้และประวัติยังอยู่ ถ้าซ่อนผิดคืนได้จากฐานข้อมูล
    case "checklist_remove_branch": {
      const { data, error } = await supabase.from("branch_openings")
        .update({ active: false, updated_at: new Date().toISOString() }).eq("id", body.id).select("name").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบสาขานี้" };
      return { ok: true, removed: data.name };
    }

    case "checklist_set_item": {
      const { data: b } = await supabase.from("branch_openings").select("id, name, items").eq("id", body.id).maybeSingle();
      if (!b) return { error: "ไม่พบสาขานี้" };
      const key = String(body.item_key ?? "");
      if (!key) return { error: "ไม่ได้ระบุข้อ" };
      const items = { ...(b.items ?? {}) };
      items[key] = {
        done: body.done === true, at: new Date().toISOString(), by: user.display_name,
        note: body.note !== undefined ? (body.note || null) : (items[key]?.note ?? null),
      };
      const { error } = await supabase.from("branch_openings")
        .update({ items, updated_at: new Date().toISOString() }).eq("id", b.id);
      if (error) return { error: error.message };
      return { ok: true, branch: b.name, item: key, done: body.done === true };
    }

    // ---------------------------------------------------------- ติดธงคำตอบ
    case "flag_message": {
      const { data, error } = await supabase.from("message_flags").insert({
        message_id: body.message_id, flagged_by_user_id: user.id, reason: body.reason ? String(body.reason).slice(0, 500) : null,
      }).select("id").single();
      if (error) return { error: error.code === "23505" ? "ข้อความนี้ติดธงไว้แล้ว" : error.message };
      return { ok: true, flag_id: data.id };
    }

    case "unflag_message": {
      const { error } = await supabase.from("message_flags").update({ resolved: true }).eq("id", body.flag_id);
      if (error) return { error: error.message };
      return { ok: true };
    }

    // ---------------------------------------------------------- กลุ่ม
    // ชื่อในระบบเท่านั้น บอทเปลี่ยนชื่อกลุ่มใน LINE เองไม่ได้ (LINE ไม่เปิดให้)
    // เปลี่ยนชื่อได้ปลอดภัยแล้ว เพราะ Monday ผูกกับ monday_enabled ของแถว ไม่ใช่ชื่อ
    case "group_rename": {
      const name = String(body.name ?? "").trim();
      if (!name) return { error: "ชื่อว่างไม่ได้" };
      const { data, error } = await supabase.from("groups").update({ group_name: name })
        .eq("id", body.id).select("group_name").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบกลุ่มนี้" };
      return { ok: true, renamed: data.group_name };
    }

    case "group_set_active": {
      const { data, error } = await supabase.from("groups").update({ is_active: body.active === true })
        .eq("id", body.id).select("group_name, is_active").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบกลุ่มนี้" };
      return { ok: true, updated: data };
    }

    case "group_set_monday": {
      const { data, error } = await supabase.from("groups").update({ monday_enabled: body.enabled === true })
        .eq("id", body.id).select("group_name, monday_enabled").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบกลุ่มนี้" };
      return { ok: true, updated: data };
    }

    case "logout":
      return { ok: true, logout: true };

    default:
      return { error: `ไม่รู้จักคำสั่ง: ${body?.action}` };
  }
}

// ---------------------------------------------------------------- routing

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/admin-console/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // แลกลิงก์ใช้ครั้งเดียวเป็น session แล้วส่ง token ต่อทาง fragment
  const linkToken = url.searchParams.get("t");
  if (linkToken) {
    const found = await resolveTicket(linkToken, "LINK");
    if (!found) {
      return new Response(
        "ลิงก์นี้หมดอายุ ถูกใช้ไปแล้ว หรือบัญชีไม่มีสิทธิ์\n\n" +
          "พิมพ์ในแชทกับแงวว่า \"ขอลิงก์ console\" เพื่อรับลิงก์ใหม่",
        { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    await supabase.from("admin_sessions")
      .update({ used_at: new Date().toISOString() }).eq("id", found.ticket.id);

    const sessionToken = crypto.randomUUID() + "." + crypto.randomUUID();
    await supabase.from("admin_sessions").insert({
      user_id: found.user.id,
      kind: "SESSION",
      token_hash: await sha256(sessionToken),
      expires_at: new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString(),
    });
    await audit(found.user.id, "admin_login", { via: "magic_link" }, { ok: true }, "OK");

    return new Response(null, {
      status: 302,
      headers: { location: `${CONSOLE_URL}#s=${sessionToken}`, "cache-control": "no-store" },
    });
  }

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = await resolveTicket(bearer, "SESSION");
  if (!session) return json({ error: "unauthorized" }, 401);

  if (path === "/data") {
    return json({ ...(await loadData()), me: session.user });
  }
  if (path === "/reminders") return json(await loadReminders());
  if (path === "/health") return json(await loadHealth());
  if (path === "/usage") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
    return json(await loadUsage(days));
  }
  if (path === "/checklist") return json(await loadChecklist());
  if (path === "/chats") return json(await loadChats());
  if (path === "/chat") {
    return json(await loadChat(
      String(url.searchParams.get("id") ?? ""), url.searchParams.get("before"), url.searchParams.get("flagged") === "1",
    ));
  }
  if (path === "/groups") return json(await loadGroups());

  if (path === "/action" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await doAction(session.user, body);
    await audit(session.user.id, "admin_action", body, result, (result as any).error ? "ERROR" : "OK");
    if ((result as any).logout) {
      await supabase.from("admin_sessions")
        .update({ revoked_at: new Date().toISOString() }).eq("id", session.ticket.id);
    }
    return json(result);
  }

  return json({ error: "not found" }, 404);
});
