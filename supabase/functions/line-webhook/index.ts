// MT Agent 1 — LINE Webhook (Phase 2: ท่อพื้นฐาน)
// รับ event จาก LINE → verify signature → เก็บ message → ตอบกลับเมื่อถูกเรียก @AI
import { createClient } from "jsr:@supabase/supabase-js@2";

const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// LINE เซ็น body ด้วย HMAC-SHA256 (channel secret) ส่งมาใน header x-line-signature
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

async function replyMessage(replyToken: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.error("LINE reply failed:", res.status, await res.text());
}

// จับการเรียก AI: "@AI ..." หรือ mention ชื่อ OA "@MT agent 1"
function isCallingAI(text: string): boolean {
  return /@\s?(ai|mt\s?agent)/i.test(text);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("MT Agent 1 webhook is alive");

  const body = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(body, signature))) {
    return new Response("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);
  for (const event of payload.events ?? []) {
    try {
      if (event.type === "message" && event.message?.type === "text") {
        const text: string = event.message.text;

        const { error } = await supabase.from("messages").insert({
          line_message_id: event.message.id,
          line_user_id: event.source?.userId ?? "unknown",
          line_group_id: event.source?.groupId ?? null,
          message_text: text,
          message_type: "text",
        });
        if (error) console.error("insert message failed:", error.message);

        if (isCallingAI(text) && event.replyToken) {
          await replyMessage(
            event.replyToken,
            "สวัสดีครับ ผม MT Agent 🤖 ระบบเชื่อมต่อสำเร็จแล้ว — ตอนนี้ผมยังตอบได้แค่นี้ สมองกำลังติดตั้งครับ",
          );
        }
      }
    } catch (e) {
      console.error("event handling error:", e);
    }
  }

  // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry ซ้ำ
  return new Response("OK");
});
