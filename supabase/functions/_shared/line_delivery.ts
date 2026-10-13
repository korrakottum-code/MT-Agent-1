// สถานะการส่งข้อความออกของ LINE ที่ตัวรับแชทกับงานตามเวลาต้องเห็นตรงกัน
//
// LINE OA มีโควตาข้อความแบบ push ต่อเดือน พอหมด ทุกอย่างที่แงวส่งเองโดยไม่มีคนทัก
// (ตัวเตือน สรุปเย็น ปลุกเช้า สรุปเช็กชื่อ) จะได้ 429 กลับมาจนถึงต้นเดือนถัดไป
// ส่วนการตอบตอนมีคนทักใช้ reply ซึ่งไม่นับโควตา จึงยังใช้ได้ปกติ
//
// 12 ต.ค. 2569 โควตาหมดตั้งแต่ราวเที่ยง แต่ระบบบันทึกว่าส่งสำเร็จทุกครั้ง
// แงวเลยไม่รู้ว่าข้อความไม่ถึง พอตั้มถามว่าทำไมไม่เห็นตัวเตือน 9 โมง มันแต่งเหตุผลขึ้นมาเอง
// ว่า "ตั้งเตือนเองไม่ได้ ต้องให้ dev ตั้ง cron" ทั้งที่ระบบเตือนทำงานครบ ติดแค่โควตา
// ไฟล์นี้มีไว้ให้ทุกส่วนรู้ความจริงเรื่องเดียวกัน แล้วแงวพูดความจริงได้

export const PUSH_BLOCKED_KEY = "line_push_blocked";

export type PushBlocked = { since: string; last_seen: string; detail: string };

export function isQuotaError(status: number, detail: string): boolean {
  return status === 429 && /monthly limit/i.test(detail);
}

// เก็บเวลาที่เริ่มพังครั้งแรกไว้ ไม่ทับทุกครั้ง จะได้ตอบได้ว่าส่งไม่ออกมาตั้งแต่เมื่อไร
export async function markPushBlocked(sb: any, detail: string): Promise<void> {
  const now = new Date().toISOString();
  const prev = await getPushBlocked(sb);
  const value: PushBlocked = { since: prev?.since ?? now, last_seen: now, detail: detail.slice(0, 200) };
  const { error } = await sb.from("org_settings")
    .upsert({ key: PUSH_BLOCKED_KEY, value: JSON.stringify(value), updated_at: now });
  if (error) console.error("บันทึกสถานะโควตา LINE ไม่ได้:", error.message);
}

// push สำเร็จแปลว่าโควตากลับมาแล้ว (อัปเกรดแพ็กเกจ หรือขึ้นเดือนใหม่)
export async function clearPushBlocked(sb: any): Promise<void> {
  await sb.from("org_settings").delete().eq("key", PUSH_BLOCKED_KEY);
}

export async function getPushBlocked(sb: any): Promise<PushBlocked | null> {
  const { data } = await sb.from("org_settings").select("value").eq("key", PUSH_BLOCKED_KEY).maybeSingle();
  if (!data?.value) return null;
  try {
    return JSON.parse(data.value) as PushBlocked;
  } catch {
    return null;
  }
}

// ประโยคเดียวที่ทุกที่ใช้อธิบาย จะได้ไม่มีสองเวอร์ชันของความจริง
export function describePushBlocked(b: PushBlocked): string {
  const since = new Date(b.since).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short",
  });
  return `โควตาข้อความ LINE ของเดือนนี้หมดตั้งแต่ ${since} ข้อความที่แงวส่งเองโดยไม่มีคนทัก ` +
    `(ตัวเตือน สรุปเย็น ปลุกเช้า สรุปเช็กชื่อ) ส่งไม่ออกจนกว่าจะอัปเกรดแพ็กเกจ LINE OA หรือขึ้นเดือนใหม่ ` +
    `ส่วนการตอบตอนมีคนทักยังใช้ได้ปกติ`;
}

// ---------------------------------------------------------------- แจ้งปัญหาเข้าแชทส่วนตัว ADMIN
//
// ตั้มขอไว้ 13 ต.ค. หลังโควตาหมดไปวันกว่าโดยไม่มีใครรู้ ว่าต่อไปมีปัญหาให้บอกในแชทส่วนตัว
// แต่ถ้าปัญหาคือโควตาหมด การ DM ก็ใช้ push และพังไปด้วย จึงมีสองทาง
// 1. เตือนก่อนหมด ตอนยังส่งได้ (watchLineQuota ดูยอดใช้จาก LINE ทุกชั่วโมง)
// 2. ถ้าส่งไม่ออกจริง เก็บไว้ แล้วแนบไปกับคำตอบครั้งถัดไปที่ ADMIN ทักแงวในแชทส่วนตัว
//    เพราะการตอบใช้ reply ซึ่งไม่นับโควตา

export type PushFn = (to: string, text: string) => Promise<{ ok: boolean; quota?: boolean }>;

const PENDING_ALERTS_KEY = "admin_alerts_pending";

async function getSetting(sb: any, key: string): Promise<string | null> {
  const { data } = await sb.from("org_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function setSetting(sb: any, key: string, value: string): Promise<void> {
  await sb.from("org_settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

export async function adminRecipients(sb: any): Promise<string[]> {
  const { data } = await sb.from("users").select("line_user_id")
    .eq("role", "ADMIN").eq("is_active", true);
  return (data ?? []).map((u: any) => String(u.line_user_id ?? ""))
    .filter((id: string) => id.startsWith("U"));
}

// kind ใช้กันแจ้งเรื่องเดิมรัว ๆ เรื่องเดียวกันแจ้งซ้ำได้เมื่อพ้น cooldown
export async function notifyAdmins(
  sb: any,
  push: PushFn,
  kind: string,
  text: string,
  cooldownMs = 3600_000,
): Promise<"sent" | "cooldown" | "queued" | "no_admin"> {
  const key = `alert:${kind}`;
  const last = await getSetting(sb, key);
  if (last && Date.now() - new Date(last).getTime() < cooldownMs) return "cooldown";
  const admins = await adminRecipients(sb);
  if (admins.length === 0) return "no_admin";
  await setSetting(sb, key, new Date().toISOString());

  const body = `⚠️ แงวแจ้งปัญหา\n${text}`;
  let anyOk = false;
  for (const to of admins) {
    const r = await push(to, body);
    if (r.ok) anyOk = true;
  }
  if (anyOk) return "sent";
  await queueAdminAlert(sb, text);
  return "queued";
}

// เก็บไว้ไม่เกิน 5 เรื่องล่าสุด ข้อความเก่าที่ค้างนานจนถูกดันออกไม่มีประโยชน์แล้ว
export async function queueAdminAlert(sb: any, text: string): Promise<void> {
  const raw = await getSetting(sb, PENDING_ALERTS_KEY);
  let list: { at: string; text: string }[] = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch { /* เริ่มใหม่ */ }
  if (list.some((a) => a.text === text)) return;
  list.push({ at: new Date().toISOString(), text });
  await setSetting(sb, PENDING_ALERTS_KEY, JSON.stringify(list.slice(-5)));
}

// เรียกตอน ADMIN ทักแงวในแชทส่วนตัว คืนข้อความที่ค้างส่งแล้วล้างทิ้ง
// สถานะโควตาหมดแนบทุกวันจนกว่าจะแก้ ไม่งั้นทักครั้งแรกรู้แล้วก็ลืม
export async function takeAdminAlerts(sb: any): Promise<string | null> {
  const parts: string[] = [];
  const raw = await getSetting(sb, PENDING_ALERTS_KEY);
  if (raw) {
    try {
      for (const a of JSON.parse(raw) as { at: string; text: string }[]) parts.push(a.text);
    } catch { /* ข้อมูลเสีย ทิ้งไป */ }
    await sb.from("org_settings").delete().eq("key", PENDING_ALERTS_KEY);
  }
  const blocked = await getPushBlocked(sb);
  if (blocked) {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    if ((await getSetting(sb, "alert:blocked_told_on")) !== today) {
      await setSetting(sb, "alert:blocked_told_on", today);
      if (!parts.some((p) => p.includes("โควตา"))) parts.push(describePushBlocked(blocked));
    }
  }
  return parts.length ? `⚠️ แงวแจ้งปัญหา (ส่งเข้าแชทนี้ตอนเกิดเหตุไม่ได้)\n${parts.map((p) => `• ${p}`).join("\n")}` : null;
}

// ---------------------------------------------------------------- เตือนก่อนโควตาหมด

const QUOTA_CHECKED_KEY = "line_quota_checked_at";
const QUOTA_ALERTED_KEY = "line_quota_alerted";
const QUOTA_THRESHOLDS = [0.95, 0.8];

export async function watchLineQuota(sb: any, channelToken: string, push: PushFn): Promise<void> {
  const checked = await getSetting(sb, QUOTA_CHECKED_KEY);
  if (checked && Date.now() - new Date(checked).getTime() < 3600_000) return;
  await setSetting(sb, QUOTA_CHECKED_KEY, new Date().toISOString());

  const headers = { Authorization: `Bearer ${channelToken}` };
  const [qRes, uRes] = await Promise.all([
    fetch("https://api.line.me/v2/bot/message/quota", { headers }),
    fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers }),
  ]);
  if (!qRes.ok || !uRes.ok) {
    console.error("อ่านโควตา LINE ไม่ได้", qRes.status, uRes.status);
    return;
  }
  const quota = await qRes.json();
  const used = Number((await uRes.json())?.totalUsage ?? 0);
  // แพ็กเกจที่ไม่จำกัดจำนวนไม่มีอะไรต้องเฝ้า
  if (quota?.type !== "limited") return;
  const limit = Number(quota?.value ?? 0);
  if (!limit) return;

  const bkk = new Date(Date.now() + 7 * 3600_000);
  const month = bkk.toISOString().slice(0, 7);
  const alerted = (await getSetting(sb, QUOTA_ALERTED_KEY)) ?? "";
  const hit = QUOTA_THRESHOLDS.find((t) => used / limit >= t);
  if (!hit) return;
  const mark = `${month}:${hit}`;
  if (alerted.split(",").includes(mark)) return;

  // คาดว่าจะหมดวันไหน จากอัตราเฉลี่ยต่อวันของเดือนนี้
  const day = bkk.getUTCDate();
  const perDay = used / Math.max(1, day);
  const daysLeft = perDay > 0 ? Math.floor((limit - used) / perDay) : null;
  // โควตารีเซ็ตต้นเดือน ถ้าคาดว่าหมดเลยสิ้นเดือนก็คือไม่หมดในเดือนนี้
  const monthEnd = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth() + 1, 0)).getUTCDate();
  const runsOut = daysLeft !== null && daysLeft >= 0 && day + daysLeft <= monthEnd
    ? new Date(bkk.getTime() + daysLeft * 24 * 3600_000).toISOString().slice(0, 10)
    : null;

  const text = `โควตาข้อความ LINE เดือนนี้ใช้ไปแล้ว ${used.toLocaleString()} จาก ${limit.toLocaleString()} ` +
    `(${Math.round((used / limit) * 100)}%)` +
    (runsOut ? ` ถ้าใช้เท่านี้ต่อไปน่าจะหมดราววันที่ ${runsOut}` : "") +
    `\nพอหมด ตัวเตือน สรุปเย็น ปลุกเช้า และสรุปเช็กชื่อจะส่งไม่ออกจนถึงต้นเดือนหน้า ` +
    `การตอบตอนมีคนทักยังใช้ได้ปกติ ถ้าจะกันไว้ให้อัปเกรดแพ็กเกจใน LINE Official Account Manager`;
  const result = await notifyAdmins(sb, push, `quota_${mark}`, text, 30 * 24 * 3600_000);
  if (result === "sent" || result === "queued") {
    await setSetting(sb, QUOTA_ALERTED_KEY, [alerted, mark].filter(Boolean).join(","));
  }
}
