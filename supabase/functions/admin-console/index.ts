// MT Agent 1 — Admin Console (ฝั่ง API)
//
// หน้าเว็บอยู่ที่ GitHub Pages (web/index.html) ฟังก์ชันนี้ทำหน้าที่ 3 อย่าง
//   GET  ?t=<link>  แลกลิงก์ใช้ครั้งเดียว → สร้าง session → เด้งไปหน้าเว็บพร้อม token ใน fragment
//   GET  /data      ข้อมูลทั้งหมดที่หน้าจอต้องใช้
//   POST /action    คำสั่งที่เปลี่ยนข้อมูล
//
// ทำไมไม่ใช้คุกกี้: หน้าเว็บอยู่คนละโดเมนกับ API คุกกี้จึงเป็น third-party
// ซึ่ง Safari บล็อกโดยปริยายและ Chrome กำลังเลิกรองรับ — console จะพังโดยไม่มีอาการให้เห็น
// ใช้ bearer token ที่หน้าเว็บเก็บใน sessionStorage แทน แถมได้ผลพลอยได้คือ CSRF ทำไม่ได้เลย
// เพราะไม่มี credential ที่เบราว์เซอร์แนบให้เอง ทุก request ต้องมี JS ใส่ header เอง
//
// token เดินทางผ่าน URL fragment (#s=...) ซึ่งเบราว์เซอร์ไม่ส่งไปเซิร์ฟเวอร์
// จึงไม่โผล่ใน access log ของ GitHub และไม่ติดไปกับ Referer

import { createClient } from "jsr:@supabase/supabase-js@2";

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
  const [events, users, groups, taskRows, usage] = await Promise.all([
    supabase.from("events")
      .select("id, type, title, detail, due_at, confidence, source_excerpt, chat_id, owner_user_id, created_at")
      .eq("status", "NEW").order("created_at", { ascending: false }).limit(100),
    supabase.from("users")
      .select("id, display_name, role, job_title, department, is_active, line_user_id").order("created_at"),
    supabase.from("groups").select("id, line_group_id, group_name, is_active").order("created_at"),
    supabase.from("tasks").select("status, due_at"),
    supabase.from("token_usage").select("purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens"),
  ]);

  const nameOf = new Map((users.data ?? []).map((u) => [u.id, u.display_name]));
  const groupOf = new Map((groups.data ?? []).map((g) => [g.line_group_id, g.group_name]));

  const now = Date.now();
  const tasks = taskRows.data ?? [];
  const open = tasks.filter((t) => t.status === "TODO" || t.status === "DOING");

  // ต้นทุนต่อ 1 ล้าน token — cache อ่านคิด 0.1 เท่าของ input, cache เขียนคิด 1.25 เท่า
  const RATE: Record<string, { in: number; out: number }> = {
    "claude-sonnet-5": { in: 2, out: 10 },
    "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  };
  let spend = 0;
  const byPurpose: Record<string, number> = {};
  for (const r of usage.data ?? []) {
    const rate = RATE[r.model ?? ""] ?? { in: 2, out: 10 };
    const cost = ((r.input_tokens ?? 0) * rate.in +
      (r.output_tokens ?? 0) * rate.out +
      (r.cache_read_tokens ?? 0) * rate.in * 0.1 +
      (r.cache_write_tokens ?? 0) * rate.in * 1.25) / 1_000_000;
    spend += cost;
    byPurpose[r.purpose ?? "?"] = (byPurpose[r.purpose ?? "?"] ?? 0) + cost;
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
