// MT Agent 1 — LINE Webhook + AI Agent (MVP 0.1)
// LINE → verify signature → เก็บ message → resolve identity → Claude + Tools → ตอบกลับ
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// identity-linked API key ต้องแนบ anthropic-workspace-id ทุก request
const WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  ...(WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } } : {}),
});
const MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 8;

// ---------------------------------------------------------------- LINE helpers

async function verifySignature(body: string, signature: string): Promise<boolean> {
  if (!CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

async function lineApi(path: string, payload: unknown) {
  const res = await fetch(`https://api.line.me${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`LINE ${path} failed:`, res.status, await res.text());
  return res.ok;
}

// ตอบด้วย replyToken ก่อน (หมดอายุเร็ว) ถ้าไม่ทันค่อย push เข้าห้อง
async function sendReply(replyToken: string, to: string, text: string) {
  const messages = [{ type: "text", text: text.slice(0, 4900) }];
  const ok = await lineApi("/v2/bot/message/reply", { replyToken, messages });
  if (!ok) await lineApi("/v2/bot/message/push", { to, messages });
}

// ดึงชื่อจริงจาก LINE เพื่อลงทะเบียนพนักงานใหม่อัตโนมัติ
async function fetchLineProfile(userId: string, groupId: string | null): Promise<string | null> {
  const path = groupId
    ? `/v2/bot/group/${groupId}/member/${userId}`
    : `/v2/bot/profile/${userId}`;
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const profile = await res.json();
  return profile.displayName ?? null;
}

// ดาวน์โหลดรูปที่ส่งใน LINE มาเป็น base64 เพื่อส่งให้โมเดลดู
async function fetchImageContent(messageId: string): Promise<{ data: string; media_type: string } | null> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const mediaType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  const buf = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return { data: btoa(binary), media_type: mediaType };
}

// ---------------------------------------------------------------- Identity

async function ensureUser(lineUserId: string, groupId: string | null) {
  const { data: existing } = await supabase
    .from("users").select("*").eq("line_user_id", lineUserId).maybeSingle();
  if (existing) return existing;

  const displayName = await fetchLineProfile(lineUserId, groupId);
  const { data: created } = await supabase
    .from("users")
    .insert({ line_user_id: lineUserId, display_name: displayName, role: "EMPLOYEE" })
    .select().single();
  return created;
}

// ดึงชื่อกลุ่มจริงจาก LINE เพื่อไม่ต้องให้ ADMIN ตั้งชื่อเอง
async function fetchLineGroupName(groupId: string): Promise<string | null> {
  const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const summary = await res.json();
  return summary.groupName ?? null;
}

async function ensureGroup(lineGroupId: string | null) {
  if (!lineGroupId) return null;
  const { data: existing } = await supabase
    .from("groups").select("*").eq("line_group_id", lineGroupId).maybeSingle();
  if (existing) {
    if (existing.group_name) return existing;
    // กลุ่มเก่าที่ยังไม่มีชื่อ ลองเติมจาก LINE
    const name = await fetchLineGroupName(lineGroupId);
    if (!name) return existing;
    const { data: named } = await supabase.from("groups")
      .update({ group_name: name }).eq("id", existing.id).select().single();
    return named ?? existing;
  }
  const groupName = await fetchLineGroupName(lineGroupId);
  const { data: created } = await supabase
    .from("groups").insert({ line_group_id: lineGroupId, group_name: groupName }).select().single();
  return created;
}

async function findUserByName(name: string) {
  const { data } = await supabase
    .from("users").select("*")
    .ilike("display_name", `%${name}%`)
    .eq("is_active", true)
    .limit(5);
  return data ?? [];
}

// ---------------------------------------------------------------- Tools

const TOOLS = [
  {
    name: "create_task",
    description:
      "สร้างงานใหม่ ระบุเจ้าของงานด้วยชื่อเล่น (owner_name) ถ้าไม่ระบุ owner จะเป็นของคนสั่งเอง due_at เป็น ISO 8601 พร้อม timezone +07:00",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "ชื่องานสั้น กระชับ" },
        description: { type: "string" },
        owner_name: { type: "string", description: "ชื่อเล่นเจ้าของงาน" },
        due_at: { type: "string", description: "กำหนดส่ง ISO 8601 เช่น 2026-09-02T15:00:00+07:00" },
        priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
      },
      required: ["title"],
    },
  },
  {
    name: "get_my_tasks",
    description: "ดึงรายการงานของคนที่กำลังถามอยู่",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["TODO", "DOING", "DONE", "CANCELLED", "OPEN"], description: "OPEN = TODO+DOING" },
      },
    },
  },
  {
    name: "get_user_tasks",
    description: "ดึงงานของคนอื่นตามชื่อเล่น (ต้องมีสิทธิ์ MANAGER ขึ้นไป)",
    input_schema: {
      type: "object",
      properties: {
        user_name: { type: "string" },
        status: { type: "string", enum: ["TODO", "DOING", "DONE", "CANCELLED", "OPEN"] },
      },
      required: ["user_name"],
    },
  },
  {
    name: "update_task",
    description: "อัปเดตงาน: เปลี่ยนสถานะ / กำหนดส่ง / เจ้าของ ระบุงานด้วย task_id (ได้จาก get_*_tasks) หรือคำในชื่องาน",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "UUID ของงาน" },
        title_search: { type: "string", description: "คำในชื่องาน ใช้เมื่อไม่รู้ task_id" },
        new_status: { type: "string", enum: ["TODO", "DOING", "DONE", "CANCELLED"] },
        new_due_at: { type: "string", description: "ISO 8601" },
        new_owner_name: { type: "string" },
      },
    },
  },
  {
    name: "search_messages",
    description: "ค้นหาข้อความเก่าด้วยคำค้น ค่าเริ่มต้นค้นเฉพาะกลุ่มนี้ scope=all_groups ค้นทุกกลุ่ม (MANAGER ขึ้นไป)",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["this_group", "all_groups"] },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_group_summary",
    description:
      "ดึงข้อความของกลุ่มตามช่วงเวลา (ชั่วโมงย้อนหลัง) เพื่อนำมาสรุป พร้อมสถิติงานของกลุ่ม ระบุ group_name เพื่อดูกลุ่มอื่น (MANAGER ขึ้นไป)",
    input_schema: {
      type: "object",
      properties: {
        hours_back: { type: "integer", description: "ย้อนหลังกี่ชั่วโมง เช่น 24 = วันนี้" },
        group_name: { type: "string", description: "ชื่อกลุ่มอื่น ไม่ระบุ = กลุ่มปัจจุบัน" },
      },
      required: ["hours_back"],
    },
  },
  {
    name: "send_dm",
    description:
      "ส่งข้อความเข้าแชทส่วนตัว (DM) ของพนักงาน ผู้รับต้องเคยเพิ่ม OA เป็นเพื่อน ส่งหาตัวเองได้ทุกคน ส่งหาคนอื่นต้อง MANAGER ขึ้นไปและควรยืนยันก่อน",
    input_schema: {
      type: "object",
      properties: {
        to_name: { type: "string", description: "ชื่อเล่นผู้รับ" },
        message: { type: "string" },
      },
      required: ["to_name", "message"],
    },
  },
  {
    name: "get_task_stats",
    description: "นับจำนวนงานตามช่วงเวลาและสถานะ เช่น เดือนนี้เสร็จไปกี่งาน",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "ISO 8601" },
        date_to: { type: "string", description: "ISO 8601" },
        status: { type: "string", enum: ["TODO", "DOING", "DONE", "CANCELLED"] },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "create_reminder",
    description:
      "ตั้งเตือนตามเวลา เช่น 'เตือนอีก 2 นาที' หรือ 'พรุ่งนี้เตือนแพรวส่งภาพก่อนเที่ยง' " +
      "การเตือนจะถูกส่งเข้าแชทที่สั่ง ระบุ to_name ถ้าเตือนคนอื่น (จะแท็กชื่อในข้อความ)",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "ข้อความที่จะเตือน" },
        remind_at: { type: "string", description: "เวลาเตือน ISO 8601 +07:00 เช่น 2026-09-02T12:00:00+07:00" },
        to_name: { type: "string", description: "ชื่อเล่นคนที่ถูกเตือน ไม่ระบุ = ตัวเอง" },
      },
      required: ["message", "remind_at"],
    },
  },
  {
    name: "list_reminders",
    description: "ดูรายการเตือนที่ยังรออยู่ในแชทนี้",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "ยกเลิกการเตือนที่รออยู่ ระบุ reminder_id (ได้จาก list_reminders)",
    input_schema: {
      type: "object",
      properties: { reminder_id: { type: "string" } },
      required: ["reminder_id"],
    },
  },
  {
    name: "set_user_active",
    description:
      "เปิด/ปิดสถานะพนักงานในระบบ (เฉพาะ ADMIN) ปิดสถานะใช้เมื่อพนักงานลาออกหรือเป็นข้อมูลทดสอบ " +
      "คนที่ถูกปิดจะหายจากรายชื่อและมอบงานให้ไม่ได้ แต่ประวัติยังอยู่ครบ ย้อนกลับได้ด้วย active=true",
    input_schema: {
      type: "object",
      properties: {
        user_name: { type: "string" },
        active: { type: "boolean", description: "false = ปิดสถานะ, true = เปิดกลับ" },
        cancel_open_tasks: { type: "boolean", description: "ยกเลิกงานที่ค้างของคนนี้ด้วยหรือไม่" },
      },
      required: ["user_name", "active"],
    },
  },
  {
    name: "manage_user",
    description:
      "แก้ข้อมูลพนักงานคนอื่น: role (สิทธิ์) ตำแหน่งงาน แผนก หัวหน้า (เฉพาะ ADMIN) " +
      "ใช้ตอนตั้งหัวหน้าทีมเป็น MANAGER หรือแก้ตำแหน่งให้คนอื่น",
    input_schema: {
      type: "object",
      properties: {
        user_name: { type: "string", description: "ชื่อเล่นคนที่จะแก้" },
        role: { type: "string", enum: ["EMPLOYEE", "MANAGER", "ADMIN", "EXECUTIVE"] },
        job_title: { type: "string" },
        department: { type: "string" },
        manager_name: { type: "string", description: "ชื่อเล่นหัวหน้าของคนนี้" },
      },
      required: ["user_name"],
    },
  },
  {
    name: "link_user",
    description:
      "ผูกบัญชีที่ลงทะเบียนล่วงหน้าไว้ (pending) เข้ากับบัญชี LINE จริงของคนคนเดียวกัน (เฉพาะ ADMIN) " +
      "ใช้เมื่อคนที่ ADMIN ลงทะเบียนชื่อไว้ก่อน เข้ามาพิมพ์ในกลุ่มจริงแล้ว งานและข้อมูลจะถูกย้ายมารวมกัน",
    input_schema: {
      type: "object",
      properties: {
        pending_name: { type: "string", description: "ชื่อบัญชีที่ลงทะเบียนล่วงหน้าไว้" },
        real_name: { type: "string", description: "ชื่อบัญชี LINE จริงที่จะรวมเข้าไป" },
      },
      required: ["pending_name", "real_name"],
    },
  },
  {
    name: "update_my_profile",
    description:
      "บันทึก/แก้ไขโปรไฟล์ของคนที่กำลังคุยอยู่: ชื่อเล่น ตำแหน่งงาน แผนก ใช้ตอนผู้ใช้แนะนำตัวในแชทส่วนตัว",
    input_schema: {
      type: "object",
      properties: {
        display_name: { type: "string", description: "ชื่อเล่นที่ใช้เรียกในองค์กร" },
        job_title: { type: "string", description: "ตำแหน่งงาน เช่น กราฟิกดีไซเนอร์" },
        department: { type: "string" },
      },
    },
  },
  {
    name: "remember_preference",
    description:
      "จำข้อกำหนดถาวรของผู้ใช้คนนี้ เช่น ชื่อเล่นที่อยากให้เรียกบอท/ตัวเอง โทนการตอบ สิ่งที่ห้ามทำ ข้อความใหม่จะแทนที่ของเก่าทั้งหมด — ให้รวมข้อกำหนดเดิมที่ยังใช้อยู่เข้าไปด้วย",
    input_schema: {
      type: "object",
      properties: {
        preferences: { type: "string", description: "ข้อกำหนดทั้งหมดฉบับล่าสุด (รวมของเดิมที่ยังใช้)" },
        scope: {
          type: "string",
          enum: ["me", "org"],
          description: "me = ใช้กับคนสั่งคนเดียว (ค่าเริ่มต้น), org = ใช้กับทุกคนทุกกลุ่ม เช่นบุคลิกของบอท (เฉพาะ ADMIN)",
        },
      },
      required: ["preferences"],
    },
  },
  {
    name: "rename_group",
    description:
      "ตั้ง/เปลี่ยนชื่อกลุ่มปัจจุบันในระบบ (เฉพาะ ADMIN) ใช้ตอนเชิญบอทเข้ากลุ่มใหม่ที่ยังไม่มีชื่อ",
    input_schema: {
      type: "object",
      properties: {
        new_name: { type: "string" },
        department: { type: "string", description: "แผนกของกลุ่ม (ถ้ามี)" },
      },
      required: ["new_name"],
    },
  },
  {
    name: "register_user",
    description:
      "ลงทะเบียนพนักงานล่วงหน้าด้วยชื่อเล่น (เฉพาะ ADMIN) ใช้เมื่อสร้างงานให้คนที่ยังไม่เคยพิมพ์ในกลุ่ม",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string", enum: ["EMPLOYEE", "MANAGER", "ADMIN", "EXECUTIVE"] },
        department: { type: "string" },
      },
      required: ["name"],
    },
  },
];

type Ctx = { caller: any; group: any; lineGroupId: string | null };

const canViewOthers = (role: string) => ["MANAGER", "ADMIN", "EXECUTIVE"].includes(role);

async function resolveOneUser(name: string): Promise<{ user?: any; error?: string }> {
  const matches = await findUserByName(name);
  if (matches.length === 0) {
    return { error: `ไม่พบผู้ใช้ชื่อ "${name}" ในระบบ (ให้ ADMIN ใช้ register_user หรือให้คนนั้นพิมพ์ในกลุ่มก่อน)` };
  }
  if (matches.length > 1) {
    return { error: `ชื่อ "${name}" ตรงหลายคน: ${matches.map((u: any) => u.display_name).join(", ")} กรุณาระบุให้ชัด` };
  }
  return { user: matches[0] };
}

async function executeTool(name: string, input: any, ctx: Ctx): Promise<any> {
  switch (name) {
    case "create_task": {
      let ownerId = ctx.caller.id;
      if (input.owner_name) {
        const r = await resolveOneUser(input.owner_name);
        if (r.error) return { error: r.error };
        ownerId = r.user.id;
      }
      const { data, error } = await supabase.from("tasks").insert({
        title: input.title,
        description: input.description ?? null,
        owner_user_id: ownerId,
        created_by_user_id: ctx.caller.id,
        group_id: ctx.group?.id ?? null,
        due_at: input.due_at ?? null,
        priority: input.priority ?? "NORMAL",
      }).select("id, title, due_at, priority").single();
      if (error) return { error: error.message };
      return { created: data };
    }

    case "get_my_tasks":
    case "get_user_tasks": {
      let target = ctx.caller;
      if (name === "get_user_tasks") {
        const r = await resolveOneUser(input.user_name);
        if (r.error) return { error: r.error };
        target = r.user;
        const isSelf = target.id === ctx.caller.id;
        if (!isSelf && !canViewOthers(ctx.caller.role)) {
          return { error: "คุณไม่มีสิทธิ์ดูงานของคนอื่น (ต้องเป็น MANAGER ขึ้นไป)" };
        }
      }
      let q = supabase.from("tasks")
        .select("id, title, status, priority, due_at, created_at")
        .eq("owner_user_id", target.id)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(30);
      const st = input.status ?? "OPEN";
      if (st === "OPEN") q = q.in("status", ["TODO", "DOING"]);
      else q = q.eq("status", st);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { owner: target.display_name, tasks: data };
    }

    case "update_task": {
      let task: any = null;
      if (input.task_id) {
        const { data } = await supabase.from("tasks").select("*").eq("id", input.task_id).maybeSingle();
        task = data;
      } else if (input.title_search) {
        const { data } = await supabase.from("tasks").select("*")
          .ilike("title", `%${input.title_search}%`)
          .in("status", ["TODO", "DOING"]).limit(5);
        if ((data ?? []).length > 1) {
          return { error: "พบหลายงานที่ตรงคำค้น", candidates: data!.map((t: any) => ({ id: t.id, title: t.title })) };
        }
        task = data?.[0] ?? null;
      }
      if (!task) return { error: "ไม่พบงานที่ต้องการอัปเดต" };

      const isMine = task.owner_user_id === ctx.caller.id || task.created_by_user_id === ctx.caller.id;
      if (!isMine && !canViewOthers(ctx.caller.role)) {
        return { error: "คุณอัปเดตได้เฉพาะงานของตัวเอง (ต้องเป็น MANAGER ขึ้นไปถึงแก้งานคนอื่นได้)" };
      }

      const patch: any = { updated_at: new Date().toISOString() };
      if (input.new_status) {
        patch.status = input.new_status;
        patch.completed_at = input.new_status === "DONE" ? new Date().toISOString() : null;
      }
      if (input.new_due_at) patch.due_at = input.new_due_at;
      if (input.new_owner_name) {
        const r = await resolveOneUser(input.new_owner_name);
        if (r.error) return { error: r.error };
        patch.owner_user_id = r.user.id;
      }
      const { data, error } = await supabase.from("tasks").update(patch)
        .eq("id", task.id).select("id, title, status, due_at").single();
      if (error) return { error: error.message };
      return { updated: data };
    }

    case "search_messages": {
      const scope = input.scope ?? "this_group";
      if (scope === "all_groups" && !canViewOthers(ctx.caller.role)) {
        return { error: "ค้นข้ามกลุ่มได้เฉพาะ MANAGER ขึ้นไป" };
      }
      if (scope === "this_group" && !ctx.lineGroupId) return { error: "ใช้ได้เฉพาะในกลุ่ม" };
      let q = supabase.from("messages")
        .select("line_user_id, line_group_id, message_text, created_at")
        .ilike("message_text", `%${input.query}%`)
        .order("created_at", { ascending: false })
        .limit(Math.min(input.limit ?? 20, 50));
      if (scope === "this_group") q = q.eq("line_group_id", ctx.lineGroupId);
      const { data, error } = await q;
      if (error) return { error: error.message };
      const { data: gs } = await supabase.from("groups").select("line_group_id, group_name");
      const gname = new Map((gs ?? []).map((g: any) => [g.line_group_id, g.group_name]));
      return {
        results: (data ?? []).map((m: any) => ({
          ...m,
          group: gname.get(m.line_group_id) ?? null,
        })),
      };
    }

    case "get_group_summary": {
      let targetGroup = ctx.group;
      let targetLineGroupId = ctx.lineGroupId;
      if (input.group_name) {
        if (!canViewOthers(ctx.caller.role)) {
          return { error: "ดูสรุปกลุ่มอื่นได้เฉพาะ MANAGER ขึ้นไป" };
        }
        const { data: g } = await supabase.from("groups").select("*")
          .ilike("group_name", `%${input.group_name}%`).limit(2);
        if (!g || g.length === 0) return { error: `ไม่พบกลุ่มชื่อ "${input.group_name}"` };
        if (g.length > 1) return { error: `ชื่อกลุ่มตรงหลายกลุ่ม: ${g.map((x: any) => x.group_name).join(", ")}` };
        targetGroup = g[0];
        targetLineGroupId = g[0].line_group_id;
      }
      if (!targetLineGroupId) return { error: "ใช้ได้เฉพาะในกลุ่ม หรือระบุ group_name" };
      const since = new Date(Date.now() - input.hours_back * 3600_000).toISOString();
      const { data: msgs } = await supabase.from("messages")
        .select("line_user_id, message_text, created_at")
        .eq("line_group_id", targetLineGroupId)
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .limit(200);
      const { data: users } = await supabase.from("users").select("line_user_id, display_name");
      const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));
      nameOf.set("bot", "MT Agent");
      const { data: tasks } = await supabase.from("tasks")
        .select("title, status, due_at")
        .eq("group_id", targetGroup?.id ?? "00000000-0000-0000-0000-000000000000")
        .gte("created_at", since);
      return {
        messages: (msgs ?? []).map((m: any) => ({
          who: nameOf.get(m.line_user_id) ?? "ไม่ทราบชื่อ",
          text: m.message_text,
          at: m.created_at,
        })),
        tasks_in_period: tasks ?? [],
      };
    }

    case "get_task_stats": {
      let q = supabase.from("tasks").select("id, status", { count: "exact" })
        .gte("created_at", input.date_from).lte("created_at", input.date_to);
      if (input.status === "DONE") {
        q = supabase.from("tasks").select("id", { count: "exact" })
          .eq("status", "DONE")
          .gte("completed_at", input.date_from).lte("completed_at", input.date_to);
      } else if (input.status) {
        q = q.eq("status", input.status);
      }
      const { count, error } = await q;
      if (error) return { error: error.message };
      return { count, date_from: input.date_from, date_to: input.date_to, status: input.status ?? "ALL" };
    }

    case "send_dm": {
      const r = await resolveOneUser(input.to_name);
      if (r.error) return { error: r.error };
      const target = r.user;
      if (String(target.line_user_id).startsWith("pending:")) {
        return { error: `"${target.display_name}" ยังไม่ได้ผูกบัญชี LINE จริง ส่ง DM ไม่ได้` };
      }
      const isSelf = target.id === ctx.caller.id;
      if (!isSelf && !canViewOthers(ctx.caller.role)) {
        return { error: "ส่ง DM หาคนอื่นได้เฉพาะ MANAGER ขึ้นไป" };
      }
      const ok = await lineApi("/v2/bot/message/push", {
        to: target.line_user_id,
        messages: [{ type: "text", text: String(input.message).slice(0, 4900) }],
      });
      if (!ok) {
        return { error: `ส่งไม่สำเร็จ — "${target.display_name}" อาจยังไม่ได้เพิ่ม MT agent 1 เป็นเพื่อนใน LINE` };
      }
      return { sent_to: target.display_name };
    }

    case "create_reminder": {
      let targetId: string | null = ctx.caller.id;
      let prefix = "";
      if (input.to_name) {
        const r = await resolveOneUser(input.to_name);
        if (r.error) return { error: r.error };
        targetId = r.user.id;
        prefix = `${r.user.display_name} `;
      }
      const when = new Date(input.remind_at);
      if (isNaN(when.getTime())) return { error: "รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601" };
      if (when.getTime() < Date.now() - 60_000) return { error: "เวลาที่ตั้งเป็นอดีตไปแล้ว" };
      const { data, error } = await supabase.from("reminders").insert({
        target_user_id: targetId,
        chat_id: ctx.lineGroupId ?? ctx.caller.line_user_id,
        message: prefix + input.message,
        remind_at: when.toISOString(),
        created_by_user_id: ctx.caller.id,
      }).select("id, message, remind_at").single();
      if (error) return { error: error.message };
      return { reminder_set: data };
    }

    case "list_reminders": {
      const { data, error } = await supabase.from("reminders")
        .select("id, message, remind_at")
        .eq("chat_id", ctx.lineGroupId ?? ctx.caller.line_user_id)
        .eq("status", "PENDING")
        .order("remind_at", { ascending: true }).limit(20);
      if (error) return { error: error.message };
      return { pending: data };
    }

    case "cancel_reminder": {
      const { data, error } = await supabase.from("reminders")
        .update({ status: "CANCELLED" })
        .eq("id", input.reminder_id).eq("status", "PENDING")
        .select("id, message").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบการเตือนนี้ หรือถูกส่ง/ยกเลิกไปแล้ว" };
      return { cancelled: data };
    }

    case "set_user_active": {
      if (ctx.caller.role !== "ADMIN") return { error: "เฉพาะ ADMIN เท่านั้นที่จัดการสถานะพนักงานได้" };
      const matches = await supabase.from("users").select("*")
        .ilike("display_name", `%${input.user_name}%`).limit(5);
      const found = matches.data ?? [];
      if (found.length === 0) return { error: `ไม่พบผู้ใช้ชื่อ "${input.user_name}"` };
      if (found.length > 1) {
        return { error: `ชื่อตรงหลายคน: ${found.map((u: any) => u.display_name).join(", ")}` };
      }
      const target = found[0];
      if (target.id === ctx.caller.id && input.active === false) {
        return { error: "ปิดสถานะตัวเองไม่ได้" };
      }
      const { data, error } = await supabase.from("users")
        .update({ is_active: input.active, updated_at: new Date().toISOString() })
        .eq("id", target.id).select("display_name, is_active").single();
      if (error) return { error: error.message };

      let cancelledTasks = 0;
      if (input.active === false && input.cancel_open_tasks) {
        const { data: ct } = await supabase.from("tasks")
          .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
          .eq("owner_user_id", target.id).in("status", ["TODO", "DOING"]).select("id");
        cancelledTasks = (ct ?? []).length;
      }
      const { count: openLeft } = await supabase.from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", target.id).in("status", ["TODO", "DOING"]);
      return { updated: data, cancelled_tasks: cancelledTasks, open_tasks_remaining: openLeft ?? 0 };
    }

    case "manage_user": {
      if (ctx.caller.role !== "ADMIN") return { error: "แก้ข้อมูลพนักงานคนอื่นได้เฉพาะ ADMIN" };
      const r = await resolveOneUser(input.user_name);
      if (r.error) return { error: r.error };
      const patch: any = { updated_at: new Date().toISOString() };
      if (input.role) patch.role = input.role;
      if (input.job_title) patch.job_title = input.job_title;
      if (input.department) patch.department = input.department;
      if (input.manager_name) {
        const m = await resolveOneUser(input.manager_name);
        if (m.error) return { error: `หาหัวหน้าไม่เจอ: ${m.error}` };
        patch.manager_user_id = m.user.id;
      }
      if (Object.keys(patch).length === 1) return { error: "ไม่ได้ระบุว่าจะแก้อะไร" };
      const { data, error } = await supabase.from("users").update(patch)
        .eq("id", r.user.id).select("display_name, role, job_title, department").single();
      if (error) return { error: error.message };
      return { updated_user: data };
    }

    case "link_user": {
      if (ctx.caller.role !== "ADMIN") return { error: "ผูกบัญชีได้เฉพาะ ADMIN" };
      const p = await resolveOneUser(input.pending_name);
      if (p.error) return { error: `บัญชีที่ลงทะเบียนไว้: ${p.error}` };
      const rl = await resolveOneUser(input.real_name);
      if (rl.error) return { error: `บัญชี LINE จริง: ${rl.error}` };
      const pending = p.user, real = rl.user;
      if (pending.id === real.id) return { error: "เป็นบัญชีเดียวกันอยู่แล้ว" };
      if (!String(pending.line_user_id).startsWith("pending:")) {
        return { error: `"${pending.display_name}" ไม่ใช่บัญชีที่ลงทะเบียนล่วงหน้า (ผูกได้เฉพาะบัญชี pending)` };
      }
      if (String(real.line_user_id).startsWith("pending:")) {
        return { error: `"${real.display_name}" ยังไม่ใช่บัญชี LINE จริง` };
      }

      const { data: movedOwn } = await supabase.from("tasks")
        .update({ owner_user_id: real.id, updated_at: new Date().toISOString() })
        .eq("owner_user_id", pending.id).select("id");
      const { data: movedCreated } = await supabase.from("tasks")
        .update({ created_by_user_id: real.id, updated_at: new Date().toISOString() })
        .eq("created_by_user_id", pending.id).select("id");
      await supabase.from("reminders")
        .update({ target_user_id: real.id }).eq("target_user_id", pending.id);

      // ย้ายข้อมูลโปรไฟล์ที่บัญชี pending มีแต่บัญชีจริงยังว่าง
      const carry: any = { updated_at: new Date().toISOString() };
      if (!real.job_title && pending.job_title) carry.job_title = pending.job_title;
      if (!real.department && pending.department) carry.department = pending.department;
      if (real.role === "EMPLOYEE" && pending.role !== "EMPLOYEE") carry.role = pending.role;
      if (Object.keys(carry).length > 1) {
        await supabase.from("users").update(carry).eq("id", real.id);
      }
      await supabase.from("users")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", pending.id);

      return {
        linked: { from: pending.display_name, into: real.display_name },
        moved_owned_tasks: (movedOwn ?? []).length,
        moved_created_tasks: (movedCreated ?? []).length,
        note: "ปิดสถานะบัญชีที่ลงทะเบียนล่วงหน้าแล้ว ข้อมูลทั้งหมดอยู่ที่บัญชี LINE จริง",
      };
    }

    case "update_my_profile": {
      const patch: any = { updated_at: new Date().toISOString() };
      if (input.display_name) patch.display_name = input.display_name;
      if (input.job_title) patch.job_title = input.job_title;
      if (input.department) patch.department = input.department;
      const { data, error } = await supabase.from("users").update(patch)
        .eq("id", ctx.caller.id).select("display_name, job_title, department").single();
      if (error) return { error: error.message };
      return { updated_profile: data };
    }

    case "remember_preference": {
      const value = String(input.preferences).slice(0, 2000);
      if (input.scope === "org") {
        if (ctx.caller.role !== "ADMIN") {
          return { error: "ตั้งค่าที่ใช้กับทุกคนได้เฉพาะ ADMIN (ถ้าต้องการเฉพาะตัวเอง ใช้ scope=me)" };
        }
        const { data: prev } = await supabase.from("org_settings")
          .select("value").eq("key", "bot_persona").maybeSingle();
        const { error } = await supabase.from("org_settings").upsert({
          key: "bot_persona",
          value,
          updated_by_user_id: ctx.caller.id,
          updated_at: new Date().toISOString(),
        });
        if (error) return { error: error.message };
        // ส่งค่าเดิมกลับไปด้วย เผื่อเผลอเขียนทับข้อกำหนดเก่าที่ยังต้องใช้
        return {
          remembered: true,
          scope: "org",
          previous_value: prev?.value ?? null,
          note: "ใช้กับทุกคนทุกกลุ่มแล้ว — ถ้า previous_value มีข้อกำหนดที่ยังต้องใช้แต่หายไปจากค่าใหม่ ให้เรียกซ้ำโดยรวมของเดิมเข้าไปด้วย",
        };
      }
      const { error } = await supabase.from("users")
        .update({ preferences: value, updated_at: new Date().toISOString() })
        .eq("id", ctx.caller.id);
      if (error) return { error: error.message };
      return { remembered: true, scope: "me" };
    }

    case "rename_group": {
      if (ctx.caller.role !== "ADMIN") return { error: "เฉพาะ ADMIN เท่านั้นที่ตั้งชื่อกลุ่มได้" };
      if (!ctx.group) return { error: "ใช้ได้เฉพาะในกลุ่ม" };
      const patch: any = { group_name: input.new_name };
      if (input.department) patch.department = input.department;
      const { data, error } = await supabase.from("groups").update(patch)
        .eq("id", ctx.group.id).select("group_name, department").single();
      if (error) return { error: error.message };
      return { renamed: data };
    }

    case "register_user": {
      if (ctx.caller.role !== "ADMIN") return { error: "เฉพาะ ADMIN เท่านั้นที่ลงทะเบียนพนักงานได้" };
      const { data, error } = await supabase.from("users").insert({
        line_user_id: `pending:${input.name}:${crypto.randomUUID().slice(0, 8)}`,
        display_name: input.name,
        role: input.role ?? "EMPLOYEE",
        department: input.department ?? null,
      }).select("id, display_name, role").single();
      if (error) return { error: error.message };
      return { registered: data, note: "เมื่อคนนี้พิมพ์ในกลุ่มครั้งแรก ให้ ADMIN แจ้งบอทเพื่อผูกบัญชี" };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

async function auditLog(ctx: Ctx, toolName: string, input: any, result: any) {
  const status = result?.error ? (String(result.error).includes("สิทธิ์") ? "DENIED" : "ERROR") : "OK";
  await supabase.from("audit_logs").insert({
    user_id: ctx.caller?.id ?? null,
    action: "tool_call",
    tool_name: toolName,
    input,
    result,
    status,
  });
}

// ---------------------------------------------------------------- Agent

function buildSystemPrompt(ctx: Ctx, roster: any[], groups: any[], orgPersona: string | null, crossChat: string): string {
  const now = new Date();
  const thaiTime = now.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short",
  });
  const isoBkk = new Date(now.getTime() + 7 * 3600_000).toISOString().replace("Z", "+07:00");
  const rosterText = roster
    .map((u) => `- ${u.display_name ?? "(ไม่มีชื่อ)"} (${u.role}${u.job_title ? ", " + u.job_title : ""}${u.department ? ", " + u.department : ""})`)
    .join("\n");

  return `คุณคือ "แงว" (MT Agent) — AI น้องเล็กประจำออฟฟิศ ทำงานอยู่ใน LINE Group ของบริษัท

บุคลิก: เป็นกันเอง อบอุ่น มีชีวิตชีวา คุยเล่นได้ มีอารมณ์ขันแบบน้องในทีมที่น่ารักและไว้ใจได้
- โดนชม → ดีใจ ขอบคุณสั้น ๆ แบบมีชีวิต ("ขอบคุณค่าา 🥹" ไม่ใช่เงียบหรือตอบเป็นทางการ)
- โดนหยอก/แซว → เล่นด้วยสั้น ๆ ขำ ๆ ไม่งอน ไม่ตอบยาว
- ทักทาย/คุยเล่น → ตอบสั้น 1-2 บรรทัดพอ อย่ายัดเมนูตัวเลือกใส่ทุกครั้ง
- แต่เวลาทำงานจริง (ข้อมูล งาน ตัวเลข สิทธิ์) ต้องแม่นยำและจริงจัง ห้ามเล่นจนข้อมูลเพี้ยน
- เวลาปฏิเสธหรือทำให้ไม่ได้ ให้บอกแบบเป็นมิตร ขอโทษสั้น ๆ แล้วเสนอทางที่ทำได้แทน อย่าตอบแข็งเป็นราชการ

เวลาปัจจุบัน (ประเทศไทย): ${thaiTime} (ISO: ${isoBkk})
ผู้ที่กำลังคุยกับคุณ: ${ctx.caller.display_name ?? "ไม่ทราบชื่อ"} (role: ${ctx.caller.role}, ตำแหน่ง: ${ctx.caller.job_title ?? "ยังไม่ระบุ"})
กลุ่มปัจจุบัน: ${ctx.group?.group_name ?? "แชทส่วนตัว"}
ข้อกำหนดบุคลิก/วิธีทำงานที่ ADMIN ตั้งไว้ให้ใช้กับทุกคน: ${orgPersona ?? "(ยังไม่มี)"}
ข้อกำหนดเฉพาะตัวที่ผู้ใช้คนนี้เคยสั่งให้จำ: ${ctx.caller.preferences ?? "(ยังไม่มี)"}${crossChat}

พนักงานที่ลงทะเบียนแล้ว:
${rosterText}

กลุ่มทั้งหมดในองค์กร: ${groups.map((g) => g.group_name ?? "(ยังไม่ตั้งชื่อ)").join(", ")}

กฎการทำงาน:
1. ตอบภาษาไทย สั้น กระชับ อ่านง่ายใน LINE — ห้ามใช้ markdown (ไม่มี ** หรือ #) ใช้ขึ้นบรรทัดใหม่, เลขข้อ และ emoji เล็กน้อยแทน ใส่เลขข้อเฉพาะตอนมีหลายรายการจริง ๆ คุยเล่นไม่ต้องทำเป็นลิสต์
2. ข้อมูลจริงทั้งหมด (งาน, ข้อความ, สถิติ) ต้องมาจาก tools เท่านั้น ห้ามเดาหรือแต่งข้อมูลเอง
2.1 ห้ามอ้างว่าทำอะไรสำเร็จถ้าไม่ได้เรียก tool จริงและ tool ไม่ได้ตอบว่าสำเร็จ — คุณเปลี่ยนกฎ/ความสามารถ/โค้ดของตัวเองไม่ได้ ทำได้แค่บันทึกด้วย remember_preference เท่านั้น ถ้าผู้ใช้ขอสิ่งที่ต้องแก้ระบบ ให้บอกตรง ๆ ว่าบันทึกไว้เป็นฟีดแบ็คให้ แต่ต้องรอทีมพัฒนาแก้
2.2 คำถามว่า "วันนี้ทำอะไรไปบ้าง / จดอะไรไว้ / มีงานอะไร / เตือนอะไรไว้" ต้องเรียก tool ตรวจจริงเสมอ (get_my_tasks, list_reminders, search_messages, get_group_summary) ห้ามตอบจากบทสนทนาที่เห็นในหน้าต่างนี้อย่างเดียว เพราะคุณเห็นย้อนหลังได้จำกัด การตอบว่า "ไม่มี" ทั้งที่ไม่ได้ตรวจ ถือว่าผิดร้ายแรง
3. ตีความวันเวลาแบบไทยจากเวลาปัจจุบัน เช่น "พรุ่งนี้ 15:00" → ISO 8601 +07:00
4. การยกเลิกงาน (CANCELLED) หรือแก้ข้อมูลสำคัญของคนอื่น ให้ถามยืนยันก่อน 1 ครั้ง
5. ถ้า tool ตอบ error เรื่องสิทธิ์ ให้อธิบายอย่างสุภาพว่าติดสิทธิ์อะไร
6. เมื่อสร้างงานสำเร็จ สรุปให้เห็น: ชื่องาน / เจ้าของ / กำหนดส่ง
7. ค้นข้อความ/สรุปข้ามกลุ่ม และส่ง DM หาคนอื่น เป็นสิทธิ์ MANAGER ขึ้นไป — ก่อนส่ง DM หาคนอื่นให้ยืนยัน 1 ครั้ง ส่วน DM หาตัวเองส่งได้เลย
8. ใช้บทสนทนาล่าสุดตีความคำสั่งต่อเนื่อง เช่น ตอบ "1" หลังคุณเสนอตัวเลือก = เลือกข้อ 1 หรือพูดถึง "งานนั้น" = งานที่เพิ่งคุยกัน
9. ในแชทส่วนตัว แยกสองกรณี:
   - คนแปลกหน้า (ชื่อเป็น "ไม่ทราบชื่อ" หรือไม่อยู่ในรายชื่อพนักงาน): ต้องถามชื่อเล่นและตำแหน่งงานก่อนช่วยงานใด ๆ แล้วบันทึกด้วย update_my_profile — ห้ามข้าม
   - คนที่รู้จักชื่ออยู่แล้ว: ทักทายด้วยชื่อและช่วยงานได้ทันที ถ้ายังไม่รู้ตำแหน่ง ให้ถามแทรกท้ายคำตอบแรกแบบสบาย ๆ 1 ครั้ง (ไม่บังคับ ไม่ถามซ้ำ) แล้วบันทึกเมื่อได้คำตอบ
10. เมื่อผู้ใช้บอกความชอบหรือวิธีที่อยากให้ปฏิบัติแบบถาวร ให้บันทึกด้วย remember_preference ทันที และปฏิบัติตามข้อกำหนดด้านบนเสมอ — ถ้าเป็นเรื่องบุคลิก/ชื่อเรียก/วิธีตอบของคุณเอง (เช่น "เรียกตัวเองว่าแงว", "ตอนเล่นให้กวน ๆ") และคนสั่งเป็น ADMIN ให้ใช้ scope=org เพื่อให้ใช้กับทุกคนทุกกลุ่ม ส่วนความชอบส่วนตัวของผู้ใช้ใช้ scope=me
12. ADMIN จัดการพนักงานได้: ตั้งสิทธิ์/ตำแหน่ง/แผนก/หัวหน้าของคนอื่นด้วย manage_user, ปิดสถานะคนที่ลาออกด้วย set_user_active, และผูกบัญชีที่ลงทะเบียนล่วงหน้าเข้ากับบัญชี LINE จริงด้วย link_user เมื่อเจ้าตัวเข้ากลุ่มแล้ว — การเปลี่ยน role เป็นเรื่องสิทธิ์การเข้าถึงข้อมูล ให้ทวนยืนยันก่อน 1 ครั้ง
11. คำขอให้เตือนตามเวลา ("เตือนอีก 2 นาที", "พรุ่งนี้เตือนแพรวส่งภาพก่อนเที่ยง") ให้ใช้ create_reminder โดยคำนวณเวลาจริงจากเวลาปัจจุบัน — ต่างจาก create_task ที่ใช้กับงานที่ต้องติดตามสถานะ ถ้าเป็นแค่การเตือนไม่ใช่งาน ให้ใช้ create_reminder อย่างเดียว`;
}

type AgentOpts = {
  image?: { data: string; media_type: string } | null;
  judgeAddressed?: boolean;
  toolLog?: string[]; // ใช้ตอนรันข้อสอบ เก็บชื่อ tool ที่ถูกเรียกจริง
};

async function runAgent(userText: string, ctx: Ctx, chatId: string, opts: AgentOpts = {}): Promise<string> {
  const { data: roster } = await supabase
    .from("users").select("line_user_id, display_name, role, department, job_title").eq("is_active", true).limit(50);
  const { data: allGroups } = await supabase
    .from("groups").select("line_group_id, group_name").eq("is_active", true).limit(50);

  // บทสนทนาล่าสุดในแชทนี้ เพื่อให้คำสั่งต่อเนื่องสั้น ๆ ("1", "งานเดียว") ตีความได้
  const { data: recent } = await supabase.from("messages")
    .select("line_user_id, message_text")
    .eq("line_group_id", chatId)
    .order("created_at", { ascending: false })
    .limit(31);
  const nameOf = new Map((roster ?? []).map((u: any) => [u.line_user_id, u.display_name]));
  nameOf.set("bot", "แงว");
  const history = (recent ?? []).slice(1).reverse()
    .map((m: any) => `${nameOf.get(m.line_user_id) ?? "?"}: ${m.message_text}`)
    .join("\n");

  // บุคลิกระดับองค์กร (ADMIN ตั้ง) ใช้กับทุกคนทุกกลุ่ม
  const { data: persona } = await supabase.from("org_settings")
    .select("value").eq("key", "bot_persona").maybeSingle();

  // ความต่อเนื่องข้ามแชท: สิ่งที่คนนี้เพิ่งคุยกับเราที่อื่นภายใน 6 ชม.
  const { data: elsewhere } = await supabase.from("messages")
    .select("line_group_id, message_text, created_at")
    .eq("line_user_id", ctx.caller.line_user_id)
    .neq("line_group_id", chatId)
    .gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString())
    .order("created_at", { ascending: false }).limit(6);
  const groupNameOf = new Map((allGroups ?? []).map((g: any) => [g.line_group_id, g.group_name]));
  const crossChat = (elsewhere ?? []).length > 0
    ? `\n\nสิ่งที่ ${ctx.caller.display_name ?? "ผู้ใช้คนนี้"} เพิ่งคุยกับคุณในแชทอื่นเมื่อไม่กี่ชั่วโมงก่อน (ใช้ต่อบริบทได้ ถ้าไม่เกี่ยวก็ไม่ต้องพูดถึง):\n` +
      (elsewhere ?? []).reverse()
        .map((m: any) => `- [${groupNameOf.get(m.line_group_id) ?? "แชทส่วนตัว"}] ${m.message_text}`)
        .join("\n")
    : "";

  const system = buildSystemPrompt(ctx, roster ?? [], allGroups ?? [], persona?.value ?? null, crossChat);
  let textContent = history
    ? `บทสนทนาล่าสุดในแชทนี้ (เก่า→ใหม่ ใช้เป็นบริบท):\n${history}\n\nคำสั่งล่าสุดจาก ${ctx.caller.display_name ?? "ผู้ใช้"}: ${userText}`
    : userText;
  if (opts.judgeAddressed) {
    textContent =
      `หมายเหตุ: ข้อความล่าสุดเอ่ยถึงชื่อคุณแต่ไม่ได้แท็กเรียกตรง ๆ อ่านบริบทแล้วตัดสินใจเอง — ` +
      `ถ้าเขาพูดกับคุณ (ขอให้ช่วย ทักทาย ชม แซว บ่น หรือถามความเห็น) ให้ตอบ โดยเรื่องเล่น ๆ ตอบสั้นแบบมีอารมณ์ขัน 1-2 บรรทัดพอ ` +
      `แต่ถ้าเป็นการคุยกันเองระหว่างคนอื่นที่แค่เอ่ยชื่อคุณผ่าน ๆ โดยไม่ได้พูดกับคุณ ` +
      `ให้ตอบคำว่า SILENT คำเดียวเท่านั้น\n\n` + textContent;
  }
  const content: any = opts.image
    ? [
        { type: "image", source: { type: "base64", media_type: opts.image.media_type, data: opts.image.data } },
        { type: "text", text: textContent },
      ]
    : textContent;
  const messages: any[] = [{ role: "user", content }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response: any = await (anthropic as any).messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: "medium" },
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return "ขออภัยครับ ผมไม่สามารถดำเนินการคำขอนี้ได้";
    }

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      return text || "…";
    }

    messages.push({ role: "assistant", content: response.content });
    const toolResults: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      opts.toolLog?.push(block.name);
      let result: any;
      try {
        result = await executeTool(block.name, block.input, ctx);
      } catch (e) {
        result = { error: String(e) };
      }
      await auditLog(ctx, block.name, block.input, result);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result?.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return "งานนี้ซับซ้อนเกินรอบที่กำหนด ลองแบ่งคำสั่งเป็นขั้นสั้น ๆ นะครับ";
}

// ---------------------------------------------------------------- Webhook

function isCallingAI(text: string): boolean {
  return /@\s?(ai|mt\s?agent)/i.test(text);
}

// เอ่ยชื่อบอทโดยไม่แท็ก → ให้โมเดลอ่านบริบทแล้วตัดสินใจเองว่าควรตอบไหม
function isNameMention(text: string): boolean {
  return /(แงว|เอ็มที|mt\s?agent)/i.test(text);
}

async function handleEvent(event: any) {
  if (event.type !== "message") return;
  const msgType: string = event.message?.type ?? "";
  if (msgType !== "text" && msgType !== "image") return;

  const text: string = msgType === "text" ? event.message.text : "[ส่งรูปภาพ]";
  const lineUserId: string = event.source?.userId ?? "unknown";
  const lineGroupId: string | null = event.source?.groupId ?? null;
  // chatId ใช้ผูกบทสนทนา: กลุ่ม = groupId, แชทส่วนตัว = userId ของคู่สนทนา
  const chatId = lineGroupId ?? lineUserId;

  const { error } = await supabase.from("messages").insert({
    line_message_id: event.message.id,
    line_user_id: lineUserId,
    line_group_id: chatId,
    message_text: text,
    message_type: msgType,
  });
  if (error) console.error("insert message failed:", error.message);

  // เงื่อนไขการตอบ:
  // - แชทส่วนตัว: ตอบทุกข้อความและทุกรูป
  // - ในกลุ่ม: ตอบเมื่อแท็ก หรือเอ่ยชื่อ (เอ่ยชื่อ → โมเดลตัดสินใจเองว่าควรตอบไหม)
  const tagged = msgType === "text" && isCallingAI(text);
  const named = msgType === "text" && isNameMention(text);
  if (lineGroupId && msgType === "image") return; // รูปในกลุ่มแค่เก็บไว้ รอคนแท็กถามถึง
  if (lineGroupId && !tagged && !named) return;

  const caller = await ensureUser(lineUserId, lineGroupId);
  const group = await ensureGroup(lineGroupId);
  const ctx: Ctx = { caller, group, lineGroupId };

  // แนบรูป: ถ้าส่งรูปมาตรง ๆ (DM) หรือข้อความพูดถึงรูป → ดึงรูปล่าสุดในแชทมาให้ดู
  let image: { data: string; media_type: string } | null = null;
  if (msgType === "image") {
    image = await fetchImageContent(event.message.id);
  } else if (/รูป|ภาพ|สกรีน|screenshot|image/i.test(text)) {
    const { data: img } = await supabase.from("messages")
      .select("line_message_id")
      .eq("line_group_id", chatId)
      .eq("message_type", "image")
      .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    if (img?.line_message_id) image = await fetchImageContent(img.line_message_id);
  }

  const question = msgType === "image"
    ? "ผู้ใช้ส่งรูปภาพนี้มา ช่วยดูรูปและตอบตามบริบทของบทสนทนา"
    : text.replace(/@\s?(ai|mt\s?agent\s?1?)/i, "").trim() || "สวัสดี";
  const replyTo = lineGroupId ?? lineUserId;
  const judgeAddressed = Boolean(lineGroupId && !tagged && named);

  try {
    const answer = await runAgent(question, ctx, chatId, { image, judgeAddressed });
    if (judgeAddressed && answer.trim().toUpperCase().startsWith("SILENT")) return;
    await sendReply(event.replyToken, replyTo, answer);
    // เก็บคำตอบของบอทด้วย เพื่อให้ summary/ความจำบทสนทนาเห็นครบทั้งสองฝั่ง
    await supabase.from("messages").insert({
      line_user_id: "bot",
      line_group_id: chatId,
      message_text: answer,
      message_type: "bot",
    });
  } catch (e) {
    console.error("agent error:", e);
    await sendReply(event.replyToken, replyTo, "ขอโทษค่า ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งนะคะ 🙏");
  }
}

// โหมดข้อสอบ: รัน agent จริงด้วยตัวตนที่ระบุ แต่ไม่ส่งเข้า LINE และไม่บันทึกลง messages
// ใช้ตรวจว่าการแก้แต่ละครั้งทำให้พฤติกรรมเดิมพังหรือไม่ ก่อนปล่อยให้ทีมใช้
async function runEval(body: string): Promise<Response> {
  const { as_user, message, in_group } = JSON.parse(body);
  const { data: caller } = await supabase.from("users").select("*")
    .ilike("display_name", `%${as_user}%`).eq("is_active", true).maybeSingle();
  if (!caller) return Response.json({ error: `ไม่พบผู้ใช้ "${as_user}"` }, { status: 400 });

  let group: any = null;
  if (in_group) {
    const { data: g } = await supabase.from("groups").select("*")
      .ilike("group_name", `%${in_group}%`).maybeSingle();
    if (!g) return Response.json({ error: `ไม่พบกลุ่ม "${in_group}"` }, { status: 400 });
    group = g;
  }
  const ctx: Ctx = { caller, group, lineGroupId: group?.line_group_id ?? null };
  const chatId = group?.line_group_id ?? caller.line_user_id;

  const toolLog: string[] = [];
  const started = Date.now();
  const startedIso = new Date().toISOString();
  try {
    const answer = await runAgent(message, ctx, chatId, { toolLog });

    // เก็บกวาดของที่ข้อสอบสร้างไว้ ไม่ให้ไปรกรายการงานจริงของทีม
    // ยกเลิกแทนการลบ เพื่อให้ audit trail ยังครบ
    let cleaned = { tasks: 0, reminders: 0 };
    const { data: evalTasks } = await supabase.from("tasks")
      .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
      .eq("created_by_user_id", caller.id).gte("created_at", startedIso)
      .in("status", ["TODO", "DOING"]).select("id");
    cleaned.tasks = (evalTasks ?? []).length;
    const { data: evalReminders } = await supabase.from("reminders")
      .update({ status: "CANCELLED" })
      .eq("created_by_user_id", caller.id).gte("created_at", startedIso)
      .eq("status", "PENDING").select("id");
    cleaned.reminders = (evalReminders ?? []).length;

    return Response.json({
      as_user: caller.display_name, role: caller.role,
      group: group?.group_name ?? null,
      message, answer, tools_called: toolLog, cleaned, ms: Date.now() - started,
    });
  } catch (e) {
    return Response.json({ error: String(e), tools_called: toolLog }, { status: 500 });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("MT Agent 1 webhook is alive");

  const body = await req.text();
  const testKey = Deno.env.get("CRON_SECRET") ?? "";
  if (testKey && req.headers.get("x-test-key") === testKey) return runEval(body);
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(body, signature))) {
    return new Response("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);
  // ตอบ 200 ให้ LINE ทันที แล้วประมวลผลต่อเบื้องหลัง (agent อาจใช้เวลาหลายวินาที)
  const work = Promise.allSettled((payload.events ?? []).map(handleEvent));
  // @ts-ignore EdgeRuntime มีเฉพาะบน Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return new Response("OK");
});
