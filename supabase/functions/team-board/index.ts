// บอร์ดดูว่าแต่ละคนทำอะไรอยู่ (ฝั่ง API) อ่านอย่างเดียว ทุกคำสั่งเริ่ม ตาม จบงานยังอยู่ในไลน์
//
// หน้าเว็บอยู่ที่ GitHub Pages (web/board.html) เหตุผลเดียวกับ admin-console
// ลิงก์ได้จากแงว เฉพาะ MANAGER ขึ้นไป ส่งเข้าแชทส่วนตัว อ่าน role สดทุกครั้ง ถอดสิทธิ์แล้วลิงก์เดิมใช้ไม่ได้ทันที

import { createClient } from "jsr:@supabase/supabase-js@2";
import { loadTeamWork } from "../_shared/work.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "access-control-allow-origin": "https://korrakottum-code.github.io",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "method" }, 405);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "ลิงก์ไม่ถูกต้อง" }, 401);
  const { data: ticket } = await supabase.from("admin_sessions")
    .select("user_id, expires_at, revoked_at")
    .eq("token_hash", await sha256(token)).eq("kind", "BOARD").maybeSingle();
  if (!ticket || ticket.revoked_at || new Date(ticket.expires_at) < new Date()) {
    return json({ error: "ลิงก์หมดอายุแล้ว ขอใหม่จากแงวได้เลย" }, 401);
  }
  const { data: viewer } = await supabase.from("users")
    .select("display_name, role, is_active").eq("id", ticket.user_id).maybeSingle();
  if (!viewer || !viewer.is_active || !["MANAGER", "ADMIN", "EXECUTIVE"].includes(viewer.role)) {
    return json({ error: "บัญชีนี้ไม่มีสิทธิ์ดูบอร์ด" }, 403);
  }

  const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
  try {
    return json({
      viewer: viewer.display_name,
      generated_at: new Date().toISOString(),
      days: Math.min(30, Math.max(1, days || 7)),
      people: await loadTeamWork(supabase, { days }),
    });
  } catch (e) {
    console.error("team-board failed:", e);
    return json({ error: "โหลดข้อมูลไม่สำเร็จ" }, 500);
  }
});
