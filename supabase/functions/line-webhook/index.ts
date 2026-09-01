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

async function ensureGroup(lineGroupId: string | null) {
  if (!lineGroupId) return null;
  const { data: existing } = await supabase
    .from("groups").select("*").eq("line_group_id", lineGroupId).maybeSingle();
  if (existing) return existing;
  const { data: created } = await supabase
    .from("groups").insert({ line_group_id: lineGroupId }).select().single();
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
    description: "ค้นหาข้อความเก่าในกลุ่มนี้ด้วยคำค้น",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_group_summary",
    description:
      "ดึงข้อความในกลุ่มนี้ตามช่วงเวลา (ชั่วโมงย้อนหลัง) เพื่อนำมาสรุป พร้อมสถิติงานของกลุ่ม",
    input_schema: {
      type: "object",
      properties: {
        hours_back: { type: "integer", description: "ย้อนหลังกี่ชั่วโมง เช่น 24 = วันนี้" },
      },
      required: ["hours_back"],
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
      if (!ctx.lineGroupId) return { error: "ใช้ได้เฉพาะในกลุ่ม" };
      const { data, error } = await supabase.from("messages")
        .select("line_user_id, message_text, created_at")
        .eq("line_group_id", ctx.lineGroupId)
        .ilike("message_text", `%${input.query}%`)
        .order("created_at", { ascending: false })
        .limit(Math.min(input.limit ?? 20, 50));
      if (error) return { error: error.message };
      return { results: data };
    }

    case "get_group_summary": {
      if (!ctx.lineGroupId) return { error: "ใช้ได้เฉพาะในกลุ่ม" };
      const since = new Date(Date.now() - input.hours_back * 3600_000).toISOString();
      const { data: msgs } = await supabase.from("messages")
        .select("line_user_id, message_text, created_at")
        .eq("line_group_id", ctx.lineGroupId)
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .limit(200);
      const { data: users } = await supabase.from("users").select("line_user_id, display_name");
      const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));
      const { data: tasks } = await supabase.from("tasks")
        .select("title, status, due_at")
        .eq("group_id", ctx.group?.id ?? "00000000-0000-0000-0000-000000000000")
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

function buildSystemPrompt(ctx: Ctx, roster: any[]): string {
  const now = new Date();
  const thaiTime = now.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short",
  });
  const isoBkk = new Date(now.getTime() + 7 * 3600_000).toISOString().replace("Z", "+07:00");
  const rosterText = roster
    .map((u) => `- ${u.display_name ?? "(ไม่มีชื่อ)"} (${u.role}${u.department ? ", " + u.department : ""})`)
    .join("\n");

  return `คุณคือ "MT Agent" — AI กลางขององค์กร ทำงานอยู่ใน LINE Group ขององค์กร

เวลาปัจจุบัน (ประเทศไทย): ${thaiTime} (ISO: ${isoBkk})
ผู้ที่กำลังคุยกับคุณ: ${ctx.caller.display_name ?? "ไม่ทราบชื่อ"} (role: ${ctx.caller.role})
กลุ่มปัจจุบัน: ${ctx.group?.group_name ?? "แชทส่วนตัว"}

พนักงานที่ลงทะเบียนแล้ว:
${rosterText}

กฎการทำงาน:
1. ตอบภาษาไทย สั้น กระชับ อ่านง่ายใน LINE — ห้ามใช้ markdown (ไม่มี ** หรือ #) ใช้ขึ้นบรรทัดใหม่, เลขข้อ และ emoji เล็กน้อยแทน
2. ข้อมูลจริงทั้งหมด (งาน, ข้อความ, สถิติ) ต้องมาจาก tools เท่านั้น ห้ามเดาหรือแต่งข้อมูลเอง
3. ตีความวันเวลาแบบไทยจากเวลาปัจจุบัน เช่น "พรุ่งนี้ 15:00" → ISO 8601 +07:00
4. การยกเลิกงาน (CANCELLED) หรือแก้ข้อมูลสำคัญของคนอื่น ให้ถามยืนยันก่อน 1 ครั้ง
5. ถ้า tool ตอบ error เรื่องสิทธิ์ ให้อธิบายอย่างสุภาพว่าติดสิทธิ์อะไร
6. เมื่อสร้างงานสำเร็จ สรุปให้เห็น: ชื่องาน / เจ้าของ / กำหนดส่ง`;
}

async function runAgent(userText: string, ctx: Ctx): Promise<string> {
  const { data: roster } = await supabase
    .from("users").select("display_name, role, department").eq("is_active", true).limit(50);

  const system = buildSystemPrompt(ctx, roster ?? []);
  const messages: any[] = [{ role: "user", content: userText }];

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

async function handleEvent(event: any) {
  if (event.type !== "message" || event.message?.type !== "text") return;
  const text: string = event.message.text;
  const lineUserId: string = event.source?.userId ?? "unknown";
  const lineGroupId: string | null = event.source?.groupId ?? null;

  const { error } = await supabase.from("messages").insert({
    line_message_id: event.message.id,
    line_user_id: lineUserId,
    line_group_id: lineGroupId,
    message_text: text,
    message_type: "text",
  });
  if (error) console.error("insert message failed:", error.message);

  if (!isCallingAI(text)) return;

  const caller = await ensureUser(lineUserId, lineGroupId);
  const group = await ensureGroup(lineGroupId);
  const ctx: Ctx = { caller, group, lineGroupId };

  const question = text.replace(/@\s?(ai|mt\s?agent\s?1?)/i, "").trim() || "สวัสดี";
  const replyTo = lineGroupId ?? lineUserId;

  try {
    const answer = await runAgent(question, ctx);
    await sendReply(event.replyToken, replyTo, answer);
  } catch (e) {
    console.error("agent error:", e);
    await sendReply(event.replyToken, replyTo, "ขอโทษครับ ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งนะครับ");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("MT Agent 1 webhook is alive");

  const body = await req.text();
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
