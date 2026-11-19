import { assertEquals } from "jsr:@std/assert@1";
import { formatTTThai, ttResult, type TTStats } from "./clinic_tt.ts";

const t = (coupons: number, bills: number, cv: number, extra: number, eb: number) =>
  ({ coupons, bills, coupon_value: cv, extra, extra_bills: eb });

const nov: TTStats = {
  since: "2026-11-01", until: "2026-11-17", data_through: "2026-11-19", last_fetch_at: null,
  totals: t(100, 80, 50000, 10000, 20),
  branches: [
    { code: "BW", name: "บ่อวิน", ...t(60, 50, 30000, 9000, 15) },
    { code: "KR", name: "นครราชสีมา", ...t(40, 30, 20000, 1000, 5) },
  ],
  promos: [{ prefix: "TT012_D6", name: "Drip ผิว 89", coupons: 70, coupon_value: 6230, extra: 7000 }],
};
const oct: TTStats = { ...nov, since: "2026-10-01", until: "2026-10-17", totals: t(50, 40, 25000, 5000, 10), branches: [], promos: [] };

Deno.test("% ซื้อเพิ่มคิดจากมูลค่าคูปอง และเทียบช่วงก่อน", () => {
  const r: any = ttResult(nov, oct, {});
  assertEquals(r.totals.extra_pct, 20);
  assertEquals(r.compare.extra_change_pct, 100);
  assertEquals(r.compare.coupons_change_pct, 100);
});

Deno.test("สาขาเดียว ใช้ตัวเลขของสาขานั้น ช่วงก่อนไม่มีสาขานี้ = ศูนย์", () => {
  const r: any = ttResult(nov, oct, { branch: "บ่อวิน" });
  assertEquals(r.branch, "บ่อวิน");
  assertEquals(r.totals.extra, 9000);
  assertEquals(r.compare.totals.coupons, 0);
  assertEquals(r.compare.coupons_change_pct, null);
});

Deno.test("ชื่อสาขาไม่พบต้องบอก ไม่คืนศูนย์", () => {
  const r: any = ttResult(nov, null, { branch: "เชียงราย" });
  assertEquals(typeof r.error, "string");
});

Deno.test("ข้อความไทยบอกว่ามูลค่าคูปองไม่ใช่เงินสด", () => {
  const text = formatTTThai(ttResult(nov, oct, {}) as any);
  assertEquals(text.split("\n")[0], "คูปอง TikTok 1–17 พ.ย. 69 ทั้งเครือ");
  assertEquals(text.includes("ใช้ 100 ใบ · 80 บิล · มูลค่าคูปอง ฿50,000"), true);
  assertEquals(text.includes("ซื้อเพิ่ม ฿10,000 (20.0% ของมูลค่าคูปอง)"), true);
  assertEquals(text.includes("ไม่ใช่เงินสด"), true);
});
