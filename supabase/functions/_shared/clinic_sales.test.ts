import { assertEquals } from "jsr:@std/assert@1";
import { formatSalesThai, lastDataDate, matchBranch, salesQuery, shiftMonths, thaiRange } from "./clinic_sales.ts";

const f = {
  months: {
    "2026-02": { "หอกาญ": [10, 10, ...Array(26).fill(10)], "นครราชสีมา": Array(28).fill(5) },
    "2026-03": { "หอกาญ": Array(31).fill(20), "นครราชสีมา": Array(31).fill(1) },
    "2026-04": {
      "หอกาญ": [100, 200, 300, null, null, ...Array(25).fill(null)],
      "นครราชสีมา": [10, 20, null, null, ...Array(26).fill(null)],
      "Class go โคราช": [1, 1, 1, ...Array(27).fill(null)],
    },
  },
};

Deno.test("วันล่าสุดที่มีข้อมูลดูจากทุกสาขา ไม่ใช่สาขาแรก", () => {
  assertEquals(lastDataDate(f), "2026-04-03");
});

Deno.test("เลื่อนเดือนแล้ววันเกินให้ใช้วันสุดท้ายของเดือน", () => {
  assertEquals(shiftMonths("2026-03-31", -1), "2026-02-28");
  assertEquals(shiftMonths("2026-01-15", -1), "2025-12-15");
  assertEquals(shiftMonths("2026-11-17", -12), "2025-11-17");
});

Deno.test("รวมทั้งเครือแล้วเทียบเดือนก่อนวันเดียวกัน", () => {
  const r: any = salesQuery(f, { date_from: "2026-04-01", date_to: "2026-04-03", compare: "previous_month" });
  assertEquals(r.total, 100 + 200 + 300 + 10 + 20 + 3);
  assertEquals(r.compare.from, "2026-03-01");
  assertEquals(r.compare.to, "2026-03-03");
  assertEquals(r.compare.total, 63);
  assertEquals(r.period.clipped_to_data, false);
});

Deno.test("ขอเกินวันที่มีข้อมูล ตัดให้จบวันล่าสุดทั้งช่วงหลักและช่วงเทียบ", () => {
  const r: any = salesQuery(f, { date_from: "2026-04-01", date_to: "2026-04-30", compare: "previous_month" });
  assertEquals(r.period.to, "2026-04-03");
  assertEquals(r.period.clipped_to_data, true);
  assertEquals(r.compare.to, "2026-03-03");
  assertEquals(r.data_through, "2026-04-03");
});

Deno.test("ถามช่วงที่ยังไม่มีข้อมูลเลย ต้องบอกตรง ๆ ไม่คืนศูนย์", () => {
  const r: any = salesQuery(f, { date_from: "2026-04-10", date_to: "2026-04-12" });
  assertEquals(typeof r.error, "string");
});

Deno.test("ชื่อเล่นสาขาที่ตรงหลายที่ต้องถามกลับ ไม่เลือกเอง", () => {
  const names = ["หอกาญ", "นครราชสีมา", "Class go โคราช"];
  assertEquals(matchBranch(names, "โคราช").sort(), ["Class go โคราช", "นครราชสีมา"].sort());
  assertEquals(matchBranch(names, "หอกาญจน์"), ["หอกาญ"]);
  assertEquals(matchBranch(names, "สาขานครราชสีมา"), ["นครราชสีมา"]);
  const r: any = salesQuery(f, { date_from: "2026-04-01", date_to: "2026-04-03", branch: "โคราช" });
  assertEquals(r.choices.length, 2);
});

Deno.test("ข้อความภาษาไทยมีช่วง ยอด และเปอร์เซ็นต์", () => {
  const r: any = salesQuery(f, { date_from: "2026-04-01", date_to: "2026-04-03", compare: "previous_month" });
  const text = formatSalesThai(r);
  assertEquals(text.split("\n")[0], "ยอดขาย 1–3 เม.ย. 69 ทั้งเครือ");
  assertEquals(text.includes("฿633"), true);
  assertEquals(text.includes("เทียบ 1–3 มี.ค. 69: ฿63 (+904.8%)"), true);
  assertEquals(thaiRange({ from: "2026-10-30", to: "2026-11-02" }), "30 ต.ค. 69 – 2 พ.ย. 69");
});
