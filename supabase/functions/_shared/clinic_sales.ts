// ยอดขายสาขาของ Class Clinic สำหรับเครื่องมือ clinic_sales
//
// แหล่งเดียวที่ตั้มให้ใช้คือ data/sales.json ของแดชบอร์ด CEO (สร้างจาก Excel บน OneDrive ทุกเช้า)
// ห้ามเอายอดขายจาก Qlass มาแทน ไฟล์นี้ไม่มียอด TikTok Shop ซึ่งตั้มไม่ต้องการให้รวมอยู่แล้ว
// โครงไฟล์: months["YYYY-MM"][สาขา] = ยอดรายวัน ช่องที่ 0 คือวันที่ 1 ส่วน null คือยังไม่มีข้อมูลวันนั้น
//
// คิดเลขตรงนี้ทั้งหมด โมเดลแค่เอาผลไปพูด ตัวเลขที่แงวตอบจึงตรงกับแดชบอร์ดเป๊ะ ไม่ใช่โมเดลบวกเอง

export type SalesFile = {
  generatedAt?: string;
  months: Record<string, Record<string, (number | null)[]>>;
};

export type Range = { from: string; to: string };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

function* eachDay(r: Range): Generator<[string, number, string]> {
  let [y, m, d] = r.from.split("-").map(Number);
  for (let guard = 0; guard < 1200; guard++) {
    const day = iso(y, m, d);
    if (day > r.to) return;
    yield [`${y}-${pad(m)}`, d, day];
    d++;
    if (d > daysIn(y, m)) { d = 1; m++; if (m > 12) { m = 1; y++; } }
  }
}

// วันล่าสุดที่มีตัวเลขอย่างน้อยหนึ่งสาขา ใช้บอกว่าข้อมูลถึงวันไหน และตัดช่วงที่ขอเกินมา
export function lastDataDate(f: SalesFile): string | null {
  const months = Object.keys(f.months).sort().reverse();
  for (const ym of months) {
    let last = 0;
    for (const days of Object.values(f.months[ym])) {
      for (let i = days.length - 1; i >= last; i--) {
        if (typeof days[i] === "number") { last = i + 1; break; }
      }
    }
    if (last > 0) return `${ym}-${pad(last)}`;
  }
  return null;
}

export function firstDataDate(f: SalesFile): string | null {
  const first = Object.keys(f.months).sort()[0];
  return first ? `${first}-01` : null;
}

// เลื่อนช่วงไปหนึ่งเดือนก่อน วันเดียวกัน ถ้าเดือนก่อนสั้นกว่า (เช่น 31 มี.ค. → ก.พ.) ใช้วันสุดท้ายของเดือนนั้น
export function shiftMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return iso(ny, nm, Math.min(d, daysIn(ny, nm)));
}

export function sumRange(f: SalesFile, r: Range): { total: number; byBranch: Map<string, number>; daysWithData: number } {
  const byBranch = new Map<string, number>();
  let total = 0, daysWithData = 0;
  for (const [ym, d] of eachDay(r)) {
    const month = f.months[ym];
    if (!month) continue;
    let any = false;
    for (const [branch, days] of Object.entries(month)) {
      const v = days[d - 1];
      if (typeof v !== "number") continue;
      any = true;
      total += v;
      byBranch.set(branch, (byBranch.get(branch) ?? 0) + v);
    }
    if (any) daysWithData++;
  }
  return { total, byBranch, daysWithData };
}

// ชื่อที่ทีมเรียกไม่ตรงกับชื่อในไฟล์ ใส่เฉพาะที่เห็นจริง ชื่ออื่นใช้การค้นแบบมีคำนี้อยู่
const BRANCH_ALIASES: Record<string, string[]> = {
  "นครราชสีมา": ["โคราช"],
  "หอกาญ": ["หอกาญจน์", "หอการค้า"],
  "อุดรธานี": ["อุดร"],
  "อุบลราชธานี": ["อุบล"],
  "ฟิวเจอร์พาร์ครังสิต": ["รังสิต", "ฟิวเจอร์"],
  "ยูเนี่ยนมอลล์ลาดพร้าว": ["ลาดพร้าว", "ยูเนี่ยน"],
  "ฉะเชิงเทรา": ["แปดริ้ว"],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/^สาขา/, "");

export function matchBranch(names: string[], wanted: string): string[] {
  const w = norm(wanted);
  if (!w) return [];
  const exact = names.filter((n) => norm(n) === w);
  if (exact.length) return exact;
  return names.filter((n) => {
    const nn = norm(n);
    if (nn.includes(w) || w.includes(nn)) return true;
    return (BRANCH_ALIASES[n] ?? []).some((a) => norm(a) === w || w.includes(norm(a)));
  });
}

export type SalesInput = {
  date_from?: string;
  date_to?: string;
  compare?: "previous_month" | "previous_year" | "none" | "custom";
  compare_from?: string;
  compare_to?: string;
  branch?: string;
  by_branch?: boolean;
};

export type SalesResult = {
  source: string;
  data_through: string | null;
  period: Range & { days_with_data: number; clipped_to_data: boolean };
  total: number;
  avg_per_day: number | null;
  branch?: string;
  compare?: Range & { days_with_data: number; total: number; change: number; change_pct: number | null };
  branches?: { name: string; total: number; compare_total?: number; change_pct?: number | null }[];
  note?: string;
};

const pct = (cur: number, prev: number) => prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function salesQuery(f: SalesFile, input: SalesInput): SalesResult | { error: string; choices?: string[] } {
  const through = lastDataDate(f);
  if (!through) return { error: "ไฟล์ยอดขายว่าง ยังไม่มีข้อมูลสักวัน" };
  const from = input.date_from, to = input.date_to ?? input.date_from;
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: "ต้องใส่ date_from และ date_to เป็น YYYY-MM-DD แบบ ค.ศ." };
  if (from > to) return { error: "date_from ต้องไม่หลัง date_to" };
  if (from > through) {
    return { error: `ยอดขายในไฟล์มีถึงวันที่ ${through} เท่านั้น ช่วงที่ถามยังไม่มีข้อมูล` };
  }
  const earliest = firstDataDate(f)!;
  if (to < earliest) return { error: `ไฟล์ยอดขายเริ่มที่ ${earliest} ช่วงที่ถามเก่ากว่านั้น` };

  // ขอเกินวันที่มีข้อมูล ตัดให้จบที่วันล่าสุด แล้วให้ช่วงเทียบยาวเท่ากัน ไม่งั้นเทียบ 17 วันกับ 30 วัน
  const clipped = to > through;
  const period: Range = { from, to: clipped ? through : to };

  // กรองสาขา
  const allNames = [...new Set(Object.values(f.months).flatMap((m) => Object.keys(m)))];
  let only: string | null = null;
  if (input.branch) {
    const hit = matchBranch(allNames, input.branch);
    if (hit.length === 0) return { error: `ไม่พบสาขา "${input.branch}" ในไฟล์ยอดขาย`, choices: allNames.sort() };
    if (hit.length > 1) return { error: `ชื่อ "${input.branch}" ตรงหลายสาขา ให้ถามว่าหมายถึงสาขาไหน`, choices: hit };
    only = hit[0];
  }

  const cur = sumRange(f, period);
  const pick = (s: ReturnType<typeof sumRange>) => only ? (s.byBranch.get(only) ?? 0) : s.total;

  const out: SalesResult = {
    source: "ไฟล์ยอดขาย Excel ที่แดชบอร์ด CEO ใช้ (ไม่รวม TikTok Shop)",
    data_through: through,
    period: { ...period, days_with_data: cur.daysWithData, clipped_to_data: clipped },
    total: r2(pick(cur)),
    avg_per_day: cur.daysWithData ? r2(pick(cur) / cur.daysWithData) : null,
  };
  if (only) out.branch = only;

  let cmpRange: Range | null = null;
  const mode = input.compare ?? (input.compare_from ? "custom" : "none");
  if (mode === "previous_month") cmpRange = { from: shiftMonths(period.from, -1), to: shiftMonths(period.to, -1) };
  else if (mode === "previous_year") cmpRange = { from: shiftMonths(period.from, -12), to: shiftMonths(period.to, -12) };
  else if (mode === "custom") {
    if (!isIsoDate(input.compare_from) || !isIsoDate(input.compare_to ?? input.compare_from)) {
      return { error: "compare=custom ต้องใส่ compare_from และ compare_to เป็น YYYY-MM-DD" };
    }
    cmpRange = { from: input.compare_from!, to: input.compare_to ?? input.compare_from! };
  }

  let prev: ReturnType<typeof sumRange> | null = null;
  if (cmpRange) {
    prev = sumRange(f, cmpRange);
    const p = pick(prev);
    out.compare = {
      ...cmpRange, days_with_data: prev.daysWithData, total: r2(p),
      change: r2(pick(cur) - p), change_pct: pct(pick(cur), p),
    };
    if (prev.daysWithData === 0) out.note = "ช่วงที่เอามาเทียบไม่มีข้อมูลในไฟล์ยอดขาย";
  }

  if (input.by_branch && !only) {
    out.branches = [...cur.byBranch.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => {
        const row: NonNullable<SalesResult["branches"]>[number] = { name, total: r2(total) };
        if (prev) {
          const p = prev.byBranch.get(name) ?? 0;
          row.compare_total = r2(p);
          row.change_pct = pct(total, p);
        }
        return row;
      });
  }
  return out;
}

// ---- ข้อความภาษาไทยที่ส่งเข้าแชทส่วนตัว (ตอนถูกถามในกลุ่ม) ไม่ผ่านโมเดล ตัวเลขจึงไม่เพี้ยน ----

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export function thaiDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, "0")}`;
}

export function thaiRange(r: Range): string {
  if (r.from === r.to) return thaiDate(r.from);
  const [fy, fm, fd] = r.from.split("-").map(Number);
  const [ty, tm] = r.to.split("-").map(Number);
  if (fy === ty && fm === tm) return `${fd}–${thaiDate(r.to)}`;
  return `${thaiDate(r.from)} – ${thaiDate(r.to)}`;
}

export const baht = (n: number) => "฿" + Math.round(n).toLocaleString("en-US");
const signedPct = (p: number | null | undefined) => p == null ? "ไม่มีฐานเทียบ" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

export function formatSalesThai(r: SalesResult): string {
  const lines: string[] = [];
  lines.push(`ยอดขาย ${thaiRange(r.period)} ${r.branch ? `สาขา${r.branch}` : "ทั้งเครือ"}`);
  lines.push(baht(r.total));
  if (r.compare) {
    lines.push(`เทียบ ${thaiRange(r.compare)}: ${baht(r.compare.total)} (${signedPct(r.compare.change_pct)})`);
  }
  if (r.branches?.length) {
    lines.push("");
    for (const b of r.branches) {
      lines.push(`${b.name} ${baht(b.total)}${b.compare_total !== undefined ? ` (${signedPct(b.change_pct)})` : ""}`);
    }
  }
  lines.push("");
  if (r.period.clipped_to_data) lines.push(`ข้อมูลมีถึง ${thaiDate(r.data_through!)} จึงนับถึงวันนั้น`);
  if (r.note) lines.push(r.note);
  lines.push("ที่มา: ไฟล์ยอดขาย Excel ของแดชบอร์ด CEO ไม่รวม TikTok Shop");
  return lines.join("\n");
}
