// MT Agent 1 — Scheduled Jobs (MVP 0.2)
// ถูกเรียกโดย pg_cron: daily_summary (18:00), morning_reminder (09:00), weekly_summary (จันทร์ 09:00),
// due_reminders (ทุกนาที) และ extract_events (ทุก 3 ชม.)
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  ...(WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } } : {}),
});

async function pushToGroup(to: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.error("LINE push failed:", res.status, await res.text());
}

function thaiDate(d: Date): string {
  return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------- daily summary (18:00)

async function dailySummary() {
  const { data: groups } = await supabase.from("groups").select("*").eq("is_active", true);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: users } = await supabase.from("users").select("id, line_user_id, display_name");
  const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));
  nameOf.set("bot", "MT Agent");
  const ownerOf = new Map((users ?? []).map((u: any) => [u.id, u.display_name]));

  for (const g of groups ?? []) {
    const { data: msgs } = await supabase.from("messages")
      .select("line_user_id, message_text, created_at")
      .eq("line_group_id", g.line_group_id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(300);
    if (!msgs || msgs.length === 0) continue; // กลุ่มเงียบทั้งวัน ไม่ต้องสรุป

    const { data: newTasks } = await supabase.from("tasks")
      .select("title, status, due_at").eq("group_id", g.id).gte("created_at", since);
    const { data: doneTasks } = await supabase.from("tasks")
      .select("title").eq("group_id", g.id).eq("status", "DONE").gte("completed_at", since);

    const transcript = msgs
      .map((m: any) => `${nameOf.get(m.line_user_id) ?? "?"}: ${m.message_text}`)
      .join("\n");

    const response: any = await (anthropic as any).messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      system:
        `คุณคือ MT Agent สรุปประจำวันของ LINE Group ให้ทีม อ่านบทสนทนาแล้วสรุปเป็นภาษาไทย ` +
        `ห้ามใช้ markdown ใช้เลขข้อและขึ้นบรรทัดใหม่ เน้น: เรื่องสำคัญที่คุยกัน / การตัดสินใจ / งานที่เกิดขึ้น-เสร็จ / สิ่งที่ค้างต้องตามต่อ ` +
        `สั้น กระชับ ไม่เกิน 12 บรรทัด ข้ามเรื่องหยอกล้อไม่สำคัญ ข้อความจาก "MT Agent" คือคำตอบของบอทเอง ใช้เป็นข้อมูลประกอบผลลัพธ์ที่เกิดขึ้นจริง`,
      messages: [{
        role: "user",
        content:
          `บทสนทนาวันนี้:\n${transcript}\n\n` +
          `งานที่สร้างวันนี้: ${JSON.stringify(newTasks ?? [])}\n` +
          `งานที่เสร็จวันนี้: ${JSON.stringify(doneTasks ?? [])}`,
      }],
    });
    const summary = response.content
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (!summary) continue;

    // สิ่งที่ extract_events จับได้วันนี้และยังไม่มีใครยืนยัน — ต่อท้ายแบบตรงไปตรงมา ไม่ให้โมเดลแต่งเพิ่ม
    const { data: newEvents } = await supabase.from("events")
      .select("type, title, due_at, owner_user_id")
      .eq("chat_id", g.line_group_id).eq("status", "NEW")
      .gte("created_at", since)
      .order("created_at", { ascending: true }).limit(10);
    let eventsBlock = "";
    if ((newEvents ?? []).length > 0) {
      const label: Record<string, string> = { TASK: "งาน", DECISION: "ข้อตกลง", DEADLINE: "กำหนดส่ง" };
      eventsBlock = "\n\n📌 แงวจับไว้ให้ (ยังไม่ได้สร้างเป็นงาน)\n" +
        (newEvents ?? []).map((e: any, i: number) => {
          const who = e.owner_user_id ? ownerOf.get(e.owner_user_id) : null;
          const due = e.due_at ? ` ครบ ${thaiDate(new Date(e.due_at))}` : "";
          return `${i + 1}. [${label[e.type] ?? e.type}] ${e.title}${who ? ` — ${who}` : ""}${due}`;
        }).join("\n") +
        '\n\nพิมพ์ "แงว ขอดูรายการที่จับไว้" เพื่อยืนยันหรือปัดทิ้ง';
    }

    await pushToGroup(g.line_group_id, `🌆 สรุปประจำวัน — ${g.group_name ?? "กลุ่ม"}\n\n${summary}${eventsBlock}`);
    await supabase.from("audit_logs").insert({
      action: "scheduled_job", tool_name: "daily_summary",
      input: { group: g.line_group_id },
      result: { messages: msgs.length, pending_events: (newEvents ?? []).length }, status: "OK",
    });
  }
}

// ---------------------------------------------------------------- morning reminder (09:00)

async function morningReminder() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600_000);
  const { data: groups } = await supabase.from("groups").select("*").eq("is_active", true);

  for (const g of groups ?? []) {
    const { data: tasks } = await supabase.from("tasks")
      .select("title, due_at, status, owner:users!tasks_owner_user_id_fkey(display_name)")
      .eq("group_id", g.id)
      .in("status", ["TODO", "DOING"])
      .not("due_at", "is", null)
      .lte("due_at", in24h.toISOString())
      .order("due_at", { ascending: true });
    if (!tasks || tasks.length === 0) continue;

    const overdue = tasks.filter((t: any) => new Date(t.due_at) < now);
    const dueSoon = tasks.filter((t: any) => new Date(t.due_at) >= now);

    let text = "🌅 เช้านี้มีงานต้องติดตาม\n";
    if (overdue.length > 0) {
      text += "\n🔴 เลยกำหนดแล้ว:\n" + overdue
        .map((t: any, i: number) => `${i + 1}. ${t.title} — ${t.owner?.display_name ?? "ไม่มีเจ้าของ"} (ครบกำหนด ${thaiDate(new Date(t.due_at))})`)
        .join("\n") + "\n";
    }
    if (dueSoon.length > 0) {
      text += "\n🟡 ครบกำหนดภายใน 24 ชม.:\n" + dueSoon
        .map((t: any, i: number) => `${i + 1}. ${t.title} — ${t.owner?.display_name ?? "ไม่มีเจ้าของ"} (ส่ง ${thaiDate(new Date(t.due_at))})`)
        .join("\n");
    }

    await pushToGroup(g.line_group_id, text.trim());
    await supabase.from("audit_logs").insert({
      action: "scheduled_job", tool_name: "morning_reminder",
      input: { group: g.line_group_id },
      result: { overdue: overdue.length, due_soon: dueSoon.length }, status: "OK",
    });
  }
}

// ---------------------------------------------------------------- weekly summary (จันทร์ 09:00)

async function weeklySummary() {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: groups } = await supabase.from("groups").select("*").eq("is_active", true);
  const { data: users } = await supabase.from("users").select("id, line_user_id, display_name");
  const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));
  nameOf.set("bot", "แงว");
  const ownerOf = new Map((users ?? []).map((u: any) => [u.id, u.display_name]));

  for (const g of groups ?? []) {
    const { data: msgs } = await supabase.from("messages")
      .select("line_user_id, message_text")
      .eq("line_group_id", g.line_group_id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(600);
    if (!msgs || msgs.length < 5) continue; // กลุ่มเงียบทั้งสัปดาห์ ข้าม

    const { data: tasks } = await supabase.from("tasks")
      .select("title, status, due_at, owner_user_id, completed_at")
      .eq("group_id", g.id).gte("created_at", since);
    const { data: done } = await supabase.from("tasks")
      .select("title, owner_user_id").eq("group_id", g.id)
      .eq("status", "DONE").gte("completed_at", since);
    const { data: overdue } = await supabase.from("tasks")
      .select("title, due_at, owner_user_id").eq("group_id", g.id)
      .in("status", ["TODO", "DOING"]).not("due_at", "is", null)
      .lt("due_at", new Date().toISOString());

    const withOwner = (rows: any[] | null) =>
      (rows ?? []).map((t: any) => ({ ...t, owner: ownerOf.get(t.owner_user_id) ?? "ไม่มีเจ้าของ" }));

    const transcript = msgs
      .map((m: any) => `${nameOf.get(m.line_user_id) ?? "?"}: ${m.message_text}`)
      .join("\n").slice(0, 60000);

    const response: any = await (anthropic as any).messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      output_config: { effort: "medium" },
      system:
        `คุณคือแงว สรุปภาพรวมประจำสัปดาห์ของทีมจากบทสนทนาและข้อมูลงาน ตอบภาษาไทย ` +
        `ห้ามใช้ markdown ใช้หัวข้อสั้นกับเลขข้อ ไม่เกิน 18 บรรทัด เนื้อหาต้องมี: ` +
        `เรื่องหลักที่ทีมโฟกัสสัปดาห์นี้ / การตัดสินใจสำคัญ / งานที่เสร็จ / งานที่ค้างและเลยกำหนด / สิ่งที่ควรตามต่อสัปดาห์หน้า ` +
        `เน้นสิ่งที่มีผลต่อการทำงานจริง ข้ามเรื่องเล่นและทักทาย`,
      messages: [{
        role: "user",
        content:
          `บทสนทนา 7 วันล่าสุด:\n${transcript}\n\n` +
          `งานที่สร้างสัปดาห์นี้: ${JSON.stringify(withOwner(tasks))}\n` +
          `งานที่เสร็จสัปดาห์นี้: ${JSON.stringify(withOwner(done))}\n` +
          `งานที่เลยกำหนดและยังค้าง: ${JSON.stringify(withOwner(overdue))}`,
      }],
    });
    const summary = response.content
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (!summary) continue;

    await pushToGroup(g.line_group_id, `📊 สรุปประจำสัปดาห์ — ${g.group_name ?? "กลุ่ม"}\n\n${summary}`);
    await supabase.from("audit_logs").insert({
      action: "scheduled_job", tool_name: "weekly_summary",
      input: { group: g.line_group_id },
      result: { messages: msgs.length, done: (done ?? []).length, overdue: (overdue ?? []).length },
      status: "OK",
    });
  }
}

// ---------------------------------------------------------------- event extraction (ทุก 3 ชม.)
// อ่านบทสนทนาปกติที่ไม่มีใครสั่งบอท แล้วจับ งาน/ข้อตกลง/กำหนดส่ง เก็บเป็นข้อเสนอสถานะ NEW
// ห้ามสร้างเป็นงานจริงเอง ต้องมีคนยืนยันด้วย confirm_event เสมอ

const EVENT_CURSOR_KEY = "event_extraction_cursor";
const EVENT_TYPES = ["TASK", "DECISION", "DEADLINE"];

const EXTRACT_TOOL = {
  name: "record_events",
  description: "บันทึกสิ่งที่จับได้จากบทสนทนา ถ้าอ่านแล้วไม่มีอะไรเข้าเกณฑ์เลย ให้ส่ง events เป็นลิสต์ว่าง",
  input_schema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: EVENT_TYPES },
            title: { type: "string", description: "สรุปสั้นไม่เกิน 80 ตัวอักษร อ่านแล้วเข้าใจโดยไม่ต้องย้อนดูแชท" },
            detail: { type: "string", description: "รายละเอียดเพิ่มเติมถ้ามี" },
            owner_name: { type: "string", description: "ชื่อเล่นคนที่ต้องรับผิดชอบ ถ้าไม่ชัดให้เว้นว่าง" },
            said_by_name: { type: "string", description: "ชื่อเล่นคนที่พูดเรื่องนี้" },
            due_at: { type: "string", description: "ISO 8601 +07:00 เฉพาะเมื่อมีกำหนดชัดเจน" },
            confidence: { type: "number", description: "0–1 ความมั่นใจว่าเป็นเรื่องจริงจัง ไม่ใช่คุยเล่นหรือเดาเอง" },
            source_excerpt: { type: "string", description: "ข้อความต้นทางสั้น ๆ ที่ทำให้สรุปแบบนี้" },
          },
          required: ["type", "title", "confidence"],
        },
      },
    },
    required: ["events"],
  },
};

async function extractEvents() {
  const runStart = new Date();
  const { data: cursorRow } = await supabase.from("org_settings")
    .select("value").eq("key", EVENT_CURSOR_KEY).maybeSingle();
  const since = cursorRow?.value ?? new Date(runStart.getTime() - 24 * 3600_000).toISOString();

  const { data: groups } = await supabase.from("groups").select("*").eq("is_active", true);
  const { data: users } = await supabase.from("users")
    .select("id, line_user_id, display_name").eq("is_active", true);
  const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));
  nameOf.set("bot", "แงว");

  // จับคู่ชื่อเล่นที่โมเดลตอบกลับมากับพนักงานจริง ถ้าไม่ชัดให้เป็น null ดีกว่าเดาผิดคน
  const findUser = (name?: string): string | null => {
    const n = String(name ?? "").trim().toLowerCase();
    if (!n) return null;
    const hits = (users ?? []).filter((u: any) => {
      const d = String(u.display_name ?? "").trim().toLowerCase();
      return d.length > 0 && (d.includes(n) || n.includes(d));
    });
    return hits.length === 1 ? hits[0].id : null;
  };

  let totalSaved = 0;
  for (const g of groups ?? []) {
    try {
      const { data: msgs } = await supabase.from("messages")
        .select("line_user_id, message_text, created_at")
        .eq("line_group_id", g.line_group_id)
        .gte("created_at", since).lt("created_at", runStart.toISOString())
        .order("created_at", { ascending: true }).limit(400);
      const human = (msgs ?? []).filter((m: any) => m.line_user_id !== "bot");
      if (human.length < 3) continue; // คุยกันไม่กี่คำ ยังไม่พอให้สรุปอะไร

      const { data: known } = await supabase.from("events")
        .select("type, title").eq("chat_id", g.line_group_id)
        .order("created_at", { ascending: false }).limit(60);

      // งานที่ถูกสร้างผ่านบอทไปแล้ว ไม่ต้องจับซ้ำให้คนต้องมานั่งปัดทิ้งเอง
      const { data: existingTasks } = await supabase.from("tasks")
        .select("title, status").eq("group_id", g.id)
        .order("created_at", { ascending: false }).limit(40);

      const transcript = (msgs ?? [])
        .map((m: any) => `[${thaiDate(new Date(m.created_at))}] ${nameOf.get(m.line_user_id) ?? "?"}: ${m.message_text}`)
        .join("\n").slice(0, 60000);
      const nowIso = new Date(runStart.getTime() + 7 * 3600_000).toISOString().replace("Z", "+07:00");

      const response: any = await (anthropic as any).messages.create({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        output_config: { effort: "low" },
        system:
          `คุณคือแงว อ่านบทสนทนาในกลุ่มงานแล้วดึงเฉพาะ 3 อย่างนี้ออกมา\n` +
          `TASK = มีคนถูกมอบหมายให้ทำอะไรจริง ๆ / DECISION = ทีมตกลงหรือสรุปอะไรกันแล้ว / DEADLINE = มีกำหนดเวลาที่ต้องส่งหรือต้องเกิดขึ้น\n\n` +
          `เกณฑ์:\n` +
          `- จับเฉพาะที่ชัดเจนพอจะเอาไปทำต่อได้ ห้ามเดาหรือแต่งเติมสิ่งที่ไม่มีใครพูด\n` +
          `- ข้ามการทักทาย คุยเล่น แซว บ่น และคำถามที่ยังไม่มีข้อสรุป\n` +
          `- เรื่องที่ยังเป็นแค่ข้อเสนอ ยังไม่มีใครรับปาก ให้ confidence ต่ำกว่า 0.6\n` +
          `- ข้อความของ "แงว" คือคำตอบของบอทเอง ใช้เป็นบริบทได้ แต่ห้ามเอามาเป็นเรื่องที่จับ\n` +
          `- เรื่องที่อยู่ในรายการ "จับไปแล้ว" หรือ "มีในระบบแล้ว" ห้ามจับซ้ำ แม้จะถูกพูดถึงอีกครั้ง\n` +
          `- ข้ามคำสั่งที่คนพูดกับแงวโดยตรงและการตั้งค่าระบบ (ตั้งชื่อกลุ่ม เปลี่ยนสิทธิ์ ตั้งเตือน สร้างงานผ่านบอท) เพราะระบบบันทึกไว้ให้แล้ว\n` +
          `- due_at คำนวณจากเวลาปัจจุบัน ถ้าไม่มีกำหนดชัดเจนให้เว้นว่าง อย่าเดาวันเอง\n` +
          `- ปีในวันที่ต้องเป็น ค.ศ. เท่านั้น (ปีนี้คือ ${new Date(runStart.getTime() + 7 * 3600_000).getUTCFullYear()}) ห้ามใช้ พ.ศ. เด็ดขาด\n\n` +
          `เวลาปัจจุบัน: ${nowIso}\n` +
          `คนในองค์กร: ${(users ?? []).map((u: any) => u.display_name).filter(Boolean).join(", ")}`,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "record_events" },
        messages: [{
          role: "user",
          content:
            `กลุ่ม: ${g.group_name ?? "ไม่มีชื่อ"}\n\n` +
            `จับไปแล้ว (ห้ามซ้ำ):\n${(known ?? []).map((e: any) => `- [${e.type}] ${e.title}`).join("\n") || "(ยังไม่มี)"}\n\n` +
            `มีในระบบแล้ว (ห้ามซ้ำ):\n${(existingTasks ?? []).map((t: any) => `- ${t.title} [${t.status}]`).join("\n") || "(ยังไม่มี)"}\n\n` +
            `บทสนทนาที่ต้องอ่าน:\n${transcript}`,
        }],
      });

      const call = (response.content ?? []).find((b: any) => b.type === "tool_use");
      const found = (call?.input?.events ?? []).filter((e: any) =>
        EVENT_TYPES.includes(e?.type) && String(e?.title ?? "").trim().length > 0 &&
        Number(e?.confidence) >= 0.6);
      if (found.length === 0) continue;

      // กันวันที่เพี้ยน โดยเฉพาะกรณีโมเดลเผลอตอบเป็น พ.ศ. (2569) ซึ่งจะกลายเป็นกำหนดส่งอีก 543 ปี
      const minDue = runStart.getTime() - 365 * 24 * 3600_000;
      const maxDue = runStart.getTime() + 5 * 365 * 24 * 3600_000;
      const rows = found.slice(0, 20).map((e: any) => {
        const d = e.due_at ? new Date(e.due_at) : null;
        const due = d && !isNaN(d.getTime()) && d.getTime() >= minDue && d.getTime() <= maxDue ? d : null;
        return {
          chat_id: g.line_group_id,
          group_id: g.id,
          type: e.type,
          title: String(e.title).trim().slice(0, 200),
          detail: e.detail ? String(e.detail).slice(0, 1000) : null,
          owner_user_id: findUser(e.owner_name),
          said_by_user_id: findUser(e.said_by_name),
          due_at: due ? due.toISOString() : null,
          confidence: Math.min(1, Math.max(0, Number(e.confidence))),
          source_excerpt: e.source_excerpt ? String(e.source_excerpt).slice(0, 500) : null,
        };
      });
      const { data: inserted, error: insErr } = await supabase.from("events")
        .upsert(rows, { onConflict: "chat_id,type,title", ignoreDuplicates: true })
        .select("id");
      if (insErr) throw new Error(insErr.message);
      totalSaved += (inserted ?? []).length;

      await supabase.from("audit_logs").insert({
        action: "scheduled_job", tool_name: "extract_events",
        input: { group: g.line_group_id, messages: human.length },
        result: { detected: found.length, saved: (inserted ?? []).length }, status: "OK",
      });
    } catch (e) {
      console.error(`extract_events failed for ${g.line_group_id}:`, e);
      await supabase.from("audit_logs").insert({
        action: "scheduled_job", tool_name: "extract_events",
        input: { group: g.line_group_id }, result: { error: String(e) }, status: "ERROR",
      });
    }
  }

  // เลื่อน cursor หลังวนครบทุกกลุ่ม และใช้เวลาเริ่มรัน จะได้ไม่มีช่วงข้อความหายไประหว่างทาง
  await supabase.from("org_settings").upsert({
    key: EVENT_CURSOR_KEY,
    value: runStart.toISOString(),
    updated_at: new Date().toISOString(),
  });
  console.log(`extract_events: saved ${totalSaved} new events since ${since}`);
}

// ---------------------------------------------------------------- due reminders (ทุกนาที)

async function dueReminders() {
  const { data: due } = await supabase.from("reminders")
    .select("id, chat_id, message")
    .eq("status", "PENDING")
    .lte("remind_at", new Date().toISOString())
    .order("remind_at", { ascending: true })
    .limit(50);
  if (!due || due.length === 0) return;

  for (const r of due) {
    await pushToGroup(r.chat_id, `⏰ ${r.message}`);
    await supabase.from("reminders")
      .update({ status: "SENT", sent_at: new Date().toISOString() })
      .eq("id", r.id);
  }
  await supabase.from("audit_logs").insert({
    action: "scheduled_job", tool_name: "due_reminders",
    input: {}, result: { sent: due.length }, status: "OK",
  });
}

// ---------------------------------------------------------------- entry

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("MT Agent scheduled-jobs alive");
  if (!CRON_SECRET || req.headers.get("x-cron-key") !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const { job } = await req.json().catch(() => ({ job: null }));
  try {
    if (job === "daily_summary") await dailySummary();
    else if (job === "morning_reminder") await morningReminder();
    else if (job === "weekly_summary") await weeklySummary();
    else if (job === "due_reminders") await dueReminders();
    else if (job === "extract_events") await extractEvents();
    else return new Response("unknown job", { status: 400 });
    return new Response("OK");
  } catch (e) {
    console.error(`job ${job} failed:`, e);
    return new Response("error", { status: 500 });
  }
});
