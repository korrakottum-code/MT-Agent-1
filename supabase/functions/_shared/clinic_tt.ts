// คูปอง TikTok (TT) ที่ลูกค้านำมาใช้หน้าร้าน สำหรับเครื่องมือ clinic_tt_coupons
//
// อ่านจาก class-tt-report ช่อง tt-coupon-stats ซึ่งอ่านตารางที่เก็บผลจาก POS ไว้ทุกเช้าตี 3
// นิยามเดียวกับอีเมลรายงานคูปองของตั้ม:
//   มูลค่าคูปอง = ราคาหน้าคูปองที่ลูกค้านำมาใช้ ไม่ใช่เงินสดที่สาขาได้
//   ยอดซื้อเพิ่ม = สินค้า/บริการอื่นในบิลเดียวกับคูปอง ไม่ใช่ยอดทั้งบิล
//   % = ยอดซื้อเพิ่ม ÷ มูลค่าคูปอง · ไม่นับบิลที่ยกเลิกและบัตรทดสอบ
// ไม่มีจำนวนลูกค้า (คน) เพราะข้อมูลที่เก็บไม่มีรหัสลูกค้า

import { baht, thaiDate, thaiRange } from "./clinic_sales.ts";

export type TTTotals = { coupons: number; bills: number; coupon_value: number; extra: number; extra_bills: number };
export type TTStats = {
  since: string; until: string; data_through: string | null; last_fetch_at: string | null;
  totals: TTTotals;
  branches: ({ code: string; name: string | null } & TTTotals)[];
  promos: { prefix: string; name: string; coupons: number; coupon_value: number; extra: number }[];
};

export type TTResult = {
  source: string;
  definitions: string;
  period: { from: string; to: string };
  data_through: string | null;
  totals: TTTotals & { extra_pct: number | null };
  compare?: { from: string; to: string; totals: TTTotals & { extra_pct: number | null }; extra_change_pct: number | null; coupons_change_pct: number | null };
  branch?: string;
  branches?: ({ name: string } & TTTotals & { extra_pct: number | null })[];
  promos?: { name: string; coupons: number; coupon_value: number; extra: number; extra_pct: number | null }[];
  note?: string;
};

const ratio = (a: number, b: number) => b > 0 ? Math.round((a / b) * 1000) / 10 : null;
const change = (a: number, b: number) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;
const withPct = <T extends TTTotals>(t: T) => ({ ...t, extra_pct: ratio(t.extra, t.coupon_value) });

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/^สาขา/, "");

export function pickTTBranch(s: TTStats, wanted: string): { row?: TTStats["branches"][number]; error?: string; choices?: string[] } {
  const w = norm(wanted);
  const label = (b: TTStats["branches"][number]) => b.name ?? b.code;
  const hit = s.branches.filter((b) => norm(label(b)) === w || b.code.toLowerCase() === w);
  const loose = hit.length ? hit : s.branches.filter((b) => norm(label(b)).includes(w) || w.includes(norm(label(b))));
  if (loose.length === 0) return { error: `ช่วงนี้ไม่มีคูปอง TT ที่สาขา "${wanted}" หรือไม่พบชื่อสาขานี้`, choices: s.branches.map(label) };
  if (loose.length > 1) return { error: `ชื่อ "${wanted}" ตรงหลายสาขา ให้ถามว่าหมายถึงสาขาไหน`, choices: loose.map(label) };
  return { row: loose[0] };
}

export function ttResult(cur: TTStats, prev: TTStats | null, opts: { branch?: string; byBranch?: boolean; byPromo?: boolean }): TTResult | { error: string; choices?: string[] } {
  const zero: TTTotals = { coupons: 0, bills: 0, coupon_value: 0, extra: 0, extra_bills: 0 };
  let pick = (s: TTStats): TTTotals => s.totals;
  let branchName: string | undefined;
  if (opts.branch) {
    const b = pickTTBranch(cur, opts.branch);
    if (b.error) return { error: b.error, choices: b.choices };
    branchName = b.row!.name ?? b.row!.code;
    const code = b.row!.code;
    pick = (s) => s.branches.find((x) => x.code === code) ?? zero;
  }
  const out: TTResult = {
    source: "รายงานคูปอง TT (ดึงจาก POS ทุกเช้าตี 3)",
    definitions:
      "coupon_value = ราคาหน้าคูปองที่ลูกค้านำมาใช้ ไม่ใช่เงินสด · extra = ยอดซื้อเพิ่มในบิลเดียวกับคูปอง ไม่ใช่ยอดทั้งบิล · " +
      "extra_pct = extra ÷ coupon_value · ไม่นับบิลยกเลิก · ไม่มีจำนวนลูกค้า (คน)",
    period: { from: cur.since, to: cur.until },
    data_through: cur.data_through,
    totals: withPct(pick(cur)),
  };
  if (branchName) out.branch = branchName;
  if (cur.data_through && cur.until > cur.data_through) {
    out.note = `ข้อมูลคูปองมีถึง ${cur.data_through} วันหลังจากนั้นยังไม่ได้ดึง`;
  }
  if (prev) {
    const p = withPct(pick(prev));
    out.compare = {
      from: prev.since, to: prev.until, totals: p,
      extra_change_pct: change(out.totals.extra, p.extra),
      coupons_change_pct: change(out.totals.coupons, p.coupons),
    };
  }
  if (opts.byBranch && !branchName) out.branches = cur.branches.map((b) => ({ ...withPct(b), name: b.name ?? b.code }));
  if (opts.byPromo) {
    out.promos = cur.promos.map((p) => ({ name: p.name, coupons: p.coupons, coupon_value: p.coupon_value, extra: p.extra, extra_pct: ratio(p.extra, p.coupon_value) }));
  }
  return out;
}

const fmt = (x: number) => Math.round(x).toLocaleString("en-US");
const pctText = (x: number | null) => x == null ? "-" : `${x.toFixed(1)}%`;
const signed = (x: number | null) => x == null ? "ไม่มีฐานเทียบ" : `${x > 0 ? "+" : ""}${x.toFixed(1)}%`;

export function formatTTThai(r: TTResult): string {
  const t = r.totals;
  const lines = [
    `คูปอง TikTok ${thaiRange(r.period)} ${r.branch ? `สาขา${r.branch}` : "ทั้งเครือ"}`,
    `ใช้ ${fmt(t.coupons)} ใบ · ${fmt(t.bills)} บิล · มูลค่าคูปอง ${baht(t.coupon_value)}`,
    `ซื้อเพิ่ม ${baht(t.extra)} (${pctText(t.extra_pct)} ของมูลค่าคูปอง) · บิลที่ซื้อเพิ่ม ${fmt(t.extra_bills)}`,
  ];
  if (r.compare) {
    const c = r.compare.totals;
    lines.push(`เทียบ ${thaiRange(r.compare)}: ใช้ ${fmt(c.coupons)} ใบ (${signed(r.compare.coupons_change_pct)}) · ซื้อเพิ่ม ${baht(c.extra)} (${signed(r.compare.extra_change_pct)})`);
  }
  if (r.branches?.length) {
    lines.push("");
    for (const b of r.branches) lines.push(`${b.name} ${fmt(b.coupons)} ใบ · ซื้อเพิ่ม ${baht(b.extra)} (${pctText(b.extra_pct)})`);
  }
  if (r.promos?.length) {
    lines.push("");
    for (const p of r.promos) lines.push(`${p.name} ${fmt(p.coupons)} ใบ · ซื้อเพิ่ม ${baht(p.extra)}`);
  }
  lines.push("");
  if (r.note) lines.push(r.note);
  else if (r.data_through) lines.push(`ข้อมูลถึง ${thaiDate(r.data_through)}`);
  lines.push("มูลค่าคูปองไม่ใช่เงินสด · ซื้อเพิ่ม = ของอื่นในบิลเดียวกับคูปอง · ที่มา: รายงานคูปอง TT จาก POS");
  return lines.join("\n");
}
