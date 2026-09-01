// MT Agent 1 — Scheduled Jobs (MVP 0.2)
// ถูกเรียกโดย pg_cron: daily_summary (18:00 ไทย) และ morning_reminder (09:00 ไทย)
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
  const { data: users } = await supabase.from("users").select("line_user_id, display_name");
  const nameOf = new Map((users ?? []).map((u: any) => [u.line_user_id, u.display_name]));

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
        `สั้น กระชับ ไม่เกิน 12 บรรทัด ข้ามเรื่องหยอกล้อไม่สำคัญ`,
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

    await pushToGroup(g.line_group_id, `🌆 สรุปประจำวัน — ${g.group_name ?? "กลุ่ม"}\n\n${summary}`);
    await supabase.from("audit_logs").insert({
      action: "scheduled_job", tool_name: "daily_summary",
      input: { group: g.line_group_id }, result: { messages: msgs.length }, status: "OK",
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
    else return new Response("unknown job", { status: 400 });
    return new Response("OK");
  } catch (e) {
    console.error(`job ${job} failed:`, e);
    return new Response("error", { status: 500 });
  }
});
