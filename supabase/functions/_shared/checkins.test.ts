// ข้อสอบของส่วนนับเช็กชื่อ รันได้โดยไม่ต้องต่อฐานข้อมูล: deno test supabase/functions/_shared/checkins.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { type Campaign, dayStatus, formatDaySummary, matchUnit, unitKey } from "./checkins.ts";

// ฐานข้อมูลจำลอง รับเฉพาะ query ที่ dayStatus ใช้จริง
function fakeDb(rows: { unit: string; checked_on: string }[]) {
  return {
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (_k: string, _v: unknown) => ({
          gte: (_k2: string, since: string) => ({
            lte: (_k3: string, until: string) =>
              Promise.resolve({ data: rows.filter((r) => r.checked_on >= since && r.checked_on <= until) }),
          }),
        }),
      }),
    }),
  };
}

const campaign: Campaign = {
  id: "c1", chat_id: "g1", name: "ลงสตอรี่ PDRN",
  units: ["เชียงราย", "ลาดกระบัง", "บ่อวิน", "หอกาญจน์", "บางแสน"],
  target_count: null, summary_time: "18:00", active: true, last_summary_on: null,
};

Deno.test("ชื่อสาขาที่พิมพ์ต่างกันต้องเป็นตัวเดียวกัน แต่ห้ามเดาเมื่อคลุมเครือ", () => {
  assertEquals(unitKey("สาขาบ่อวิน "), unitKey("บ่อวิน"));
  assertEquals(unitKey("Class Go บางแสน"), unitKey("บางแสน"));
  assertEquals(matchUnit("สาขาหอกาญ", campaign.units).unit, "หอกาญจน์");
  assertEquals(matchUnit("บ่อวินค่ะ", campaign.units).unit, "บ่อวิน");
  // ไม่มีในรายชื่อ ต้องคืนตัวเลือกว่าง ไม่ใช่เดาเป็นสาขาใกล้เคียง
  assertEquals(matchUnit("อุดร", campaign.units).unit, undefined);
  // ไม่มีรายชื่อกำหนดไว้ จดตามที่พิมพ์ ตัดคำว่าสาขาออก
  assertEquals(matchUnit("สาขาอุดร", []).unit, "อุดร");
});

Deno.test("นับจากแถวจริง: ใครแล้ว ใครยัง ขาดมากี่วัน ต่อเนื่องกี่วัน", async () => {
  const db = fakeDb([
    { unit: "เชียงราย", checked_on: "2026-09-17" },
    { unit: "เชียงราย", checked_on: "2026-09-18" },
    { unit: "เชียงราย", checked_on: "2026-09-19" },
    { unit: "ลาดกระบัง", checked_on: "2026-09-19" },
    { unit: "บ่อวิน", checked_on: "2026-09-16" },
  ]);
  const s = await dayStatus(db, campaign, "2026-09-19");
  assertEquals(s.count, 2);
  assertEquals(s.done, ["เชียงราย", "ลาดกระบัง"]);
  assertEquals(s.streaks["เชียงราย"], 3);
  assertEquals(s.streaks["ลาดกระบัง"], 1);
  assertEquals(s.target, 5);
  // ขาดนานสุดขึ้นก่อน: หอกาญจน์กับบางแสนไม่เคยแจ้งเลย (31) แล้วค่อยบ่อวินที่ขาด 3 วัน
  assertEquals(s.remaining.map((r) => r.unit).slice(-1), ["บ่อวิน"]);
  assertEquals(s.remaining.find((r) => r.unit === "บ่อวิน")?.days_missing, 3);
  const text = formatDaySummary(campaign, s, { closing: true });
  assertEquals(text.includes("แจ้งแล้ว 2/5 สาขา (40%)"), true);
  assertEquals(text.includes("🔥 ต่อเนื่อง: เชียงราย 3 วัน"), true);
  assertEquals(text.includes("บ่อวิน (ขาด 3 วัน)"), true);
});
