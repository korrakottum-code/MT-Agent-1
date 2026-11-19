import { assertEquals } from "jsr:@std/assert@1";
import { formatQueueThai, pickBranch, queueResult, summarize } from "./clinic_queue.ts";

const counts = (o: Record<string, number>) => ({
  total: 0, done: 0, noShow: 0, cancelled: 0, confirmed: 0, pending: 0, rescheduled: 0,
  newCustomers: 0, returningCustomers: 0, courseCustomers: 0, ...o,
});

const nov = {
  since: "2026-11-01", until: "2026-11-17",
  totals: counts({ total: 1000, done: 600, noShow: 150, cancelled: 50, rescheduled: 0, pending: 150, confirmed: 50, newCustomers: 400 }),
  branches: [
    { name: "บ่อวิน", ...counts({ total: 600, done: 400, noShow: 100, pending: 100 }) },
    { name: "นครราชสีมา", ...counts({ total: 400, done: 200, noShow: 50, cancelled: 50, pending: 50, confirmed: 50 }) },
  ],
};
const oct = {
  since: "2026-10-01", until: "2026-10-17",
  totals: counts({ total: 800, done: 560, noShow: 140, cancelled: 50, rescheduled: 50 }),
  branches: [],
};

Deno.test("อัตรามาจริงคิดจากคิวที่ปิดสถานะแล้ว ไม่ใช่คิวทั้งหมด", () => {
  const s = summarize(nov.totals);
  assertEquals(s.closed, 800);
  assertEquals(s.show_rate_pct, 75);
  assertEquals(s.not_closed_yet, 200);
});

Deno.test("เทียบช่วงก่อน ให้ทั้ง % คิวจองและจุดของอัตรามาจริง", () => {
  const r = queueResult(nov, oct, {});
  assertEquals(r.compare!.booked_change_pct, 25);
  assertEquals(r.compare!.summary.show_rate_pct, 70);
  assertEquals(r.compare!.show_rate_change_points, 5);
});

Deno.test("กรองสาขาเดียว และชื่อชนกันต้องถามกลับ", () => {
  assertEquals(pickBranch(nov, "บ่อวิน").name, "บ่อวิน");
  assertEquals(pickBranch(nov, "เชียงราย").error !== undefined, true);
  const r = queueResult(nov, null, { branch: "บ่อวิน" });
  assertEquals(r.summary.booked, 600);
  assertEquals(r.summary.show_rate_pct, 80);
});

Deno.test("ข้อความภาษาไทยบอกฐานของอัตรา", () => {
  const t = formatQueueThai(queueResult(nov, oct, {}));
  assertEquals(t.split("\n")[0], "คิว 1–17 พ.ย. 69 ทั้งเครือ");
  assertEquals(t.includes("มาจริง 600 (75.0%)"), true);
  assertEquals(t.includes("จอง 800 (+25.0%)"), true);
  assertEquals(t.includes("+5.0 จุด"), true);
});
