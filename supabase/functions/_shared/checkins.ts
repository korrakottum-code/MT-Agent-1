// เช็กชื่อรายวัน — ส่วนที่ line-webhook (ตอนมีคนแจ้ง) กับ scheduled-jobs (ตอนสรุปปิดวัน) ใช้ร่วมกัน
//
// หลักคิด: นับด้วยฐานข้อมูล ไม่ใช่ด้วยความจำของโมเดล
// บอทคู่แข่งที่ทีมลูกค้าใช้อยู่นับสาขาในหัว จึงบอกว่า "จดแล้ว" ทั้งที่ไม่ได้จด นับสาขาที่ไม่มีใครแจ้ง
// และยอดสะสมกระโดดไปมาในวันเดียว ทุกตัวเลขในไฟล์นี้จึงมาจากแถวใน checkins เท่านั้น

export type Campaign = {
  id: string;
  chat_id: string;
  name: string;
  units: string[];
  target_count: number | null;
  summary_time: string;
  active: boolean;
  last_summary_on: string | null;
};

export type UnitGap = { unit: string; last_checked_on: string | null; days_missing: number };

export type DayStatus = {
  date: string;
  count: number;
  done: string[];
  remaining: UnitGap[];
  target: number | null;
  streaks: Record<string, number>;
};

// วันที่ตามเวลาไทย เป็น YYYY-MM-DD ฐานข้อมูลเก็บ date ล้วน จึงต้องคิดวันฝั่งไทยก่อนเสมอ
export function thaiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function thaiTimeHHMM(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
}

export function thaiDateLabel(ymd: string): string {
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y + 543}`;
}

// เทียบชื่อหน่วยแบบหลวม ๆ "สาขาหอกาญ" "Class หอกาญ" "หอกาญ " ต้องเป็นตัวเดียวกัน
// แต่ห้ามเดา ถ้าตรงได้หลายตัวให้คืนตัวเลือกไปถามคน
export function unitKey(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(สาขา|classgo|class|คลาส|คลาสโก)+/g, "")
    .replace(/[\-_.()\[\]]/g, "")
    .replace(/(สาขา|ครับ|ค่ะ|คะ|นะคะ|นะครับ)+$/g, "");
}

export function matchUnit(
  given: string,
  roster: string[],
): { unit?: string; candidates?: string[] } {
  const k = unitKey(given);
  if (!k) return { candidates: [] };
  if (roster.length === 0) {
    // ไม่มีรายชื่อกำหนดไว้ จดตามที่พิมพ์มา แต่ตัดคำว่า "สาขา" ออกให้สะกดตรงกันทุกครั้ง
    return { unit: String(given).trim().replace(/^สาขา\s*/, "") };
  }
  const exact = roster.find((u) => unitKey(u) === k);
  if (exact) return { unit: exact };
  const partial = roster.filter((u) => {
    const uk = unitKey(u);
    return uk.length >= 2 && k.length >= 2 && (uk.includes(k) || k.includes(uk));
  });
  if (partial.length === 1) return { unit: partial[0] };
  return { candidates: partial.slice(0, 3) };
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

// สถานะของวันหนึ่ง ๆ: ใครแจ้งแล้ว ใครยังขาด ขาดมากี่วัน และใครแจ้งติดต่อกันมากี่วัน
// ดึงย้อนหลัง 30 วันครั้งเดียวแล้วคิดในหน่วยความจำ งานเบาพอสำหรับสาขาไม่กี่สิบแห่ง
export async function dayStatus(supabase: any, campaign: Campaign, date: string): Promise<DayStatus> {
  const since = addDays(date, -30);
  const { data: rows } = await supabase.from("checkins")
    .select("unit, checked_on")
    .eq("campaign_id", campaign.id)
    .gte("checked_on", since)
    .lte("checked_on", date);
  const byUnit = new Map<string, Set<string>>();
  for (const r of rows ?? []) {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, new Set());
    byUnit.get(r.unit)!.add(String(r.checked_on));
  }

  const done = [...byUnit.entries()].filter(([, days]) => days.has(date)).map(([u]) => u);
  const roster = campaign.units.length > 0 ? campaign.units : [...byUnit.keys()];
  const remaining: UnitGap[] = [];
  for (const u of roster) {
    const days = byUnit.get(u);
    if (days?.has(date)) continue;
    const last = days ? [...days].sort().pop() ?? null : null;
    remaining.push({
      unit: u,
      last_checked_on: last,
      days_missing: last ? daysBetween(last, date) : 31,
    });
  }
  remaining.sort((a, b) => b.days_missing - a.days_missing);

  const streaks: Record<string, number> = {};
  for (const u of done) {
    const days = byUnit.get(u)!;
    let n = 0;
    let cursor = date;
    while (days.has(cursor)) {
      n++;
      cursor = addDays(cursor, -1);
    }
    streaks[u] = n;
  }

  return {
    date,
    count: done.length,
    done: campaign.units.length > 0
      ? campaign.units.filter((u) => done.includes(u))
      : done.sort(),
    remaining,
    target: campaign.target_count ?? (campaign.units.length > 0 ? campaign.units.length : null),
    streaks,
  };
}

// ข้อความสรุปปิดวัน ใช้ทั้งตอน cron ส่งเองและตอนมีคนขอดูกลางวัน
export function formatDaySummary(campaign: Campaign, s: DayStatus, opts: { closing?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`${opts.closing ? "📋 สรุปปิดวัน" : "📋 สถานะวันนี้"} ${campaign.name} — ${thaiDateLabel(s.date)}`);
  const denom = s.target ?? null;
  const pct = denom ? ` (${Math.round((s.count / denom) * 100)}%)` : "";
  lines.push(`แจ้งแล้ว ${s.count}${denom ? `/${denom}` : ""} ${campaign.units.length > 0 || denom ? "สาขา" : "รายการ"}${pct}`);
  if (s.done.length > 0) lines.push(`✅ ${s.done.join(" · ")}`);
  if (campaign.units.length > 0) {
    if (s.remaining.length === 0) lines.push("🎉 ครบทุกสาขา");
    else {
      lines.push(`⏳ ยังไม่แจ้ง ${s.remaining.length}: ${s.remaining.map((r) =>
        r.days_missing >= 2 && r.days_missing < 31 ? `${r.unit} (ขาด ${r.days_missing} วัน)` : r.unit
      ).join(" · ")}`);
    }
  }
  const hot = Object.entries(s.streaks).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (hot.length > 0) lines.push(`🔥 ต่อเนื่อง: ${hot.map(([u, n]) => `${u} ${n} วัน`).join(" · ")}`);
  return lines.join("\n");
}
