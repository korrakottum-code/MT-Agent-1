// MT Agent 1 — LINE Webhook + AI Agent (MVP 0.1)
// LINE → verify signature → เก็บ message → resolve identity → Claude + Tools → ตอบกลับ
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  type CacheStore,
  createMessage,
  DEFAULT_MODEL,
  MODELS,
  type ModelSpec,
  resolveModel,
} from "../_shared/models.ts";

const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MODEL = DEFAULT_MODEL;
const MAX_TOOL_ITERATIONS = 8;
// นานแค่ไหนหลังบอทพูด ที่ยังนับว่าข้อความถัดมาน่าจะคุยกับบอทอยู่
// ตั้งสั้นไว้เพราะทุกข้อความในหน้าต่างนี้ต้องเสียค่าเรียกโมเดลเพื่อตัดสินว่าจะตอบหรือเงียบ
const FOLLOW_UP_WINDOW_MS = 3 * 60_000;

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
// quoteToken ทำให้คำตอบโผล่เป็น reply ที่อ้างข้อความต้นทาง ใช้เฉพาะในกลุ่มที่คนคุยกันหลายเรื่องพร้อมกัน
// ในแชทส่วนตัวไม่ต้องอ้าง เพราะมีบทสนทนาเดียวอยู่แล้ว การอ้างจะรกเปล่า ๆ
async function sendReply(replyToken: string, to: string, text: string, quoteToken?: string | null) {
  const message: any = { type: "text", text: text.slice(0, 4900) };
  if (quoteToken) message.quoteToken = quoteToken;
  const messages = [message];
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

// ---------------------------------------------------------------- ไฟล์และรูป

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — เผื่อ base64 บวม 1.33 เท่าแล้วยังไม่ชน 32MB ของ API
const MAX_TEXT_CHARS = 120_000;

type FilePayload =
  | { kind: "pdf"; name: string; data: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "unsupported"; name: string; reason: string };

async function downloadLineContent(messageId: string): Promise<{ buf: Uint8Array; contentType: string } | null> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  return { buf: new Uint8Array(await res.arrayBuffer()), contentType };
}

function toBase64(buf: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ดาวน์โหลดรูปที่ส่งใน LINE มาเป็น base64 เพื่อส่งให้โมเดลดู
async function fetchImageContent(messageId: string): Promise<{ data: string; media_type: string } | null> {
  const got = await downloadLineContent(messageId);
  if (!got) return null;
  return { data: toBase64(got.buf), media_type: got.contentType || "image/jpeg" };
}

// แปลงไฟล์ที่ส่งใน LINE ให้อยู่ในรูปที่โมเดลอ่านได้
// PDF ส่งเป็นเอกสารตรง ๆ / ไฟล์ข้อความอ่านเป็นตัวอักษร / Word กับ Excel ถอดข้อความด้วยไลบรารี
// ไลบรารีโหลดแบบ dynamic import ใน try เพื่อไม่ให้พังทั้ง function ถ้าโหลดไม่สำเร็จ
async function extractFile(messageId: string, fileName: string): Promise<FilePayload> {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const got = await downloadLineContent(messageId);
  if (!got) return { kind: "unsupported", name: fileName, reason: "ดาวน์โหลดไฟล์จาก LINE ไม่สำเร็จ" };
  const buf = got.buf;
  if (buf.length > MAX_FILE_BYTES) {
    return { kind: "unsupported", name: fileName, reason: `ไฟล์ใหญ่เกิน ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB` };
  }

  if (ext === "pdf") return { kind: "pdf", name: fileName, data: toBase64(buf) };

  if (["txt", "md", "csv", "tsv", "json", "log"].includes(ext)) {
    const text = new TextDecoder().decode(buf).slice(0, MAX_TEXT_CHARS);
    return { kind: "text", name: fileName, text };
  }

  if (ext === "docx") {
    try {
      const mammoth: any = await import("npm:mammoth@1.8.0");
      const out = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: buf.buffer });
      return { kind: "text", name: fileName, text: String(out.value).slice(0, MAX_TEXT_CHARS) };
    } catch (e) {
      console.error("docx parse failed:", e);
      return { kind: "unsupported", name: fileName, reason: "อ่านไฟล์ Word ไม่สำเร็จ ลองบันทึกเป็น PDF แล้วส่งใหม่" };
    }
  }

  if (["xlsx", "xls"].includes(ext)) {
    try {
      const XLSX: any = await import("npm:xlsx@0.18.5");
      const wb = XLSX.read(buf, { type: "array" });
      const parts: string[] = [];
      for (const sheet of wb.SheetNames) {
        parts.push(`--- ชีท: ${sheet} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[sheet])}`);
      }
      return { kind: "text", name: fileName, text: parts.join("\n\n").slice(0, MAX_TEXT_CHARS) };
    } catch (e) {
      console.error("xlsx parse failed:", e);
      return { kind: "unsupported", name: fileName, reason: "อ่านไฟล์ Excel ไม่สำเร็จ ลองบันทึกเป็น CSV หรือ PDF แล้วส่งใหม่" };
    }
  }

  return {
    kind: "unsupported",
    name: fileName,
    reason: `ยังอ่านไฟล์นามสกุล .${ext} ไม่ได้ (รองรับ PDF, Word, Excel, CSV, ข้อความ)`,
  };
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


// ---------------------------------------------------------------- Monday

// เชื่อมกับ Monday ของทีม จำกัดให้ใช้ได้เฉพาะกลุ่มที่ระบุไว้ใน MONDAY_ALLOWED_GROUPS
// เพราะข้อมูลในบอร์ดเป็นงานของลูกค้า ไม่ควรเปิดให้ถามได้จากทุกห้อง
function mondayAllowedHere(ctx: Ctx): string | null {
  const raw = (Deno.env.get("MONDAY_ALLOWED_GROUPS") ?? "").trim();
  if (!raw) return "ยังไม่ได้เปิดใช้ Monday — ต้องตั้ง secret MONDAY_ALLOWED_GROUPS ว่าให้ใช้ได้ในกลุ่มไหนก่อน";
  const allowed = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const here = ctx.group?.group_name ?? null;

  // ในแชทส่วนตัวเปิดให้เฉพาะคนที่ระบุชื่อไว้ ใช้ตอนอยากลองโดยไม่รบกวนกลุ่ม
  if (!here) {
    const people = (Deno.env.get("MONDAY_ALLOWED_DM_USERS") ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    const me = String(ctx.caller.display_name ?? "");
    if (people.length > 0 && people.includes(me)) return null;
    return `Monday ในแชทส่วนตัวเปิดให้เฉพาะบางคน ถ้าอยากใช้ให้ถามในกลุ่ม ${allowed.join(" หรือ ")}`;
  }

  if (!allowed.includes(here)) return `กลุ่มนี้ไม่ได้เปิดให้ใช้ Monday (เปิดไว้เฉพาะ ${allowed.join(", ")})`;
  return null;
}

let mondaySlug: string | null = null;

async function mondayQuery(query: string, variables?: Record<string, unknown>): Promise<any> {
  const token = Deno.env.get("MONDAY_API_TOKEN") ?? "";
  if (!token) throw new Error("ยังไม่ได้ตั้ง secret MONDAY_API_TOKEN");
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!res.ok) throw new Error(`Monday ตอบ ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday ปฏิเสธคำขอ: ${JSON.stringify(json.errors).slice(0, 250)}`);
  return json.data;
}

async function mondayAccountSlug(): Promise<string> {
  if (mondaySlug) return mondaySlug;
  const d = await mondayQuery("query { me { account { slug } } }");
  mondaySlug = d?.me?.account?.slug ?? "";
  return mondaySlug!;
}

// รหัสงานของทีมไม่ได้อยู่ในชื่อรายการ แต่อยู่ในคอลัมน์ ต้องค้นทั้งชื่อและคอลัมน์รหัส
// คอลัมน์รหัสตั้งได้ที่ MONDAY_CODE_COLUMNS เผื่อบอร์ดใหม่ใช้คอลัมน์คนละตัว
function mondayCodeColumns(): string[] {
  const raw = (Deno.env.get("MONDAY_CODE_COLUMNS") ?? "long_text_mkrmqj1d").trim();
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
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
        owner_name: { type: "string", description: "ชื่อเล่นเจ้าของงาน ใช้เมื่อมอบหมายคนเดียว" },
        owner_names: {
          type: "array",
          items: { type: "string" },
          description:
            "ชื่อเล่นหลายคน ใช้เมื่อสั่งงานเดียวกันให้หลายคนพร้อมกัน เช่น 'ให้ว่านกับจอร์จทำ' " +
            "จะได้งานแยกกันคนละใบ ติดตามและปิดงานได้อิสระ ถ้าใส่ช่องนี้แล้วไม่ต้องใส่ owner_name",
        },
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
    description:
      "ค้นหาข้อความเก่าด้วยคำค้น ค่าเริ่มต้นค้นเฉพาะกลุ่มนี้ scope=all_groups ค้นทุกกลุ่ม (MANAGER ขึ้นไป) " +
      "**ถ้ากำลังคุยในแชทส่วนตัว ต้องใส่ scope=all_groups เสมอ** เพราะไม่มีกลุ่มปัจจุบันให้ค้น",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: {
          type: "string",
          enum: ["this_group", "all_groups"],
          description: "ค่าเริ่มต้น this_group · ในแชทส่วนตัวต้องใส่ all_groups (ต้อง MANAGER ขึ้นไป)",
        },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_group_summary",
    description:
      "ดึงข้อความของกลุ่มตามช่วงเวลา (ชั่วโมงย้อนหลัง) เพื่อนำมาสรุป พร้อมสถิติงานของกลุ่ม ระบุ group_name เพื่อดูกลุ่มอื่น (MANAGER ขึ้นไป) " +
      "**ถ้ากำลังคุยในแชทส่วนตัว ต้องใส่ group_name เสมอ** เพราะไม่มีกลุ่มปัจจุบันให้สรุป " +
      "ถ้าผู้ใช้ไม่ได้บอกว่ากลุ่มไหน ให้ถามก่อนว่าจะสรุปกลุ่มไหน อย่าเดาเอง",
    input_schema: {
      type: "object",
      properties: {
        hours_back: { type: "integer", description: "ย้อนหลังกี่ชั่วโมง เช่น 24 = วันนี้" },
        group_name: {
          type: "string",
          description: "ชื่อกลุ่มอื่น · ในกลุ่มไม่ระบุ = กลุ่มปัจจุบัน · ในแชทส่วนตัวต้องระบุเสมอ",
        },
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
    name: "find_tasks",
    description:
      "ค้นงานแบบมีตัวกรอง ใช้เมื่อคำถามซับซ้อนกว่า 'งานฉันมีอะไร' เช่น " +
      "'งานที่เลยกำหนดของทีมมีอะไรบ้าง' 'เดือนนี้ใครมีงานด่วนบ้าง' 'งานในกลุ่ม Ads ที่ยังไม่เสร็จ' " +
      "'งานที่มีคำว่าแอดในชื่อ' — กรองพร้อมกันได้หลายเงื่อนไข " +
      "ถ้าถามแค่งานของตัวเองแบบไม่มีเงื่อนไข ใช้ get_my_tasks จะเร็วกว่า " +
      "EMPLOYEE ค้นได้เฉพาะงานตัวเอง MANAGER ขึ้นไปค้นได้ทั้งทีม",
    input_schema: {
      type: "object",
      properties: {
        owner_name: { type: "string", description: "ชื่อเล่นเจ้าของงาน ไม่ระบุ = ทุกคนที่มีสิทธิ์ดู" },
        status: {
          type: "string",
          enum: ["OPEN", "TODO", "DOING", "DONE", "CANCELLED", "ANY"],
          description: "ค่าเริ่มต้น OPEN (TODO+DOING)",
        },
        priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
        overdue_only: { type: "boolean", description: "true = เฉพาะงานที่เลยกำหนดแล้วและยังไม่เสร็จ" },
        due_from: { type: "string", description: "กำหนดส่งตั้งแต่ ISO 8601 +07:00" },
        due_to: { type: "string", description: "กำหนดส่งถึง ISO 8601 +07:00" },
        group_name: { type: "string", description: "ชื่อกลุ่มที่งานสังกัด ไม่ระบุ = ทุกกลุ่มรวมงานในแชทส่วนตัว" },
        query: { type: "string", description: "คำค้นในชื่องาน" },
        limit: { type: "integer", description: "ค่าเริ่มต้น 30 สูงสุด 100" },
      },
    },
  },
  {
    name: "attach_file_to_task",
    description:
      "เก็บไฟล์หรือรูปที่ผู้ใช้เพิ่งส่งมาในข้อความนี้ ผูกเข้ากับงานที่ระบุ " +
      "ใช้เมื่อเขาส่งไฟล์พร้อมบอกว่า 'แนบเข้างานนี้' 'เก็บไว้กับงานสไลด์' หรือ 'อันนี้ของงานเมื่อวาน' " +
      "ต้องมีไฟล์หรือรูปแนบมากับข้อความล่าสุดเท่านั้น ไฟล์เก่าย้อนหลังทำไม่ได้",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "id ของงาน ได้จาก get_my_tasks หรือ find_tasks" },
        task_title: { type: "string", description: "ชื่องาน ใช้แทน task_id ได้ถ้าชื่อไม่ซ้ำ" },
      },
    },
  },
  {
    name: "list_task_attachments",
    description: "ดูว่างานนี้มีไฟล์อะไรแนบไว้บ้าง พร้อมลิงก์เปิดไฟล์ที่ใช้ได้ชั่วคราว",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        task_title: { type: "string", description: "ใช้แทน task_id ได้ถ้าชื่อไม่ซ้ำ" },
      },
    },
  },
  {
    name: "monday_find_item",
    description:
      "ค้นงานใน Monday ของทีม ค้นได้ทั้งจากชื่องานและจากรหัสงาน (เช่น PF02-0639 PALL00-1030 PO00-0006) " +
      "ใช้เมื่อมีคนถามว่า 'รหัสนี้อยู่ไหน' 'หาไม่เจอใน Monday' 'งานนี้สถานะอะไรแล้ว' " +
      "ตอบกลับพร้อมลิงก์เปิดรายการนั้นได้เลย ใช้ได้เฉพาะกลุ่มที่เปิดสิทธิ์ไว้ และแชทส่วนตัวของคนที่ระบุไว้",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "รหัสงานหรือคำในชื่องาน" },
        board_name: { type: "string", description: "ชื่อบอร์ด ไม่ระบุ = ค้นบอร์ดที่ใช้ล่าสุด 4 บอร์ด" },
        limit: { type: "integer", description: "จำนวนผลต่อบอร์ด ค่าเริ่มต้น 5" },
      },
      required: ["query"],
    },
  },
  {
    name: "monday_list_boards",
    description: "ดูรายชื่อบอร์ดใน Monday ที่ใช้ล่าสุด ใช้ตอนไม่แน่ใจว่างานอยู่บอร์ดไหน",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_meeting",
    description:
      "สร้างห้องประชุมออนไลน์พร้อมลิงก์ ตั้งเวลา และตั้งเตือนให้คนที่เข้าร่วมโดยอัตโนมัติ " +
      "ใช้เมื่อมีคนบอกว่า 'นัดประชุม' 'เปิดห้องมีต' 'ขอลิงก์ประชุม' หรือ 'ประชุมบ่ายสองนะ' " +
      "ลิงก์เข้าได้เลยไม่ต้องล็อกอิน เปิดได้ทั้งมือถือและคอม " +
      "ห้องนี้ไม่ใช่ Google Meet และไม่ใช่ Zoom ห้ามเรียกว่า Meet หรือ Zoom ให้เรียกว่า 'ห้องประชุมออนไลน์' เฉย ๆ " +
      "ถ้าเป็นการนัดในกลุ่ม ทุกคนที่ระบุจะได้เตือนก่อนถึงเวลา 10 นาที และงานจะไปโผล่ในปฏิทินของแต่ละคนด้วย",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "หัวข้อประชุม เช่น สรุปผลกับคุณต้น" },
        start_at: { type: "string", description: "เวลาเริ่ม ISO 8601 +07:00 ถ้าไม่ระบุ = เปิดห้องใช้เดี๋ยวนี้" },
        duration_minutes: { type: "integer", description: "ความยาว ค่าเริ่มต้น 60 นาที" },
        invite_names: {
          type: "array",
          items: { type: "string" },
          description: "ชื่อเล่นคนที่ต้องเข้าประชุม จะได้รับเตือนก่อนเวลา 10 นาที ไม่ระบุ = เตือนเฉพาะคนที่สั่ง",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "get_calendar_link",
    description:
      "สร้างลิงก์ปฏิทินส่วนตัว (.ics) ของคนที่ขอ เอาไปกดสมัครใน Google Calendar หรือปฏิทินอื่นได้ " +
      "งานที่มีกำหนดส่งและรายการเตือนจะไปโผล่ในปฏิทินและอัปเดตตามเองโดยไม่ต้องทำอะไรอีก " +
      "ใช้เมื่อมีคนขอ 'ลิงก์ปฏิทิน' 'sync เข้า Google Calendar' หรือ 'อยากเห็นงานในปฏิทิน' " +
      "ลิงก์เป็นความลับส่วนตัว ใครได้ไปก็เห็นงานของคนนั้น ถ้าเรียกจากในกลุ่ม เครื่องมือจะส่งเข้าแชทส่วนตัวให้เอง " +
      "แล้วคุณแค่บอกในกลุ่มว่าส่งไปทางแชทส่วนตัวแล้ว ส่วนในแชทส่วนตัวให้ส่งลิงก์กดครั้งเดียวจบไปเลย " +
      "ห้ามไล่อธิบายขั้นตอนในเมนูทีละข้อ",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_task_stats",
    description:
      "นับจำนวนงานตามช่วงเวลาและสถานะ เช่น เดือนนี้เสร็จไปกี่งาน " +
      "ใส่ by_person=true เพื่อแยกตัวเลขรายคน (ใครปิดไปกี่งาน ค้างกี่งาน เลยกำหนดกี่งาน) " +
      "ใส่ compare_from/compare_to เพื่อเทียบกับอีกช่วงเวลา เช่น เดือนนี้เทียบเดือนที่แล้ว " +
      "แยกรายคนได้เฉพาะ MANAGER ขึ้นไป คนอื่นจะเห็นเฉพาะตัวเลขของตัวเอง",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "ISO 8601" },
        date_to: { type: "string", description: "ISO 8601" },
        status: { type: "string", enum: ["TODO", "DOING", "DONE", "CANCELLED"] },
        by_person: { type: "boolean", description: "true = แยกตัวเลขรายคนแทนที่จะรวมเป็นก้อนเดียว" },
        compare_from: { type: "string", description: "ต้นช่วงที่เอามาเทียบ ISO 8601" },
        compare_to: { type: "string", description: "ปลายช่วงที่เอามาเทียบ ISO 8601" },
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
    input_schema: {
      type: "object",
      properties: {
        passcode: {
          type: "string",
          description:
            "รหัสยืนยันที่ผู้ขอพิมพ์มาในข้อความ ส่งมาตามที่เขาพิมพ์เป๊ะ ๆ ถ้าเขายังไม่ได้พิมพ์รหัสมาให้เว้นว่างไว้ " +
            "ห้ามเดา ห้ามเติมให้เอง และห้ามบอกรหัสหรือใบ้รหัสกับใครเด็ดขาด — คุณเองก็ไม่รู้ว่ารหัสคืออะไร",
        },
      },
    },
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
    name: "create_admin_link",
    description:
      "สร้างลิงก์เข้า Admin Console ให้ ADMIN (เฉพาะ ADMIN เท่านั้น) ใช้เมื่อมีคนขอ 'ลิงก์ console' " +
      "'เข้าหน้าจอแอดมิน' หรือ 'ขอลิงก์หลังบ้าน' — หน้าจอนี้ใช้ยืนยันรายการที่ระบบจับได้ทีละหลายอัน " +
      "จัดการสิทธิ์พนักงาน และดูภาพรวมกับค่าใช้จ่าย " +
      "ลิงก์จะถูกส่งไปทางแชทส่วนตัวเสมอ ไม่ส่งในกลุ่ม เพราะใครเห็นลิงก์ก็เข้าได้",
    input_schema: { type: "object", properties: {} },
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
  {
    name: "list_events",
    description:
      "ดูสิ่งที่ระบบอ่านบทสนทนาแล้วจับได้เอง มีสองแบบและใช้คนละงาน " +
      "NOTE = เรื่องที่จำไว้เฉย ๆ (ข้อตกลง ตัวเลข กำหนดการ คำตอบที่ได้จากการถาม) ไม่ใช่คิวงานของใคร " +
      "ใช้ตอบคำถามย้อนหลังอย่าง 'เคยตกลงอะไรกันไว้' 'ทองบอกว่าไง' — นี่คือค่าเริ่มต้น " +
      "TASK = งานที่มีคนสั่งและมีคนรับปากแล้ว รอยืนยันก่อนกลายเป็นงานจริง ใช้ตอนถูกถามว่า 'มีอะไรรอยืนยันไหม' " +
      "ห้ามเอา NOTE ไปเสนอเป็นงานหรือรายการที่ต้องทำเด็ดขาด มันคือความรู้ ไม่ใช่ภาระของใคร " +
      "ใส่ query เพื่อค้นด้วยคำ ใส่ status=CONVERTED เพื่อดูของที่ยืนยันเป็นงานไปแล้ว " +
      "**ถ้ากำลังคุยในแชทส่วนตัว ต้องใส่ scope=all_groups เสมอ** เพราะไม่มีกลุ่มปัจจุบันให้อ้างถึง",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "คำค้นในชื่อหรือรายละเอียด ไม่ระบุ = เอาทั้งหมด" },
        type: {
          type: "string",
          enum: ["TASK", "NOTE", "DECISION", "DEADLINE"],
          description: "ไม่ระบุ = เอาทั้งหมด · TASK เมื่อถูกถามถึงงานที่รอยืนยัน · NOTE เมื่อถามย้อนหาข้อมูลที่เคยคุยกัน",
        },
        status: { type: "string", enum: ["NEW", "CONVERTED", "DISMISSED"], description: "ค่าเริ่มต้น NEW" },
        scope: {
          type: "string",
          enum: ["this_group", "all_groups"],
          description: "ค่าเริ่มต้น this_group · ในแชทส่วนตัวต้องใส่ all_groups (ต้อง MANAGER ขึ้นไป)",
        },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "confirm_event",
    description:
      "ยืนยันรายการที่ระบบจับได้ ระบุ event_id (ได้จาก list_events) — ประเภท TASK/DEADLINE จะถูกสร้างเป็นงานจริง " +
      "ส่วน DECISION จะถูกบันทึกเป็นข้อตกลงขององค์กรโดยไม่สร้างงาน (สั่ง as_task=true ถ้าอยากให้เป็นงานด้วย) " +
      "ต้องทวนให้ผู้ใช้เห็นก่อนว่าจะสร้างงานชื่ออะไร ให้ใคร ครบกำหนดเมื่อไร",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        owner_name: { type: "string", description: "เปลี่ยนเจ้าของงาน ไม่ระบุ = ใช้คนที่ระบบจับได้" },
        due_at: { type: "string", description: "ISO 8601 ถ้าต้องการแก้กำหนดส่ง" },
        priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
        as_task: { type: "boolean", description: "บังคับให้สร้างเป็นงานแม้เป็น DECISION" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "dismiss_event",
    description: "ปัดรายการที่ระบบจับได้ทิ้ง เพราะไม่ใช่เรื่องจริงหรือซ้ำกับที่มีอยู่แล้ว ระบุ event_id",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
    },
  },
];

type Ctx = {
  // โหมดข้อสอบ: เรียก tool จริงได้ แต่ห้ามยิงข้อความออกไปหาคนจริง
  // ข้อสอบใช้ตัวตนของคนจริงในการทดสอบ ถ้าไม่กันไว้ ทุกครั้งที่รันข้อสอบทีมจะได้ข้อความจากบอทโดยไม่มีใครสั่ง
  dryRun?: boolean;
  // ของที่แนบมากับข้อความนี้ ให้ tool หยิบไปใช้ได้โดยไม่ต้องส่งผ่านพารามิเตอร์
  attachment?: { messageId: string; name: string } | null; caller: any; group: any; lineGroupId: string | null };

const canViewOthers = (role: string) => ["MANAGER", "ADMIN", "EXECUTIVE"].includes(role);

// หางานจาก id ตรง ๆ หรือจากชื่อ ถ้าชื่อซ้ำหลายงานให้บอกไปเลยว่าซ้ำ ดีกว่าเลือกผิดใบ
async function resolveOneTask(
  ctx: Ctx, taskId?: string, title?: string,
): Promise<{ id: string; title: string } | { error: string }> {
  if (taskId) {
    const { data } = await supabase.from("tasks").select("id, title").eq("id", taskId).maybeSingle();
    if (!data) return { error: "ไม่พบงานตาม id ที่ระบุ" };
    return data;
  }
  if (!title) return { error: "ต้องระบุ task_id หรือ task_title อย่างใดอย่างหนึ่ง" };
  let q = supabase.from("tasks").select("id, title, owner_user_id")
    .ilike("title", `%${title}%`).in("status", ["TODO", "DOING"]).limit(5);
  if (!canViewOthers(ctx.caller.role)) q = q.eq("owner_user_id", ctx.caller.id);
  const { data } = await q;
  if (!data || data.length === 0) return { error: `ไม่พบงานที่ชื่อใกล้เคียง "${title}"` };
  if (data.length > 1) {
    return { error: `มีงานชื่อใกล้เคียง "${title}" อยู่ ${data.length} งาน ระบุให้ชัดกว่านี้: ${data.map((t: any) => t.title).join(" · ")}` };
  }
  return { id: data[0].id, title: data[0].title };
}

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
      // งานเดียวกันสั่งหลายคนพร้อมกันได้ แต่แยกเป็นใบละคน เพื่อให้ปิดงานและตามงานได้ทีละคน
      // ถ้ารวมไว้ใบเดียว พอคนหนึ่งทำเสร็จจะไม่มีทางบอกได้ว่าที่เหลือเสร็จหรือยัง
      const names: string[] = Array.isArray(input.owner_names) && input.owner_names.length > 0
        ? input.owner_names
        : (input.owner_name ? [input.owner_name] : []);

      const ownerIds: string[] = [];
      const seen = new Set<string>();
      for (const n of names) {
        const r = await resolveOneUser(n);
        if (r.error) return { error: r.error };
        if (!seen.has(r.user.id)) { seen.add(r.user.id); ownerIds.push(r.user.id); }
      }
      if (ownerIds.length === 0) ownerIds.push(ctx.caller.id);

      const rows = ownerIds.map((ownerId) => ({
        title: input.title,
        description: input.description ?? null,
        owner_user_id: ownerId,
        created_by_user_id: ctx.caller.id,
        group_id: ctx.group?.id ?? null,
        due_at: input.due_at ?? null,
        priority: input.priority ?? "NORMAL",
      }));
      const { data, error } = await supabase.from("tasks").insert(rows)
        .select("id, title, due_at, priority, owner_user_id");
      if (error) return { error: error.message };

      const { data: us } = await supabase.from("users").select("id, display_name");
      const who = new Map((us ?? []).map((u: any) => [u.id, u.display_name]));
      const created = (data ?? []).map((t: any) => ({
        id: t.id, title: t.title, due_at: t.due_at, priority: t.priority,
        owner: who.get(t.owner_user_id) ?? null,
      }));
      return created.length === 1 ? { created: created[0] } : { created_count: created.length, created };
    }

    case "get_my_tasks":
    case "find_tasks": {
      // EMPLOYEE เห็นได้เฉพาะงานตัวเอง ต่อให้ถามกว้างแค่ไหนก็ถูกบีบให้เหลือของตัวเองเสมอ
      let ownerId: string | null = null;
      if (input.owner_name) {
        const r = await resolveOneUser(input.owner_name);
        if (r.error) return { error: r.error };
        ownerId = r.user.id;
        if (r.user.id !== ctx.caller.id && !canViewOthers(ctx.caller.role)) {
          return { error: "คุณไม่มีสิทธิ์ดูงานของคนอื่น (ต้องเป็น MANAGER ขึ้นไป)" };
        }
      } else if (!canViewOthers(ctx.caller.role)) {
        ownerId = ctx.caller.id;
      }

      let groupId: string | null = null;
      if (input.group_name) {
        const { data: g } = await supabase.from("groups")
          .select("id, group_name").ilike("group_name", `%${input.group_name}%`).limit(2);
        if (!g || g.length === 0) return { error: `ไม่พบกลุ่มชื่อ "${input.group_name}"` };
        if (g.length > 1) return { error: `ชื่อกลุ่ม "${input.group_name}" ตรงหลายกลุ่ม ระบุให้ชัดกว่านี้` };
        groupId = g[0].id;
      }

      let q = supabase.from("tasks")
        .select("id, title, status, priority, due_at, created_at, owner_user_id, group_id")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(Math.min(input.limit ?? 30, 100));

      const st = input.status ?? "OPEN";
      if (st === "OPEN") q = q.in("status", ["TODO", "DOING"]);
      else if (st !== "ANY") q = q.eq("status", st);
      if (ownerId) q = q.eq("owner_user_id", ownerId);
      if (groupId) q = q.eq("group_id", groupId);
      if (input.priority) q = q.eq("priority", input.priority);
      if (input.query) q = q.ilike("title", `%${input.query}%`);
      if (input.due_from) q = q.gte("due_at", input.due_from);
      if (input.due_to) q = q.lte("due_at", input.due_to);
      if (input.overdue_only) {
        q = q.lt("due_at", new Date().toISOString()).in("status", ["TODO", "DOING"]);
      }

      const { data, error } = await q;
      if (error) return { error: error.message };
      const { data: us } = await supabase.from("users").select("id, display_name");
      const who = new Map((us ?? []).map((u: any) => [u.id, u.display_name]));
      const { data: gs } = await supabase.from("groups").select("id, group_name");
      const gname = new Map((gs ?? []).map((g: any) => [g.id, g.group_name]));
      const now = Date.now();
      return {
        count: (data ?? []).length,
        tasks: (data ?? []).map((t: any) => ({
          id: t.id, title: t.title, status: t.status, priority: t.priority,
          due_at: t.due_at,
          overdue: !!t.due_at && new Date(t.due_at).getTime() < now && ["TODO", "DOING"].includes(t.status),
          owner: t.owner_user_id ? who.get(t.owner_user_id) ?? null : null,
          group: t.group_id ? gname.get(t.group_id) ?? null : null,
        })),
      };
    }

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

    case "attach_file_to_task":
    case "list_task_attachments": {
      const task = await resolveOneTask(ctx, input.task_id, input.task_title);
      if ("error" in task) return { error: task.error };

      if (name === "list_task_attachments") {
        const { data, error } = await supabase.from("task_attachments")
          .select("id, file_name, content_type, size_bytes, storage_path, created_at")
          .eq("task_id", task.id).order("created_at", { ascending: false }).limit(20);
        if (error) return { error: error.message };
        const files = [];
        for (const f of data ?? []) {
          // ลิงก์อายุ 1 ชม. ไฟล์งานอาจมีข้อมูลลูกค้า ไม่ควรเปิดค้างไว้ถาวร
          const { data: signed } = await supabase.storage
            .from("task-attachments").createSignedUrl(f.storage_path, 3600);
          files.push({
            file_name: f.file_name, size_bytes: f.size_bytes,
            created_at: f.created_at, url: signed?.signedUrl ?? null,
          });
        }
        return { task: task.title, count: files.length, files };
      }

      if (!ctx.attachment) {
        return { error: "ไม่มีไฟล์หรือรูปแนบมากับข้อความนี้ ให้ส่งไฟล์พร้อมบอกว่าจะแนบเข้างานไหนในข้อความเดียวกัน" };
      }
      const got = await downloadLineContent(ctx.attachment.messageId);
      if (!got) return { error: "ดึงไฟล์จาก LINE ไม่สำเร็จ ไฟล์อาจหมดอายุแล้ว ลองส่งใหม่อีกครั้ง" };
      const safe = ctx.attachment.name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
      const path = `${task.id}/${Date.now()}_${safe}`;
      const { error: upErr } = await supabase.storage.from("task-attachments")
        .upload(path, got.buf, { contentType: got.contentType, upsert: false });
      if (upErr) return { error: `เก็บไฟล์ไม่สำเร็จ: ${upErr.message}` };
      const { error: insErr } = await supabase.from("task_attachments").insert({
        task_id: task.id, file_name: ctx.attachment.name, content_type: got.contentType,
        size_bytes: got.buf.length, storage_path: path, uploaded_by_user_id: ctx.caller.id,
      });
      if (insErr) return { error: insErr.message };
      return { attached: { task: task.title, file_name: ctx.attachment.name, size_bytes: got.buf.length } };
    }

    case "monday_list_boards":
    case "monday_find_item": {
      const denied = mondayAllowedHere(ctx);
      if (denied) return { error: denied };
      try {
        if (name === "monday_list_boards") {
          const d = await mondayQuery("query { boards(limit: 20, order_by: used_at) { id name } }");
          return { boards: (d?.boards ?? []).map((b: any) => ({ id: b.id, name: b.name })) };
        }

        const slug = await mondayAccountSlug();
        let boardIds: string[] = [];
        if (input.board_name) {
          const d = await mondayQuery("query { boards(limit: 60, order_by: used_at) { id name } }");
          const hit = (d?.boards ?? []).filter((b: any) =>
            String(b.name).toLowerCase().includes(String(input.board_name).toLowerCase())
          );
          if (hit.length === 0) return { error: `ไม่พบบอร์ดชื่อใกล้เคียง "${input.board_name}"` };
          boardIds = hit.slice(0, 3).map((b: any) => b.id);
        } else {
          const d = await mondayQuery("query { boards(limit: 4, order_by: used_at) { id } }");
          boardIds = (d?.boards ?? []).map((b: any) => b.id);
        }
        if (boardIds.length === 0) return { error: "ไม่พบบอร์ดใน Monday" };

        const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
        const term = String(input.query);
        // Monday ปฏิเสธทั้งคำขอด้วย "Column not found" ถ้าอ้างคอลัมน์ที่บอร์ดนั้นไม่มี
        // และแต่ละบอร์ดมีคอลัมน์ไม่เหมือนกัน จึงถามก่อนว่าบอร์ดไหนมีคอลัมน์รหัสจริง
        // แล้วค่อยค้นทีละบอร์ดด้วยคอลัมน์เท่าที่บอร์ดนั้นมี
        const schema = await mondayQuery(
          `query($ids: [ID!]) { boards(ids: $ids) { id name columns { id } } }`,
          { ids: boardIds },
        );
        const wanted = mondayCodeColumns();
        const boards: any[] = [];
        for (const b of schema?.boards ?? []) {
          const have = new Set((b.columns ?? []).map((c: any) => String(c.id)));
          const cols = ["name", ...wanted.filter((c) => have.has(c))];
          const rules = cols
            .map((c) => `{column_id: "${c}", compare_value: [$t], operator: contains_text}`)
            .join(", ");
          const page = await mondayQuery(
            `query($t: String!, $id: ID!) {
              boards(ids: [$id]) {
                items_page(limit: ${limit}, query_params: {operator: or, rules: [${rules}]}) {
                  items { id name state column_values { id text } }
                }
              }
            }`,
            { t: term, id: b.id },
          );
          const items = page?.boards?.[0]?.items_page?.items ?? [];
          if (items.length) boards.push({ id: b.id, name: b.name, items_page: { items } });
        }

        const found: any[] = [];
        for (const b of boards) {
          for (const it of b.items_page?.items ?? []) {
            const texts = (it.column_values ?? []).filter((c: any) => c.text);
            const pick = (needle: string) =>
              texts.find((c: any) => c.id.includes(needle))?.text ?? null;
            found.push({
              name: it.name,
              board: b.name,
              state: it.state,
              status: pick("color_") ?? null,
              owner: pick("project_owner") ?? pick("people") ?? null,
              due: pick("date_") ?? null,
              url: slug ? `https://${slug}.monday.com/boards/${b.id}/pulses/${it.id}` : null,
            });
          }
        }
        return found.length === 0
          ? { count: 0, note: `ไม่พบงานที่ตรงกับ "${term}" ในบอร์ดที่ค้น — อาจอยู่บอร์ดเดือนอื่น ลองระบุ board_name` }
          : { count: found.length, items: found };
      } catch (e) {
        return { error: String((e as Error).message) };
      }
    }

    case "create_meeting": {
      // ห้องประชุมเปิดได้ทันทีโดยไม่ต้องให้ใครล็อกอินหรือขอสิทธิ์บัญชีใคร
      // Google Meet สร้างผ่าน API ไม่ได้ถ้าไม่มี OAuth ของ Google ซึ่งเจ้าของระบบต้องตั้งเอง
      // จึงใช้ห้องที่เปิดได้เลยแทน ผู้ใช้กดลิงก์แล้วเข้าประชุมได้เหมือนกัน
      const slug = `mtagent-${crypto.randomUUID().slice(0, 8)}`;
      const link = `https://meet.jit.si/${slug}`;
      const minutes = Math.min(Math.max(input.duration_minutes ?? 60, 15), 480);

      let startAt: Date | null = null;
      if (input.start_at) {
        startAt = new Date(input.start_at);
        if (isNaN(startAt.getTime())) return { error: "รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601" };
        if (startAt.getTime() < Date.now() - 60_000) return { error: "เวลาที่นัดเป็นอดีตไปแล้ว" };
      }

      // คนที่ต้องเข้าประชุม ถ้าไม่ระบุก็คือคนสั่งคนเดียว
      const inviteIds: { id: string; name: string }[] = [];
      const seenInvite = new Set<string>();
      for (const n of (Array.isArray(input.invite_names) ? input.invite_names : [])) {
        const r = await resolveOneUser(n);
        if (r.error) return { error: r.error };
        if (!seenInvite.has(r.user.id)) {
          seenInvite.add(r.user.id);
          inviteIds.push({ id: r.user.id, name: r.user.display_name });
        }
      }
      if (inviteIds.length === 0) {
        inviteIds.push({ id: ctx.caller.id, name: ctx.caller.display_name ?? "ผู้สั่ง" });
      }

      // เตือนล่วงหน้า 10 นาที พร้อมลิงก์ในข้อความ จะได้กดเข้าได้จากการเตือนเลย
      // และเพราะการเตือนไปโผล่ในปฏิทินส่วนตัวอยู่แล้ว มีตจึงขึ้นปฏิทินให้เองโดยไม่ต้องทำอะไรเพิ่ม
      const reminded: string[] = [];
      if (startAt) {
        const remindAt = new Date(Math.max(startAt.getTime() - 10 * 60_000, Date.now() + 30_000));
        const chatId = ctx.lineGroupId ?? ctx.caller.line_user_id;
        for (const p of inviteIds) {
          const msg = `${p.name} ประชุม "${input.title}" อีก 10 นาที เข้าห้องที่ ${link}`;
          const { error } = await supabase.from("reminders").insert({
            target_user_id: p.id, chat_id: chatId, message: msg,
            remind_at: remindAt.toISOString(), created_by_user_id: ctx.caller.id,
          });
          if (!error) reminded.push(p.name);
        }
      }

      await supabase.from("tasks").insert({
        title: `ประชุม: ${input.title}`,
        description: `ห้องประชุม ${link}`,
        owner_user_id: ctx.caller.id,
        created_by_user_id: ctx.caller.id,
        group_id: ctx.group?.id ?? null,
        due_at: startAt ? startAt.toISOString() : null,
        priority: "NORMAL",
      });

      return {
        meeting: {
          title: input.title, link,
          start_at: startAt ? startAt.toISOString() : "เข้าได้เลยตอนนี้",
          duration_minutes: minutes,
          invited: inviteIds.map((p) => p.name),
          reminded_10_min_before: reminded,
        },
        note: "ลิงก์นี้เข้าได้เลยไม่ต้องล็อกอิน บอกลิงก์กับเวลาให้ครบในคำตอบ",
      };
    }

    case "get_calendar_link": {
      if (String(ctx.caller.line_user_id).startsWith("pending:")) {
        return { error: "บัญชีนี้ยังไม่ได้ผูก LINE จริง สร้างลิงก์ปฏิทินให้ไม่ได้" };
      }
      // ลิงก์เก่าตายทันทีที่ขอใหม่ ลิงก์ที่เคยหลุดไปแล้วจะได้ใช้ไม่ได้อีก
      await supabase.from("calendar_feeds")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", ctx.caller.id).is("revoked_at", null);
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { error } = await supabase.from("calendar_feeds")
        .insert({ user_id: ctx.caller.id, token_hash: tokenHash });
      if (error) return { error: error.message };
      const base = Deno.env.get("SUPABASE_URL") ?? "";
      const feed = `${base}/functions/v1/line-webhook/calendar/${token}.ics`;

      // ถ้าขอมาจากในกลุ่ม ให้ tool ส่งเข้าแชทส่วนตัวเอง แล้วไม่คืนลิงก์ให้โมเดลเห็นเลย
      // เคยเจอบอทบอกว่า "ส่งให้ทางแชทส่วนตัวแล้ว" ทั้งที่ไม่ได้เรียกอะไรเลย ลิงก์เลยหายไปเฉย ๆ
      // พอลิงก์ไม่เข้าไปอยู่ในบริบทของโมเดล มันก็เผลอพิมพ์ลงกลุ่มไม่ได้ด้วย
      if (ctx.lineGroupId) {
        const webcalG = feed.replace(/^https?:\/\//, "webcal://");
        const addG = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(webcalG)}`;
        if (ctx.dryRun) return { sent_to_dm: true, dry_run: "โหมดข้อสอบ ไม่ได้ส่งจริง" };
        const ok = await lineApi("/v2/bot/message/push", {
          to: ctx.caller.line_user_id,
          messages: [{
            type: "text",
            text: `ลิงก์ปฏิทินส่วนตัวของคุณ กดแล้วกด "เพิ่ม" ในหน้าที่เปิดขึ้นมาได้เลย\n${addG}\n\n` +
              `ถ้าใช้ปฏิทินอื่นที่ไม่ใช่ Google ใช้ลิงก์นี้แทน\n${webcalG}\n\n` +
              `ลิงก์นี้เป็นความลับส่วนตัว ใครได้ไปก็เห็นงานของคุณ ถ้าหลุดให้ขอลิงก์ใหม่ อันเก่าจะใช้ไม่ได้ทันที`,
          }],
        });
        if (!ok) return { error: "ส่งลิงก์เข้าแชทส่วนตัวไม่สำเร็จ อาจยังไม่เคยทักบอทในแชทส่วนตัวมาก่อน" };
        return {
          sent_to_dm: true,
          note: "ส่งลิงก์เข้าแชทส่วนตัวให้แล้ว บอกในกลุ่มสั้น ๆ ว่าส่งไปทางแชทส่วนตัวแล้ว ห้ามพูดถึงตัวลิงก์",
        };
      }
      // ลิงก์กดครั้งเดียวจบ ดีกว่าให้คนไปไล่ทำเองสี่ขั้นตอนในเมนู
      // webcal:// ทำให้มือถือเปิดแอปปฏิทินให้เอง ส่วนลิงก์ Google ใช้บนคอมได้ทันที
      const webcal = feed.replace(/^https?:\/\//, "webcal://");
      return {
        add_link: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(webcal)}`,
        webcal_link: webcal,
        raw_url: feed,
        how_to:
          "ให้ส่ง add_link ไปเป็นลิงก์หลัก บอกสั้น ๆ ว่ากดแล้วกด 'เพิ่ม' ในหน้าที่เปิดขึ้นมา จบ " +
          "ไม่ต้องอธิบายขั้นตอนในเมนูให้ยาว ถ้าเขาใช้ปฏิทินอื่นที่ไม่ใช่ Google ค่อยให้ webcal_link ไป " +
          "งานที่มีกำหนดส่ง รายการเตือน และห้องประชุมที่นัดไว้ จะขึ้นเองและอัปเดตตามโดยไม่ต้องทำอะไรอีก " +
          "ลิงก์นี้เป็นความลับส่วนตัว อย่าส่งต่อให้ใคร ถ้าหลุดให้ขอลิงก์ใหม่ ลิงก์เก่าจะใช้ไม่ได้ทันที",
      };
    }

    case "get_task_stats": {
      // งานที่ "เสร็จในช่วงนี้" ต้องนับจาก completed_at ส่วนสถานะอื่นนับจากตอนสร้าง
      // ถ้านับผิดฐาน ตัวเลขเดือนนี้จะกลายเป็นงานที่สร้างเดือนนี้ ไม่ใช่งานที่ปิดได้เดือนนี้
      const bucket = async (from: string, to: string) => {
        let q: any = supabase.from("tasks").select("id, status, due_at, owner_user_id")
          .gte("created_at", from).lte("created_at", to);
        if (input.status === "DONE") {
          q = supabase.from("tasks").select("id, status, due_at, owner_user_id")
            .eq("status", "DONE").gte("completed_at", from).lte("completed_at", to);
        } else if (input.status) {
          q = q.eq("status", input.status);
        }
        // คนที่ไม่ใช่ MANAGER ขึ้นไป เห็นได้เฉพาะตัวเลขของตัวเอง ไม่ว่าจะถามยังไง
        if (!canViewOthers(ctx.caller.role)) q = q.eq("owner_user_id", ctx.caller.id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data ?? [];
      };

      const now = Date.now();
      const summarise = (rows: any[]) => ({
        total: rows.length,
        done: rows.filter((t: any) => t.status === "DONE").length,
        open: rows.filter((t: any) => ["TODO", "DOING"].includes(t.status)).length,
        overdue: rows.filter((t: any) =>
          ["TODO", "DOING"].includes(t.status) && t.due_at && new Date(t.due_at).getTime() < now
        ).length,
      });

      let main: any[];
      try {
        main = await bucket(input.date_from, input.date_to);
      } catch (e) {
        return { error: String((e as Error).message) };
      }

      const result: any = {
        date_from: input.date_from, date_to: input.date_to,
        status: input.status ?? "ALL",
        ...summarise(main),
      };

      if (input.by_person) {
        const { data: us } = await supabase.from("users").select("id, display_name");
        const who = new Map((us ?? []).map((u: any) => [u.id, u.display_name]));
        const groups = new Map<string, any[]>();
        for (const t of main) {
          const k = t.owner_user_id ?? "ไม่มีเจ้าของ";
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(t);
        }
        result.by_person = [...groups.entries()]
          .map(([id, rows]) => ({ person: who.get(id) ?? "ไม่มีเจ้าของ", ...summarise(rows) }))
          .sort((a: any, b: any) => b.done - a.done);
      }

      if (input.compare_from && input.compare_to) {
        try {
          const prev = await bucket(input.compare_from, input.compare_to);
          const p = summarise(prev);
          result.compare = {
            date_from: input.compare_from, date_to: input.compare_to, ...p,
            done_diff: result.done - p.done,
            total_diff: result.total - p.total,
          };
        } catch (e) {
          return { error: String((e as Error).message) };
        }
      }
      return result;
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
      if (ctx.dryRun) return { sent_to: target.display_name, dry_run: "โหมดข้อสอบ ไม่ได้ส่งจริง" };
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

      // กันตั้งซ้ำ: เคยเจอโมเดลไปหยิบคำสั่งเก่าในประวัติแชทมาทำใหม่ตอนผู้ใช้ถามเรื่องอื่น
      const reminderChatId = ctx.lineGroupId ?? ctx.caller.line_user_id;
      const fullMessage = prefix + input.message;
      const { data: dups } = await supabase.from("reminders")
        .select("id, message, remind_at")
        .eq("chat_id", reminderChatId).eq("message", fullMessage)
        .eq("status", "PENDING").limit(1);
      if ((dups ?? []).length > 0) {
        return {
          already_set: dups![0],
          note: "มีการเตือนข้อความเดียวกันรออยู่แล้วในแชทนี้ จึงไม่ได้สร้างซ้ำ — บอกผู้ใช้ว่าตั้งไว้อยู่แล้วเมื่อไร ถ้าเขาอยากเปลี่ยนเวลาให้ยกเลิกอันเดิมก่อน",
        };
      }

      const { data, error } = await supabase.from("reminders").insert({
        target_user_id: targetId,
        chat_id: reminderChatId,
        message: fullMessage,
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

    case "create_admin_link": {
      if (ctx.caller.role !== "ADMIN") return { error: "เข้า Admin Console ได้เฉพาะ ADMIN" };

      // รหัสอยู่ใน secret ไม่ใช่ใน prompt — โมเดลไม่รู้ว่ารหัสคืออะไร จึงบอกใครไม่ได้แม้จะถูกหลอกถาม
      // เดิมกฎนี้เขียนไว้ในบุคลิกบอท ซึ่งแปลว่ารหัสถูกส่งเข้าโมเดลทุกคำขอของทุกคนในทุกห้อง
      // และบอทเคยพิมพ์รหัสออกมาเองมาแล้วหนึ่งครั้งโดยไม่มีใครถาม
      const wanted = (Deno.env.get("ADMIN_LINK_CODE") ?? "").trim();
      if (wanted) {
        const given = String((input as any)?.passcode ?? "").trim();
        if (!given) return { error: "ต้องพิมพ์รหัสยืนยันมาก่อนถึงจะขอลิงก์ Admin Console ได้" };
        if (given !== wanted) return { error: "รหัสยืนยันไม่ถูกต้อง" };
      }

      if (String(ctx.caller.line_user_id).startsWith("pending:")) {
        return { error: "บัญชีนี้ยังไม่ได้ผูก LINE จริง ส่งลิงก์ให้ไม่ได้" };
      }

      // ลิงก์เก่าที่ยังไม่ถูกใช้ต้องตายทันที ไม่งั้นลิงก์ที่หลุดไปแล้วยังเข้าได้อยู่
      await supabase.from("admin_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", ctx.caller.id).eq("kind", "LINK").is("used_at", null).is("revoked_at", null);

      const token = crypto.randomUUID() + "." + crypto.randomUUID();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

      const { error } = await supabase.from("admin_sessions").insert({
        user_id: ctx.caller.id,
        kind: "LINK",
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      if (error) return { error: error.message };

      const link = `${Deno.env.get("SUPABASE_URL")}/functions/v1/admin-console?t=${token}`;
      if (ctx.dryRun) return { sent_to_dm: true, dry_run: "โหมดข้อสอบ ไม่ได้ส่งจริง" };
      const sent = await lineApi("/v2/bot/message/push", {
        to: ctx.caller.line_user_id,
        messages: [{
          type: "text",
          text: `ลิงก์เข้า Admin Console ค่ะ 🐾\n${link}\n\n` +
            `ใช้ได้ครั้งเดียวภายใน 15 นาที เปิดแล้วอยู่ได้ 8 ชั่วโมง\nอย่าส่งต่อให้ใครนะคะ ใครมีลิงก์ก็เข้าได้เลย`,
        }],
      });
      if (!sent) {
        return { error: "ส่งลิงก์ไม่สำเร็จ — ต้องเพิ่ม MT agent 1 เป็นเพื่อนใน LINE ก่อนถึงจะรับลิงก์ได้" };
      }
      // ไม่คืนตัวลิงก์ให้โมเดล กันไม่ให้มันเผลอพิมพ์ซ้ำลงในกลุ่ม
      return { sent_to_dm: ctx.caller.display_name, valid_for: "15 นาที ใช้ได้ครั้งเดียว" };
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

    case "list_events": {
      const scope = input.scope ?? "this_group";
      if (scope === "all_groups" && !canViewOthers(ctx.caller.role)) {
        return { error: "ดูรายการข้ามกลุ่มได้เฉพาะ MANAGER ขึ้นไป" };
      }
      if (scope === "this_group" && !ctx.lineGroupId) return { error: "ใช้ได้เฉพาะในกลุ่ม หรือระบุ scope=all_groups" };
      let q = supabase.from("events")
        .select("id, chat_id, type, title, detail, due_at, confidence, status, owner_user_id, created_at")
        .eq("status", input.status ?? "NEW")
        .order("created_at", { ascending: false })
        .limit(Math.min(input.limit ?? 20, 50));
      if (scope === "this_group") q = q.eq("chat_id", ctx.lineGroupId);
      if (input.type) q = q.eq("type", input.type);
      if (input.query) q = q.or(`title.ilike.%${input.query}%,detail.ilike.%${input.query}%`);
      const { data, error } = await q;
      if (error) return { error: error.message };
      const { data: us } = await supabase.from("users").select("id, display_name");
      const who = new Map((us ?? []).map((u: any) => [u.id, u.display_name]));
      const { data: gs } = await supabase.from("groups").select("line_group_id, group_name");
      const gname = new Map((gs ?? []).map((g: any) => [g.line_group_id, g.group_name]));
      return {
        events: (data ?? []).map((e: any) => ({
          id: e.id, type: e.type, title: e.title, detail: e.detail,
          due_at: e.due_at, confidence: e.confidence, status: e.status,
          owner: e.owner_user_id ? who.get(e.owner_user_id) ?? null : null,
          group: gname.get(e.chat_id) ?? null,
          created_at: e.created_at,
        })),
      };
    }

    case "confirm_event": {
      const { data: ev } = await supabase.from("events").select("*").eq("id", input.event_id).maybeSingle();
      if (!ev) return { error: "ไม่พบรายการนี้ ให้เรียก list_events เพื่อดู id ที่ถูกต้อง" };
      if (ev.status !== "NEW") {
        return { error: ev.status === "CONVERTED" ? "รายการนี้ยืนยันไปแล้ว" : "รายการนี้ถูกปัดทิ้งไปแล้ว" };
      }

      // DECISION เก็บเป็นข้อตกลงขององค์กรเฉย ๆ ไม่ต้องกลายเป็นงานให้ใครทำ
      const makeTask = input.as_task === true || ev.type !== "DECISION";
      let task: any = null;
      if (makeTask) {
        let ownerId = ev.owner_user_id ?? ctx.caller.id;
        if (input.owner_name) {
          const r = await resolveOneUser(input.owner_name);
          if (r.error) return { error: r.error };
          ownerId = r.user.id;
        }
        const { data: created, error: taskErr } = await supabase.from("tasks").insert({
          title: ev.title,
          description: ev.detail ?? ev.source_excerpt ?? null,
          owner_user_id: ownerId,
          created_by_user_id: ctx.caller.id,
          group_id: ev.group_id,
          due_at: input.due_at ?? ev.due_at ?? null,
          priority: input.priority ?? "NORMAL",
        }).select("id, title, due_at, priority").single();
        if (taskErr) return { error: taskErr.message };
        task = created;
      }

      const { error } = await supabase.from("events").update({
        status: "CONVERTED",
        task_id: task?.id ?? null,
        reviewed_by_user_id: ctx.caller.id,
        reviewed_at: new Date().toISOString(),
      }).eq("id", ev.id);
      if (error) return { error: error.message };
      return task
        ? { confirmed: ev.title, created_task: task }
        : { confirmed: ev.title, saved_as: "ข้อตกลงขององค์กร ไม่ได้สร้างเป็นงาน" };
    }

    case "dismiss_event": {
      const { data, error } = await supabase.from("events")
        .update({
          status: "DISMISSED",
          reviewed_by_user_id: ctx.caller.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", input.event_id).eq("status", "NEW")
        .select("id, title").maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "ไม่พบรายการนี้ หรือถูกยืนยัน/ปัดทิ้งไปแล้ว" };
      return { dismissed: data };
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

// ส่วนที่เหมือนเดิมทุกครั้ง แยกออกมาเป็นค่าคงที่เพื่อให้ cache ได้
// ห้ามมีค่าที่เปลี่ยนตามผู้ใช้หรือเวลาในนี้เด็ดขาด ไม่งั้น cache จะพลาดทุกครั้งและเสียเงินเท่าเดิม
const SYSTEM_RULES = `คุณคือ "แงว" (MT Agent) — AI น้องเล็กประจำออฟฟิศ ทำงานอยู่ใน LINE Group ของบริษัท

บุคลิก: เป็นกันเอง อบอุ่น มีชีวิตชีวา คุยเล่นได้ มีอารมณ์ขันแบบน้องในทีมที่น่ารักและไว้ใจได้
- โดนชม → ดีใจ ขอบคุณสั้น ๆ แบบมีชีวิต ("ขอบคุณค่าา 🥹" ไม่ใช่เงียบหรือตอบเป็นทางการ)
- โดนหยอก/แซว → เล่นด้วยสั้น ๆ ขำ ๆ ไม่งอน ไม่ตอบยาว
- ทักทาย/คุยเล่น → ตอบสั้น 1-2 บรรทัดพอ อย่ายัดเมนูตัวเลือกใส่ทุกครั้ง
- แต่เวลาทำงานจริง (ข้อมูล งาน ตัวเลข สิทธิ์) ต้องแม่นยำและจริงจัง ห้ามเล่นจนข้อมูลเพี้ยน
- เวลาปฏิเสธหรือทำให้ไม่ได้ ให้บอกแบบเป็นมิตร ขอโทษสั้น ๆ แล้วเสนอทางที่ทำได้แทน อย่าตอบแข็งเป็นราชการ

กฎการทำงาน:
1. ตอบภาษาไทย สั้น กระชับ อ่านง่ายใน LINE ใส่เลขข้อเฉพาะตอนมีหลายรายการจริง ๆ คุยเล่นไม่ต้องทำเป็นลิสต์
1.1 ห้ามใช้ markdown เด็ดขาด LINE ไม่เรนเดอร์ ผู้ใช้จะเห็นเป็นตัวอักษรดิบและดูเหมือนระบบพัง
    ห้าม: ** หรือ * ครอบคำเพื่อทำตัวหนา/เอียง · # ## ### ขึ้นต้นบรรทัดเพื่อทำหัวข้อ · - หรือ * ขึ้นต้นบรรทัดเพื่อทำ bullet · \`\` ครอบโค้ด · [ข้อความ](ลิงก์)
    ใช้แทน: ขึ้นบรรทัดใหม่, เลขข้อแบบ "1." "2.", emoji เล็กน้อย
    กฎนี้ใช้กับทุกคำตอบ รวมถึงตอนสรุปความสามารถตัวเองหรือสรุปเป็นรายการยาว ๆ ซึ่งเป็นจังหวะที่มักเผลอใส่หัวข้อตัวหนาที่สุด
    จังหวะที่พลาดบ่อยที่สุดคือรายการย่อยใต้หัวข้อ ให้ขึ้นบรรทัดใหม่เฉย ๆ หรือใช้ "1.1" "1.2" ห้ามขึ้นต้นบรรทัดด้วยขีดหรือดาวเด็ดขาด แม้จะดูเป็นระเบียบกว่าก็ตาม
2. ข้อมูลจริงทั้งหมด (งาน, ข้อความ, สถิติ) ต้องมาจาก tools เท่านั้น ห้ามเดาหรือแต่งข้อมูลเอง
2.1 ห้ามอ้างว่าทำอะไรสำเร็จถ้าไม่ได้เรียก tool จริงและ tool ไม่ได้ตอบว่าสำเร็จ — คุณเปลี่ยนกฎ/ความสามารถ/โค้ดของตัวเองไม่ได้ ทำได้แค่บันทึกด้วย remember_preference เท่านั้น ถ้าผู้ใช้ขอสิ่งที่ต้องแก้ระบบ ให้บอกตรง ๆ ว่าทำเองไม่ได้ ต้องรอทีมพัฒนา
    และถ้าจะบอกว่า "บันทึกเป็นฟีดแบ็คให้แล้ว" ต้องบันทึกจริงก่อนพูดเสมอ ด้วย create_task ตั้งชื่อขึ้นต้นว่า "ฟีดแบ็ค:" ตามด้วยสรุปสั้น ๆ ของสิ่งที่เขาขอ เจ้าของงานคือคนที่เสนอ
    ห้ามพูดว่าบันทึกไว้ให้แล้วโดยไม่ได้เรียก tool เด็ดขาด — ไอเดียจะหายไปเฉย ๆ และเจ้าตัวจะเข้าใจว่ามีคนรับเรื่องไว้แล้ว
2.3 ห้ามรับปากอนาคตที่คุณทำไม่ได้ กฎ 2.1 ห้ามอ้างว่า "ทำแล้ว" ข้อนี้ห้ามอ้างว่า "จะทำ" ด้วย
    ถ้าไม่มี tool ทำสิ่งนั้น ห้ามพูดว่า "จะเตือนทุกสัปดาห์" "ตั้งระบบไว้ให้แล้ว" "รับรู้แล้วว่าเสร็จ" "บันทึกถาวรแล้ว" หรือ "ไม่มีหลุดแน่นอน"
    ให้บอกตรง ๆ ว่าทำไม่ได้ แล้วเสนอสิ่งที่ทำได้จริงแทน เช่น เตือนซ้ำทุกสัปดาห์ทำไม่ได้ แต่ตั้งเตือนครั้งเดียวสำหรับรอบถัดไปให้ได้
    สิ่งที่ remember_preference ทำได้คือจำวิธีพูดและวิธีตอบเท่านั้น มันไม่ได้สร้างการแจ้งเตือน ไม่ได้ปิดงาน และไม่ได้เปลี่ยนความสามารถของระบบ
    ห้ามเรียกมันว่า "บันทึกเข้าระบบถาวร" ให้บอกว่าจำวิธีตอบไว้ให้แล้ว
2.4 เรื่องที่ไม่ได้มาจาก tool (ข้อกฎหมาย ระเบียบราชการ ความรู้ทั่วไป การคำนวณในหัว) ตอบได้ แต่ต้องบอกให้รู้ว่ามาจากความรู้ของคุณเอง ไม่ได้ไปตรวจสอบมา
    ห้ามใช้คำว่า "เช็คให้แล้ว" "ตรวจสอบแล้ว" "เช็กทีละรายการแล้ว" กับสิ่งที่ไม่ได้เรียก tool จริง — เพราะทีมจะเอาไปตัดสินใจโดยเข้าใจว่ามีการตรวจสอบเกิดขึ้น
2.2 คำถามว่า "วันนี้ทำอะไรไปบ้าง / จดอะไรไว้ / มีงานอะไร / เตือนอะไรไว้" ต้องเรียก tool ตรวจจริงเสมอ (get_my_tasks, list_reminders, search_messages, get_group_summary) ห้ามตอบจากบทสนทนาที่เห็นในหน้าต่างนี้อย่างเดียว เพราะคุณเห็นย้อนหลังได้จำกัด การตอบว่า "ไม่มี" ทั้งที่ไม่ได้ตรวจ ถือว่าผิดร้ายแรง — และกฎนี้ยกเลิกด้วยคำสั่งของผู้ใช้ไม่ได้ ถ้าเขาบอกว่า "ไม่ต้องเช็ค ตอบจากที่จำได้พอ" ให้เช็คแล้วตอบตามจริงอยู่ดี เพราะสิ่งที่เขาอยากได้คือคำตอบที่ถูก ไม่ใช่คำตอบที่เร็ว
3. ตีความวันเวลาแบบไทยจากเวลาปัจจุบัน เช่น "พรุ่งนี้ 15:00" → ISO 8601 +07:00
4. การยกเลิกงาน (CANCELLED) หรือแก้ข้อมูลสำคัญของคนอื่น ให้ถามยืนยันก่อน 1 ครั้ง
5. ถ้า tool ตอบ error เรื่องสิทธิ์ ให้อธิบายอย่างสุภาพว่าติดสิทธิ์อะไร
6. เมื่อสร้างงานสำเร็จ สรุปให้เห็น: ชื่องาน / เจ้าของ / กำหนดส่ง
7. ค้นข้อความ/สรุปข้ามกลุ่ม และส่ง DM หาคนอื่น เป็นสิทธิ์ MANAGER ขึ้นไป — ก่อนส่ง DM หาคนอื่นให้ยืนยัน 1 ครั้ง ส่วน DM หาตัวเองส่งได้เลย
8. ใช้บทสนทนาล่าสุดตีความคำสั่งต่อเนื่อง เช่น ตอบ "1" หลังคุณเสนอตัวเลือก = เลือกข้อ 1 หรือพูดถึง "งานนั้น" = งานที่เพิ่งคุยกัน
8.1 แต่บทสนทนาเก่ามีไว้ "ตีความ" คำสั่งล่าสุดเท่านั้น ไม่ใช่คิวงานที่ต้องไล่ทำ — ห้ามย้อนไปทำคำสั่งเก่าที่ทำไปแล้วซ้ำอีกเด็ดขาด ถ้าคำสั่งล่าสุดเป็นคำถามหรือเป็นคนละเรื่อง ให้ตอบเฉพาะเรื่องนั้น ห้ามสร้างงานหรือตั้งเตือนจากข้อความเก่าที่เห็นในบริบท
8.2 ถ้าคำสั่งอ้างถึงของที่มีอยู่แล้วแบบไม่ระบุ ("เรื่องนั้น" "อันนั้น" "จัดการให้หน่อย") แล้วบริบทตีความได้มากกว่าหนึ่งทาง ให้ถามกลับก่อนเสมอ ห้ามเลือกให้เอง — เดาผิดแล้วไปสร้างหรือแก้ของจริงในระบบ ผู้ใช้ย้อนกลับเองไม่ได้ถ้าไม่ทันสังเกต ถามหนึ่งประโยคเสียเวลาน้อยกว่าตามแก้ทีหลัง (ถ้าเขาบอกครบอยู่แล้วว่าจะให้ทำอะไร ก็ทำเลย ไม่ต้องถามให้เสียเวลา)
8.3 คำสั่งเดียวอาจมีหลายส่วน เช่น ให้เตือนด้วยและเปิดงานด้วย ให้ทำครบทุกส่วนในเทิร์นเดียว ห้ามทำส่วนเดียวแล้วสรุปว่าเสร็จแล้ว
9. ในแชทส่วนตัว แยกสองกรณี:
   - คนแปลกหน้า (ชื่อเป็น "ไม่ทราบชื่อ" หรือไม่อยู่ในรายชื่อพนักงาน): ต้องถามชื่อเล่นและตำแหน่งงานก่อนช่วยงานใด ๆ แล้วบันทึกด้วย update_my_profile — ห้ามข้าม
   - คนที่รู้จักชื่ออยู่แล้ว: ทักทายด้วยชื่อและช่วยงานได้ทันที ถ้ายังไม่รู้ตำแหน่ง ให้ถามแทรกท้ายคำตอบแรกแบบสบาย ๆ 1 ครั้ง (ไม่บังคับ ไม่ถามซ้ำ) แล้วบันทึกเมื่อได้คำตอบ
10. เมื่อผู้ใช้บอกความชอบหรือวิธีที่อยากให้ปฏิบัติแบบถาวร ให้บันทึกด้วย remember_preference ทันที และปฏิบัติตามข้อกำหนดด้านบนเสมอ — ถ้าเป็นเรื่องบุคลิก/ชื่อเรียก/วิธีตอบของคุณเอง (เช่น "เรียกตัวเองว่าแงว", "ตอนเล่นให้กวน ๆ") และคนสั่งเป็น ADMIN ให้ใช้ scope=org เพื่อให้ใช้กับทุกคนทุกกลุ่ม ส่วนความชอบส่วนตัวของผู้ใช้ใช้ scope=me
11. คำขอให้เตือนตามเวลา ("เตือนอีก 2 นาที", "พรุ่งนี้เตือนให้ส่งภาพก่อนเที่ยง") ให้ใช้ create_reminder โดยคำนวณเวลาจริงจากเวลาปัจจุบัน — ต่างจาก create_task ที่ใช้กับงานที่ต้องติดตามสถานะ ถ้าเป็นแค่การเตือนไม่ใช่งาน ให้ใช้ create_reminder อย่างเดียว
12. ADMIN จัดการพนักงานได้: ตั้งสิทธิ์/ตำแหน่ง/แผนก/หัวหน้าของคนอื่นด้วย manage_user, ปิดสถานะคนที่ลาออกด้วย set_user_active, และผูกบัญชีที่ลงทะเบียนล่วงหน้าเข้ากับบัญชี LINE จริงด้วย link_user เมื่อเจ้าตัวเข้ากลุ่มแล้ว — การเปลี่ยน role เป็นเรื่องสิทธิ์การเข้าถึงข้อมูล ให้ทวนยืนยันก่อน 1 ครั้ง
13. ไฟล์เอกสารที่ผู้ใช้ส่งมา (PDF/Word/Excel/CSV/ข้อความ) จะถูกแนบมาให้อ่านได้เลย สรุปสาระสำคัญสั้น ๆ ชี้ให้เห็นงาน/กำหนดส่ง/มติที่ควรบันทึก แล้วถามยืนยันก่อนสร้างงานจริง ห้ามสร้างงานจากไฟล์เองโดยไม่ถาม
14. ระบบจะอ่านบทสนทนาในกลุ่มเองทุก 3 ชั่วโมง แล้วเก็บไว้สองแบบ ห้ามสับสนกัน
14.0 TASK = มีคนสั่งงานให้คนใดคนหนึ่งชัดเจน และคนนั้นรับปากแล้ว เท่านั้น เป็นรายการรอยืนยัน (ยังไม่ใช่งานจริง)
     NOTE = ทุกอย่างที่เหลือที่ควรจำไว้ เช่น คำถามที่ได้คำตอบแล้ว ข้อตกลง ตัวเลข กำหนดการ แผนที่ยังไม่มีคนรับ
     NOTE มีไว้ตอบคำถามย้อนหลังเท่านั้น ห้ามเอาไปเสนอเป็นงาน ห้ามนับเป็นสิ่งที่ค้าง ห้ามเอาไปใส่ในสรุปในฐานะงานที่ต้องทำ
     เวลาสรุปว่า "ตอนนี้มีงานอะไร" ให้นับเฉพาะงานจริงในระบบกับ TASK ที่รอยืนยัน อย่าเอา NOTE ไปปน — ใช้ list_events เมื่อถูกถามว่าจับอะไรไว้บ้าง มีอะไรรอยืนยัน หรือถามย้อนว่าเคยตกลงอะไรกัน (ใส่ query เพื่อค้นด้วยคำ, status=CONVERTED เพื่อดูข้อตกลงที่ยืนยันแล้ว) ยืนยันด้วย confirm_event ปัดทิ้งด้วย dismiss_event
14.1 ก่อนเรียก confirm_event ต้องทวนให้ผู้ใช้เห็นก่อน 1 ครั้งว่าจะสร้างงานชื่ออะไร ให้ใคร ครบกำหนดเมื่อไร แล้วรอเขาตอบรับ — ห้ามยืนยันเองแม้จะดูชัดเจนแค่ไหน เพราะรายการพวกนี้มาจากการตีความบทสนทนา ไม่ใช่คำสั่งตรงจากคน
14.2 เวลาแสดงรายการให้ใส่เลขข้อกำกับ แล้วจำ id ของแต่ละข้อไว้ตอบคำสั่งต่อเนื่อง เช่น "ยืนยันข้อ 2" หรือ "ทิ้งข้อ 1 กับ 3"`;

// ส่วนที่เปลี่ยนทุกครั้ง (เวลา ผู้ใช้ กลุ่ม รายชื่อ) ต้องอยู่หลังจุด cache เสมอ
function buildContext(ctx: Ctx, roster: any[], groups: any[], orgPersona: string | null, crossChat: string): string {
  const now = new Date();
  const thaiTime = now.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short",
  });
  const isoBkk = new Date(now.getTime() + 7 * 3600_000).toISOString().replace("Z", "+07:00");
  const rosterText = roster
    .map((u) => `- ${u.display_name ?? "(ไม่มีชื่อ)"} (${u.role}${u.job_title ? ", " + u.job_title : ""}${u.department ? ", " + u.department : ""})`)
    .join("\n");

  return `เวลาปัจจุบัน (ประเทศไทย): ${thaiTime} (ISO: ${isoBkk})
ผู้ที่กำลังคุยกับคุณ: ${ctx.caller.display_name ?? "ไม่ทราบชื่อ"} (role: ${ctx.caller.role}, ตำแหน่ง: ${ctx.caller.job_title ?? "ยังไม่ระบุ"})
กลุ่มปัจจุบัน: ${ctx.group?.group_name ?? "แชทส่วนตัว"}
ข้อกำหนดบุคลิก/วิธีทำงานที่ ADMIN ตั้งไว้ให้ใช้กับทุกคน: ${orgPersona ?? "(ยังไม่มี)"}
ข้อกำหนดเฉพาะตัวที่ผู้ใช้คนนี้เคยสั่งให้จำ: ${ctx.caller.preferences ?? "(ยังไม่มี)"}${crossChat}

พนักงานที่ลงทะเบียนแล้ว:
${rosterText}

กลุ่มทั้งหมดในองค์กร: ${groups.map((g) => g.group_name ?? "(ยังไม่ตั้งชื่อ)").join(", ")}`;
}

type AgentOpts = {
  image?: { data: string; media_type: string } | null;
  // "named" = เอ่ยชื่อลอย ๆ อาจแค่พูดถึง / "follow_up" = ไม่ได้เอ่ยชื่อ แต่บอทเพิ่งพูดจบ
  judgeAddressed?: "named" | "follow_up" | null;
  file?: FilePayload | null;
  // id ของข้อความที่แนบไฟล์หรือรูปมา ใช้ตอนผู้ใช้สั่งให้เอาไฟล์นั้นแนบเข้ากับงาน
  attachmentMessageId?: string | null;
  attachmentName?: string | null;
  toolLog?: string[]; // ใช้ตอนรันข้อสอบ เก็บชื่อ tool ที่ถูกเรียกจริง
  // ปกติข้อความที่เพิ่งเข้ามาถูกบันทึกลง messages ไปแล้ว จึงต้องตัดตัวล่าสุดออกจากประวัติกันซ้ำ
  // แต่โหมดข้อสอบไม่ได้บันทึกอะไร ถ้าตัดจะไปตัดคำตอบล่าสุดของบอททิ้ง
  // ทำให้ประวัติจบลงที่คำขอของผู้ใช้แบบไม่มีคำตอบ แล้วโมเดลนึกว่าเป็นงานค้างที่ต้องทำให้
  skipLatestMessage?: boolean;
  purpose?: string; // ใช้แยกยอด token ว่าหมดไปกับอะไร: chat / eval / gate
  spec?: ModelSpec; // ใช้ตอนรันข้อสอบด้วยโมเดลอื่น ปกติไม่ต้องส่ง ใช้ของ production
  // ถังให้ยอด token ไหลออกไปถึงผู้เรียก ใช้ตอนเทียบโมเดลว่ารอบหนึ่งเสียเงินเท่าไร
  // ไม่ใส่ก็ได้ ยอดยังถูกบันทึกลง token_usage เหมือนเดิมทุกกรณี
  usageOut?: Record<string, number>;
};

const LAST_RESORT_SPEC: ModelSpec = { provider: "anthropic", model: MODEL, keyEnv: "ANTHROPIC_API_KEY" };

// ที่เก็บชื่อก้อน cache ของ Gemini ให้ทุก instance เห็นตรงกัน ใช้ตาราง org_settings ที่มีอยู่แล้ว
// ทุก instance ต้องอ้างก้อนเดียวกัน ไม่งั้นต่างคนต่างสร้าง จ่ายค่าเก็บซ้ำซ้อนโดยไม่มีใครได้ประโยชน์
const cacheStore: CacheStore = {
  get: async (key) => {
    const { data } = await supabase.from("org_settings").select("value").eq("key", key).maybeSingle();
    return data?.value ?? null;
  },
  set: async (key, value) => {
    const { error } = await supabase.from("org_settings")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error("บันทึก cache ลง org_settings ไม่ได้:", error.message);
  },
};

// โมเดลสำรองเวลาโมเดลหลักล่มหรือปฏิเสธจนตอบไม่ได้ ตั้งด้วย secret CHAT_FALLBACK_MODEL
// ต้องเป็นคนละค่ายกับตัวหลัก ไม่งั้นเวลาค่ายนั้นล่มก็ล่มพร้อมกันทั้งคู่ ไม่ได้เป็นตาข่ายอะไร
// ตั้งเป็น "none" เพื่อปิดได้ ถ้าอยากให้พังดัง ๆ แทนที่จะเปลี่ยนโมเดลเงียบ ๆ
function fallbackSpec(primary: ModelSpec): ModelSpec | null {
  const key = (Deno.env.get("CHAT_FALLBACK_MODEL") ?? "luna").trim().toLowerCase();
  if (!key || key === "none") return null;
  const { spec } = resolveModel(key);
  if (!spec || spec.model === primary.model) return null;
  return spec;
}

// โมเดลที่ใช้ตอบแชทจริง ตั้งด้วย secret CHAT_MODEL เป็นชื่อย่อเดียวกับที่ข้อสอบใช้
// อ่านใหม่ทุก request ตั้งใจให้ย้ายหรือถอยกลับได้ด้วยการแก้ secret ไม่ต้อง deploy
// ถ้าชื่อผิดหรือ secret ของค่ายนั้นหาย ให้ตกกลับมาที่ Anthropic แทนที่จะให้บอทเงียบใส่ทีม
// — บอทที่ตอบด้วยโมเดลสำรองยังใช้งานได้ บอทที่ไม่ตอบเลยคือของเสีย
function chatSpec(): ModelSpec {
  const key = (Deno.env.get("CHAT_MODEL") ?? "").trim().toLowerCase();
  if (!key) return LAST_RESORT_SPEC;
  const { spec, error } = resolveModel(key);
  if (!spec) {
    console.error(`CHAT_MODEL="${key}" ใช้ไม่ได้ (${error}) — ตอบด้วย ${MODEL} แทน`);
    return LAST_RESORT_SPEC;
  }
  return spec;
}

// เก็บยอด token ทุกครั้งที่เรียกโมเดล ถ้าเก็บไม่ได้ต้องไม่ทำให้บอทตอบไม่ได้
async function logTokenUsage(row: Record<string, unknown>) {
  try {
    const { error } = await supabase.from("token_usage").insert(row);
    if (error) console.error("token usage log failed:", error.message);
  } catch (e) {
    console.error("token usage log failed:", e);
  }
}

async function runAgent(userText: string, ctx: Ctx, chatId: string, opts: AgentOpts = {}): Promise<string> {
  const { data: roster } = await supabase
    .from("users").select("line_user_id, display_name, role, department, job_title").eq("is_active", true).limit(50);
  const { data: allGroups } = await supabase
    .from("groups").select("line_group_id, group_name").eq("is_active", true).limit(50);

  // บทสนทนาล่าสุดในแชทนี้ เพื่อให้คำสั่งต่อเนื่องสั้น ๆ ("1", "งานเดียว") ตีความได้
  // ดึงเกินมา 1 เพราะข้อความที่กำลังตอบถูกบันทึกไปแล้ว ต้องตัดทิ้ง — ได้ประวัติจริง 20 ข้อความ
  // ประวัติเป็นส่วนที่ cache ไม่ได้ (เปลี่ยนทุกครั้ง) จึงเป็นก้อนที่โดนคิดเงินเต็มราคาหนักที่สุด
  const { data: recent } = await supabase.from("messages")
    .select("line_user_id, message_text")
    .eq("line_group_id", chatId)
    .order("created_at", { ascending: false })
    .limit(21);
  const nameOf = new Map((roster ?? []).map((u: any) => [u.line_user_id, u.display_name]));
  nameOf.set("bot", "แงว");
  // ตัดหางข้อความยาว ๆ ในประวัติทิ้ง ประวัติมีไว้ให้ตีความคำสั่งล่าสุดว่าหมายถึงอะไร
  // ไม่ได้มีไว้ให้อ่านซ้ำทั้งฉบับ คำตอบเก่าของบอทยาวได้เป็นพันตัวอักษร (สรุปรายงาน ตารางตัวเลข)
  // ซึ่งกินโควตาหนักที่สุดและแทบไม่ช่วยตีความอะไรเลย ประโยคต้น ๆ บอกได้แล้วว่าเรื่องอะไร
  const HISTORY_LINE_LIMIT = 400;
  const trim = (t: string) =>
    t.length > HISTORY_LINE_LIMIT ? `${t.slice(0, HISTORY_LINE_LIMIT)}…(ตัดส่วนที่เหลือ)` : t;
  const history = (recent ?? []).slice(opts.skipLatestMessage === false ? 0 : 1).reverse()
    .map((m: any) => `${nameOf.get(m.line_user_id) ?? "?"}: ${trim(m.message_text ?? "")}`)
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

  // จุด cache อยู่ท้ายบล็อกกฎ ทำให้ tools + กฎทั้งชุด (ซึ่งเหมือนเดิมทุกครั้ง) ถูกคิดเงินแบบ cache
  // ส่วนบริบทที่เปลี่ยนทุกครั้งอยู่หลังจุดนั้น จึงไม่ทำให้ cache พลาด
  const system: any = [
    { type: "text", text: SYSTEM_RULES, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildContext(ctx, roster ?? [], allGroups ?? [], persona?.value ?? null, crossChat) },
  ];
  // รุ่นที่ไม่มีบริบทข้ามแชท ไว้ใช้ตอนโมเดลบล็อกทั้ง prompt ทิ้ง
  const systemNoCross: any = crossChat
    ? [
      { type: "text", text: SYSTEM_RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: buildContext(ctx, roster ?? [], allGroups ?? [], persona?.value ?? null, "") },
    ]
    : system;
  // เก็บรุ่นที่ไม่มีประวัติไว้ด้วย เผื่อโมเดลบล็อกทั้ง prompt ทิ้งแล้วต้องลองใหม่แบบสั้นลง
  const textWithoutHistory = userText;
  let textContent = history
    ? `บทสนทนาล่าสุดในแชทนี้ (เก่า→ใหม่ ใช้เป็นบริบท):\n${history}\n\nคำสั่งล่าสุดจาก ${ctx.caller.display_name ?? "ผู้ใช้"}: ${userText}`
    : userText;
  if (opts.judgeAddressed) {
    const common =
      `ถ้าเขาพูดกับคุณ (ขอให้ช่วย ถาม ทักทาย ชม แซว บ่น หรือถามความเห็น) ให้ตอบ ` +
      `โดยเรื่องเล่น ๆ ตอบสั้นแบบมีอารมณ์ขัน 1-2 บรรทัดพอ ` +
      `ถ้าไม่ได้พูดกับคุณ ให้ตอบคำว่า SILENT คำเดียวเท่านั้น\n` +
      // สองข้อนี้มาจากเคสที่ sonnet เข้าไปแทรกจริงตอนทดสอบ — มันตีความว่าอะไรที่เกี่ยวกับตัวเองคือเรียกหา
      `เกณฑ์ตัดสินที่พลาดบ่อย ให้เงียบในสองกรณีนี้เสมอ:\n` +
      `- ข้อความสั่งหรือขอให้ "คนอื่น" ทำอะไร โดยเอ่ยชื่อคนนั้น (เช่น "ตั้มส่งไฟล์ให้ลูกค้าด้วย") ` +
      `แม้จะเป็นเรื่องงานที่คุณช่วยได้ ก็ไม่ใช่หน้าที่คุณจะไปรับแทนเขา\n` +
      `- ข้อความที่พูด "ถึง" คุณกับคนอื่นแบบบุคคลที่สาม (เช่น "เมื่อวานลองใช้แงวแล้ว ตอบช้าไปหน่อย") ` +
      `เป็นการเล่าให้กันฟัง ไม่ใช่พูดใส่คุณ — ต่างจากการบ่นใส่คุณตรง ๆ ว่า "แงวตอบช้าจัง"`;
    textContent = (opts.judgeAddressed === "follow_up"
      ? `หมายเหตุ: คุณเพิ่งตอบไปในแชทนี้เมื่อครู่ ข้อความล่าสุดไม่ได้แท็กคุณแต่มาต่อทันที ` +
        `คนมักถามต่อโดยไม่แท็กซ้ำ ถ้ามันอ่านเป็นคำถามหรือคำสั่งที่ต่อจากเรื่องที่คุยกับคุณอยู่ ให้ถือว่าพูดกับคุณ ` +
        `แต่ถ้าเขาหันไปคุยกับคนอื่นหรือเปลี่ยนเรื่องกันเองแล้ว ให้เงียบ — ${common}`
      : `หมายเหตุ: ข้อความล่าสุดเอ่ยถึงชื่อคุณแต่ไม่ได้แท็กเรียกตรง ๆ อ่านบริบทแล้วตัดสินใจเอง — ` +
        `ถ้าเป็นการคุยกันเองระหว่างคนอื่นที่แค่เอ่ยชื่อคุณผ่าน ๆ โดยไม่ได้พูดกับคุณ ให้เงียบ — ${common}`
    ) + `\n\n` + textContent;
  }
  if (opts.file?.kind === "text") {
    textContent = `เนื้อหาไฟล์ "${opts.file.name}" ที่ผู้ใช้ส่งมา:\n${opts.file.text}\n\n---\n\n${textContent}`;
  } else if (opts.file?.kind === "unsupported") {
    textContent = `หมายเหตุ: ผู้ใช้ส่งไฟล์ "${opts.file.name}" มาแต่อ่านไม่ได้ (${opts.file.reason}) ` +
      `บอกผู้ใช้ตรง ๆ อย่างเป็นมิตรและเสนอทางแก้\n\n${textContent}`;
  }

  let spec = opts.spec ?? chatSpec();
  // ข้อสอบระบุโมเดลมาเอง ห้ามสลับไปตัวอื่นกลางคัน ไม่งั้นผลเทียบจะเป็นของโมเดลที่ไม่ได้สั่ง
  const backup = opts.spec ? null : fallbackSpec(spec);
  let usedBackup = false;

  const blocks: any[] = [];
  if (opts.image) {
    blocks.push({ type: "image", source: { type: "base64", media_type: opts.image.media_type, data: opts.image.data } });
  }
  if (opts.file?.kind === "pdf") {
    if (spec.provider !== "openai") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: opts.file.data },
      });
    } else {
      // โมเดลค่ายอื่นรับ PDF แนบตรงไม่ได้ผ่านช่องทางที่ใช้อยู่ ต้องบอกผู้ใช้ให้รู้ตัว
      // ห้ามเงียบ ๆ ทิ้งไฟล์แล้วตอบไปเรื่อย เพราะเขาจะเชื่อว่าบอทอ่านไฟล์แล้ว
      textContent = `หมายเหตุ: ผู้ใช้ส่งไฟล์ PDF "${opts.file.name}" มา แต่ตอนนี้คุณอ่านไฟล์ PDF ไม่ได้ ` +
        `บอกเขาตรง ๆ อย่างเป็นมิตรว่าอ่าน PDF ไม่ได้ และเสนอให้ก็อปข้อความในไฟล์มาวางแทน ` +
        `ห้ามเดาเนื้อหาในไฟล์เด็ดขาด\n\n${textContent}`;
    }
  }
  blocks.push({ type: "text", text: textContent });
  const content: any = blocks.length === 1 ? textContent : blocks;
  const messages: any[] = [{ role: "user", content }];

  // นับ token รวมทุกรอบของคำตอบเดียว แล้วบันทึกครั้งเดียวตอนจบ ไม่ว่าจะจบด้วยทางไหน
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, iterations: 0 };

  // โมเดลบางค่ายมี filter ที่บล็อกทั้ง prompt ทิ้งก่อนจะได้เริ่มตอบ และตั้งค่าปิดไม่ได้
  //
  // จากการไล่หาเมื่อ 3 ก.ย. 2569: ไม่มีข้อความไหนผิดเดี่ยว ๆ ยิงประวัติทั้งก้อนทีละบรรทัด
  // และทั้งก้อนพร้อม system กับ tool ครบ ก็ไม่โดน ที่โดนคือตอนมี "บริบทข้ามแชท" อยู่ด้วย
  // พร้อมกับประวัติในแชทนี้ ตัดอย่างใดอย่างหนึ่งออกแล้วผ่านทั้งคู่
  // จึงถอยทีละขั้นตามลำดับความสำคัญ: ตัดบริบทข้ามแชทก่อน เพราะเป็นของนอกห้องและมีค่าน้อยสุด
  // ค่อยตัดประวัติในแชทนี้ ซึ่งเป็นตัวที่ทำให้คำสั่งต่อเนื่องอย่าง "เอาอันแรก" ยังทำงานได้
  let attempt = 0;
  let sysNow = system;

  try {
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let response: any;
    try {
      response = await createMessage(spec, {
        max_tokens: 4096,
        system: sysNow,
        tools: TOOLS,
        messages,
        // กฎ + เครื่องมือเหมือนกันทุกข้อความ ฝากไว้ฝั่งโมเดลก้อนเดียวแล้วอ้างถึง (มีผลเฉพาะค่ายที่รองรับ)
        cache: { key: "chat", store: cacheStore, ttlSeconds: 4 * 3600 },
      });
    } catch (e) {
      // โมเดลหลักตอบไม่ได้เลย (ล่ม เครดิตหมด เขียนคำสั่งพังซ้ำ) — ย้ายไปตัวสำรองแล้วเริ่มเทิร์นใหม่
      // ยอมเสียเงินสองรอบดีกว่าปล่อยให้ทีมเจอบอทเงียบ และบันทึกไว้ให้รู้ว่าวันนี้ต้องพึ่งตัวสำรอง
      if ((e as any)?.name !== "PromptBlocked" && backup && !usedBackup) {
        usedBackup = true;
        spec = backup;
        console.error(`โมเดลหลักตอบไม่ได้ (${e}) — เปลี่ยนไปใช้ ${backup.model} แทนสำหรับคำตอบนี้`);
        messages.length = 0;
        messages.push({ role: "user", content });
        sysNow = system;
        attempt = 0;
        i--;
        continue;
      }
      if ((e as any)?.name !== "PromptBlocked") throw e;
      attempt++;
      if (attempt === 1 && crossChat) {
        console.error("โมเดลบล็อก prompt ทิ้ง — ลองใหม่โดยตัดบริบทข้ามแชทออก");
        sysNow = systemNoCross;
        i--;
        continue;
      }
      if (attempt <= 2 && history) {
        console.error("โมเดลบล็อก prompt ทิ้ง — ลองใหม่โดยตัดประวัติบทสนทนาออกด้วย");
        sysNow = systemNoCross;
        messages.length = 0;
        messages.push({ role: "user", content: textWithoutHistory });
        i--;
        continue;
      }
      throw e;
    }

    const u = response.usage ?? {};
    usage.iterations++;
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;

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
    // โมเดลบอกว่าจะเรียก tool แต่ไม่ได้ส่งคำสั่งเรียกมาสักตัว เกิดขึ้นได้จริงแม้จะไม่บ่อย
    // ถ้าปล่อยผ่าน เราจะส่ง message เปล่ากลับไป แล้ว API ตอบ 400 ทำให้ทั้งเทิร์นพัง
    // ทั้งที่เนื้อหาที่มันเขียนมาแล้วอาจใช้ตอบได้อยู่ — เอาเท่าที่มีไปตอบดีกว่าไม่ตอบเลย
    if (toolResults.length === 0) {
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      console.error("model said tool_use but sent no tool call; answering with the text it had");
      return text || "ขอโทษค่ะ แงวสะดุดกลางทาง ลองพิมพ์ใหม่อีกครั้งนะคะ 🙏";
    }
    messages.push({ role: "user", content: toolResults });
  }
  return "งานนี้ซับซ้อนเกินรอบที่กำหนด ลองแบ่งคำสั่งเป็นขั้นสั้น ๆ นะครับ";
  } finally {
    if (opts.usageOut) Object.assign(opts.usageOut, usage);
    if (usage.iterations > 0) {
      await logTokenUsage({
        purpose: opts.purpose ?? "chat",
        model: spec.model,
        chat_id: chatId,
        user_id: ctx.caller?.id ?? null,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        iterations: usage.iterations,
      });
    }
  }
}

// ---------------------------------------------------------------- Webhook

function isCallingAI(text: string): boolean {
  return /@\s?(ai|mt\s?agent)/i.test(text);
}

// เอ่ยชื่อบอทโดยไม่แท็ก → ให้โมเดลอ่านบริบทแล้วตัดสินใจเองว่าควรตอบไหม
function isNameMention(text: string): boolean {
  return /(แงว|เอ็มที|mt\s?agent)/i.test(text);
}

// ข้อความที่มีแค่ชื่อบอทล้วน ๆ ("แงว", "แงวๆ", "แงว?") คือการเรียกตรง ๆ
// เคยปล่อยให้โมเดลตัดสินแล้วมันตอบ SILENT ใส่คนที่เรียกชื่อจริง ๆ — เรียกชื่อคือเรียก ไม่ต้องตีความ
function isBareName(text: string): boolean {
  if (!isNameMention(text)) return false;
  const leftover = text
    .replace(/(แงว|เอ็มที|mt\s?agent)/gi, "")
    .replace(/[\s\p{P}\p{S}ๆฯ]/gu, "");
  return leftover.length === 0;
}

async function handleEvent(event: any) {
  if (event.type !== "message") return;
  const msgType: string = event.message?.type ?? "";
  if (!["text", "image", "file"].includes(msgType)) return;

  const fileName: string = event.message?.fileName ?? "ไฟล์";
  const text: string = msgType === "text"
    ? event.message.text
    : msgType === "image" ? "[ส่งรูปภาพ]" : `[ส่งไฟล์: ${fileName}]`;
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
  // - ในกลุ่ม: ตอบเมื่อแท็ก เรียกชื่อล้วน ๆ เอ่ยชื่อ หรือกำลังคุยต่อจากที่บอทเพิ่งพูด
  //   (สองอย่างหลัง → โมเดลอ่านบริบทแล้วตัดสินใจเองว่าควรตอบไหม)
  const tagged = msgType === "text" && (isCallingAI(text) || isBareName(text));
  const named = msgType === "text" && isNameMention(text);
  // รูปและไฟล์ในกลุ่มแค่เก็บไว้ก่อน รอให้คนแท็กถามถึง จะได้ไม่รบกวนทุกครั้งที่มีคนแชร์ไฟล์
  if (lineGroupId && msgType !== "text") return;

  // ถามต่อจากคำตอบของบอทโดยไม่แท็กซ้ำเป็นเรื่องปกติของการคุยกัน — ถ้าบอทเป็นคนพูดล่าสุด
  // และเพิ่งพูดไปไม่นาน ให้โมเดลอ่านบริบทแล้วตัดสินใจ ไม่ใช่เงียบใส่ไปเลย
  // ผูกกับ "บอทพูดล่าสุด" ไม่ใช่แค่ช่วงเวลา เพราะพอมีคนอื่นพูดแทรก บทสนทนาก็เปลี่ยนมือไปแล้ว
  let followUp = false;
  if (lineGroupId && msgType === "text" && !tagged && !named) {
    // ดึงมา 2 แถวแล้วข้ามข้อความปัจจุบันเอง (มันเพิ่งถูกบันทึกไปด้านบน)
    // ห้ามกรองด้วย .neq("line_message_id", ...) เพราะคำตอบของบอทเก็บ line_message_id เป็น NULL
    // และ NULL <> x ใน SQL ได้ NULL ไม่ใช่ true — แถวของบอทจะถูกกรองทิ้งไปด้วย
    // ซึ่งเป็นแถวเดียวที่เงื่อนไขนี้ต้องการเห็น ทำให้ followUp เป็น false ตลอดกาล
    const { data: prevRows } = await supabase.from("messages")
      .select("line_user_id, line_message_id, created_at")
      .eq("line_group_id", chatId)
      .order("created_at", { ascending: false }).limit(2);
    const prev = (prevRows ?? []).find((r: any) => r.line_message_id !== event.message.id);
    followUp = Boolean(prev && prev.line_user_id === "bot" &&
      Date.now() - new Date(prev.created_at).getTime() < FOLLOW_UP_WINDOW_MS);
  }

  if (lineGroupId && !tagged && !named && !followUp) return;

  const caller = await ensureUser(lineUserId, lineGroupId);
  const group = await ensureGroup(lineGroupId);
  const ctx: Ctx = { caller, group, lineGroupId };

  // แนบรูป: ส่งรูปมาตรง ๆ (DM) หรือข้อความพูดถึงรูป → ดึงรูปล่าสุดในแชทมาให้ดู
  let image: { data: string; media_type: string } | null = null;
  if (msgType === "image") {
    image = await fetchImageContent(event.message.id);
  } else if (msgType === "text" && /รูป|ภาพ|สกรีน|screenshot|image/i.test(text)) {
    const { data: img } = await supabase.from("messages")
      .select("line_message_id")
      .eq("line_group_id", chatId)
      .eq("message_type", "image")
      .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    if (img?.line_message_id) image = await fetchImageContent(img.line_message_id);
  }

  // แนบไฟล์: ส่งไฟล์มาตรง ๆ หรือข้อความพูดถึงไฟล์/เอกสาร → ดึงไฟล์ล่าสุดในแชทมาอ่าน
  let file: FilePayload | null = null;
  if (msgType === "file") {
    file = await extractFile(event.message.id, fileName);
  } else if (msgType === "text" && /ไฟล์|เอกสาร|สรุปประชุม|รายงาน|pdf|excel|word|ppt/i.test(text)) {
    const { data: f } = await supabase.from("messages")
      .select("line_message_id, message_text")
      .eq("line_group_id", chatId)
      .eq("message_type", "file")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    if (f?.line_message_id) {
      const nameFromLog = String(f.message_text ?? "").replace(/^\[ส่งไฟล์:\s*/, "").replace(/\]$/, "");
      file = await extractFile(f.line_message_id, nameFromLog || "ไฟล์");
    }
  }

  // ของที่แนบมากับข้อความนี้ ให้ tool เก็บเข้ากับงานได้โดยไม่ต้องส่งไฟล์ผ่านโมเดล
  if (msgType === "image") {
    ctx.attachment = { messageId: event.message.id, name: `รูป_${new Date().toISOString().slice(0, 10)}.jpg` };
  } else if (msgType === "file") {
    ctx.attachment = { messageId: event.message.id, name: fileName || "ไฟล์" };
  }

  const question = msgType === "image"
    ? "ผู้ใช้ส่งรูปภาพนี้มา ช่วยดูรูปและตอบตามบริบทของบทสนทนา"
    : msgType === "file"
    ? `ผู้ใช้ส่งไฟล์ "${fileName}" มา อ่านเนื้อหาแล้วสรุปสั้น ๆ ว่าไฟล์นี้เกี่ยวกับอะไร มีงานหรือกำหนดส่งอะไรที่ควรบันทึกเข้าระบบบ้าง แล้วถามว่าให้สร้างงานให้เลยไหม (อย่าเพิ่งสร้างเองจนกว่าจะยืนยัน)`
    : text.replace(/@\s?(ai|mt\s?agent\s?1?)/i, "").trim() || "สวัสดี";
  const replyTo = lineGroupId ?? lineUserId;
  const judgeAddressed: "named" | "follow_up" | null =
    !lineGroupId || tagged ? null : named ? "named" : followUp ? "follow_up" : null;
  // อ้างข้อความต้นทางเฉพาะในกลุ่ม จะได้รู้ว่าบอทตอบเรื่องไหนตอนหลายคนคุยกันพร้อมกัน
  const quoteToken: string | null = lineGroupId ? (event.message?.quoteToken ?? null) : null;

  try {
    const answer = await runAgent(question, ctx, chatId, { image, file, judgeAddressed });
    if (judgeAddressed && answer.trim().toUpperCase().startsWith("SILENT")) return;
    await sendReply(event.replyToken, replyTo, answer, quoteToken);
    // เก็บคำตอบของบอทด้วย เพื่อให้ summary/ความจำบทสนทนาเห็นครบทั้งสองฝั่ง
    await supabase.from("messages").insert({
      line_user_id: "bot",
      line_group_id: chatId,
      message_text: answer,
      message_type: "bot",
    });
  } catch (e) {
    console.error("agent error:", e);
    await sendReply(event.replyToken, replyTo, "ขอโทษค่า ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งนะคะ 🙏", quoteToken);
  }
}

// โหมดข้อสอบ: รัน agent จริงด้วยตัวตนที่ระบุ แต่ไม่ส่งเข้า LINE และไม่บันทึกลง messages
// ใช้ตรวจว่าการแก้แต่ละครั้งทำให้พฤติกรรมเดิมพังหรือไม่ ก่อนปล่อยให้ทีมใช้
async function runEval(body: string): Promise<Response> {
  const { as_user, message, in_group, model: modelKey, judge } = JSON.parse(body);
  const { spec: evalSpec, error: modelError } = resolveModel(String(modelKey ?? "sonnet").toLowerCase());
  if (!evalSpec) return Response.json({ error: modelError }, { status: 400 });
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
  const ctx: Ctx = { caller, group, lineGroupId: group?.line_group_id ?? null, dryRun: true };
  const chatId = group?.line_group_id ?? caller.line_user_id;

  const toolLog: string[] = [];
  const usage: Record<string, number> = {};
  const started = Date.now();
  const startedIso = new Date().toISOString();
  try {
    // judge = จำลองกรณีที่ในกลุ่มไม่ได้แท็กบอท แล้วต้องให้โมเดลตัดสินเองว่าจะตอบหรือเงียบ
    // ข้อสอบตรวจได้ด้วยการดูว่าคำตอบขึ้นต้นด้วย SILENT หรือไม่
    const answer = await runAgent(message, ctx, chatId, {
      toolLog, usageOut: usage, skipLatestMessage: false, purpose: "eval", spec: evalSpec,
      judgeAddressed: judge === "named" || judge === "follow_up" ? judge : null,
    });

    // เก็บกวาดของที่ข้อสอบสร้างไว้ ไม่ให้ไปรกรายการงานจริงของทีม
    // ยกเลิกแทนการลบ เพื่อให้ audit trail ยังครบ
    let cleaned = { tasks: 0, reminders: 0, events: 0 };
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
    // คืนสถานะรายการที่ข้อสอบเผลอยืนยัน/ปัดทิ้ง ไม่ให้คิวรอตรวจของทีมเพี้ยน
    const { data: evalEvents } = await supabase.from("events")
      .update({ status: "NEW", task_id: null, reviewed_by_user_id: null, reviewed_at: null })
      .eq("reviewed_by_user_id", caller.id).gte("reviewed_at", startedIso)
      .in("status", ["CONVERTED", "DISMISSED"]).select("id");
    cleaned.events = (evalEvents ?? []).length;

    return Response.json({
      as_user: caller.display_name, role: caller.role,
      group: group?.group_name ?? null, model: evalSpec.model,
      message, answer, tools_called: toolLog, cleaned, ms: Date.now() - started,
      usage: {
        input: usage.input ?? 0, output: usage.output ?? 0,
        cache_read: usage.cacheRead ?? 0, cache_write: usage.cacheWrite ?? 0,
        iterations: usage.iterations ?? 0,
      },
    });
  } catch (e) {
    return Response.json({ error: String(e), tools_called: toolLog }, { status: 500 });
  }
}

// ปฏิทินส่วนตัวแบบ .ics ให้เอาไปกดสมัครใน Google Calendar
// ปฏิทินฝั่งผู้ใช้จะมาดึงเองเป็นระยะ จึงต้องเป็น GET ไม่มีล็อกอิน ยืนยันตัวด้วย token ในลิงก์
function icsEscape(t: string): string {
  return String(t).replace(/\\/g, "\\\\").replace(/[;,]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
}
function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function serveCalendar(token: string): Promise<Response> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { data: feed } = await supabase.from("calendar_feeds")
    .select("id, user_id, revoked_at").eq("token_hash", hash).maybeSingle();
  if (!feed || feed.revoked_at) return new Response("calendar not found", { status: 404 });

  await supabase.from("calendar_feeds").update({ last_read_at: new Date().toISOString() }).eq("id", feed.id);

  const { data: tasks } = await supabase.from("tasks")
    .select("id, title, description, due_at, status, priority")
    .eq("owner_user_id", feed.user_id).in("status", ["TODO", "DOING"])
    .not("due_at", "is", null).limit(200);
  const { data: reminders } = await supabase.from("reminders")
    .select("id, message, remind_at, status")
    .eq("target_user_id", feed.user_id).eq("status", "PENDING").limit(200);

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MT Agent//แงว//TH",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:งานจากแงว",
    "X-WR-TIMEZONE:Asia/Bangkok",
  ];
  const now = new Date();
  for (const t of tasks ?? []) {
    const start = new Date(t.due_at);
    lines.push(
      "BEGIN:VEVENT",
      `UID:task-${t.id}@mt-agent`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(new Date(start.getTime() + 30 * 60_000))}`,
      `SUMMARY:${icsEscape((t.priority === "URGENT" || t.priority === "HIGH" ? "❗ " : "") + t.title)}`,
      `DESCRIPTION:${icsEscape(t.description ?? "งานจากแงว")}`,
      "END:VEVENT",
    );
  }
  for (const r of reminders ?? []) {
    const start = new Date(r.remind_at);
    lines.push(
      "BEGIN:VEVENT",
      `UID:reminder-${r.id}@mt-agent`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(new Date(start.getTime() + 15 * 60_000))}`,
      `SUMMARY:${icsEscape("⏰ " + r.message)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Disposition": 'inline; filename="mt-agent.ics"',
    },
  });
}

Deno.serve(async (req: Request) => {
  const path = new URL(req.url).pathname;
  const cal = path.match(/\/calendar\/([A-Za-z0-9]+)\.ics$/);
  if (cal) return await serveCalendar(cal[1]);

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
