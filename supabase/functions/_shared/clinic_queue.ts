// คิวของ Class Clinic จาก Qlass สำหรับเครื่องมือ clinic_queues
//
// อ่านผ่าน external-queue-stats ของ Qlass ซึ่งรวมยอดใน SQL แล้ว ไม่มีชื่อ เบอร์ หรือราคาของลูกค้าออกมาเลย
// เป็นช่องเดียวกับที่แดชบอร์ด CEO ใช้ ตัวเลขจึงตรงกัน
//
// ข้อควรระวังที่เคยพลาดมาแล้ว: เทียบคิวสองช่วงตรง ๆ ไม่ได้ เพราะคิวที่ยังไม่ปิดสถานะ (pending/confirmed)
// จะถูกปิดย้อนหลังทีหลัง ช่วงที่ใหม่กว่าจึงดู "มาจริง" น้อยเกินจริงเสมอ
// อัตรามาจริง ไม่มา ยกเลิก จึงคิดบนฐานคิวที่ปิดสถานะแล้วเท่านั้น (done + noShow + cancelled + rescheduled)
// ส่วนจำนวนคิวที่จองนับตอนจอง ไม่ขึ้นกับการปิดสถานะ เทียบตรง ๆ ได้

import { thaiRange } from "./clinic_sales.ts";

export type QueueCounts = {
  total: number; done: number; noShow: number; cancelled: number; confirmed: number;
  pending: number; rescheduled: number; newCustomers: number; returningCustomers: number; courseCustomers: number;
};

export type QueueStats = {
  since: string; until: string;
  totals: QueueCounts;
  branches: (QueueCounts & { name: string })[];
};

export type QueueSummary = {
  booked: number;
  done: number; no_show: number; cancelled: number; rescheduled: number;
  not_closed_yet: number;           // pending + confirmed ยังไม่รู้ผล
  closed: number;                   // ฐานของอัตรา
  show_rate_pct: number | null;     // มาจริง ÷ คิวที่ปิดแล้ว
  no_show_rate_pct: number | null;
  cancel_rate_pct: number | null;
  new_customers: number; returning_customers: number; course_customers: number;
};

const n = (x: unknown) => typeof x === "number" ? x : 0;
const rate = (part: number, base: number) => base === 0 ? null : Math.round((part / base) * 1000) / 10;

export function summarize(c: Partial<QueueCounts>): QueueSummary {
  const done = n(c.done), noShow = n(c.noShow), cancelled = n(c.cancelled), rescheduled = n(c.rescheduled);
  const closed = done + noShow + cancelled + rescheduled;
  return {
    booked: n(c.total),
    done, no_show: noShow, cancelled, rescheduled,
    not_closed_yet: n(c.pending) + n(c.confirmed),
    closed,
    show_rate_pct: rate(done, closed),
    no_show_rate_pct: rate(noShow, closed),
    cancel_rate_pct: rate(cancelled, closed),
    new_customers: n(c.newCustomers), returning_customers: n(c.returningCustomers), course_customers: n(c.courseCustomers),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/^สาขา/, "");

export function matchQueueBranch(names: string[], wanted: string): string[] {
  const w = norm(wanted);
  if (!w) return [];
  const exact = names.filter((x) => norm(x) === w);
  if (exact.length) return exact;
  return names.filter((x) => norm(x).includes(w) || w.includes(norm(x)));
}

export type QueueResult = {
  source: string;
  period: { from: string; to: string };
  branch?: string;
  summary: QueueSummary;
  compare?: { from: string; to: string; summary: QueueSummary; booked_change_pct: number | null; show_rate_change_points: number | null };
  branches?: ({ name: string } & QueueSummary)[];
  how_to_read: string;
};

const pct = (cur: number, prev: number) => prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10;

export function pickBranch(stats: QueueStats, wanted: string): { name?: string; error?: string; choices?: string[] } {
  const names = stats.branches.map((b) => b.name);
  const hit = matchQueueBranch(names, wanted);
  if (hit.length === 0) return { error: `ไม่พบสาขา "${wanted}" ในระบบคิว`, choices: names.sort() };
  if (hit.length > 1) return { error: `ชื่อ "${wanted}" ตรงหลายสาขา ให้ถามว่าหมายถึงสาขาไหน`, choices: hit };
  return { name: hit[0] };
}

export function queueResult(
  cur: QueueStats, prev: QueueStats | null, opts: { branch?: string; byBranch?: boolean },
): QueueResult {
  const counts = (s: QueueStats) => opts.branch ? (s.branches.find((b) => b.name === opts.branch) ?? {}) : s.totals;
  const now = summarize(counts(cur));
  const out: QueueResult = {
    source: "ระบบคิว Qlass (ยอดรวม ไม่มีข้อมูลลูกค้า)",
    period: { from: cur.since, to: cur.until },
    summary: now,
    how_to_read:
      "booked = คิวที่จองในช่วงนั้น (นับตามวันนัด) · อัตรามาจริง/ไม่มา/ยกเลิก คิดจากคิวที่ปิดสถานะแล้วเท่านั้น " +
      "not_closed_yet = คิวที่ยังไม่ปิดสถานะ จะถูกปิดย้อนหลังทีหลัง จึงห้ามเอาจำนวน done ดิบสองช่วงมาเทียบกัน ให้เทียบอัตราแทน",
  };
  if (opts.branch) out.branch = opts.branch;
  if (prev) {
    const before = summarize(counts(prev));
    out.compare = {
      from: prev.since, to: prev.until, summary: before,
      booked_change_pct: pct(now.booked, before.booked),
      show_rate_change_points: now.show_rate_pct == null || before.show_rate_pct == null
        ? null : Math.round((now.show_rate_pct - before.show_rate_pct) * 10) / 10,
    };
  }
  if (opts.byBranch && !opts.branch) {
    out.branches = cur.branches.map((b) => ({ name: b.name, ...summarize(b) })).sort((a, b) => b.booked - a.booked);
  }
  return out;
}

// ---- ข้อความภาษาไทยที่ส่งเข้าแชทส่วนตัว ----

const fmt = (x: number) => x.toLocaleString("en-US");
const p1 = (x: number | null) => x == null ? "-" : `${x.toFixed(1)}%`;
const signed = (x: number | null, unit: string) => x == null ? "ไม่มีฐานเทียบ" : `${x > 0 ? "+" : ""}${x.toFixed(1)}${unit}`;

export function formatQueueThai(r: QueueResult): string {
  const s = r.summary;
  const lines = [
    `คิว ${thaiRange(r.period)} ${r.branch ? `สาขา${r.branch}` : "ทั้งเครือ"}`,
    `จอง ${fmt(s.booked)} คิว (ลูกค้าใหม่ ${fmt(s.new_customers)})`,
    `ปิดสถานะแล้ว ${fmt(s.closed)}: มาจริง ${fmt(s.done)} (${p1(s.show_rate_pct)}) · ไม่มา ${fmt(s.no_show)} (${p1(s.no_show_rate_pct)}) · ยกเลิก ${fmt(s.cancelled)} · เลื่อน ${fmt(s.rescheduled)}`,
    `ยังไม่ปิดสถานะ ${fmt(s.not_closed_yet)}`,
  ];
  if (r.compare) {
    const c = r.compare.summary;
    lines.push(
      `เทียบ ${thaiRange(r.compare)}: จอง ${fmt(c.booked)} (${signed(r.compare.booked_change_pct, "%")}) · ` +
        `มาจริง ${p1(c.show_rate_pct)} (${signed(r.compare.show_rate_change_points, " จุด")})`,
    );
  }
  if (r.branches?.length) {
    lines.push("");
    for (const b of r.branches) lines.push(`${b.name} จอง ${fmt(b.booked)} · มาจริง ${p1(b.show_rate_pct)}`);
  }
  lines.push("", "อัตรามาจริงคิดจากคิวที่ปิดสถานะแล้ว · ที่มา: ระบบคิว Qlass");
  return lines.join("\n");
}
