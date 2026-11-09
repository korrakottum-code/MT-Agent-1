import { assertEquals } from "jsr:@std/assert@1";
import { buildPeople, workReportDate } from "./work.ts";

const users = [{ id: "u1", display_name: "Viewww" }, { id: "u2", display_name: "ต๊อบ" }, { id: "u3", display_name: "แบม" }];
const groups = [{ id: "g1", group_name: "CM" }];
const NOW = new Date("2026-11-09T05:00:00Z").getTime();

Deno.test("รายงานหลังเที่ยงคืนนับเป็นงานของเมื่อวาน", () => {
  assertEquals(workReportDate("2026-11-06T15:17:00Z"), "2026-11-06"); // 22:17 ไทย
  assertEquals(workReportDate("2026-11-06T18:30:00Z"), "2026-11-06"); // 01:30 ไทยของวันที่ 7
  assertEquals(workReportDate("2026-11-06T23:30:00Z"), "2026-11-07"); // 06:30 ไทย
});

Deno.test("งานค้างเอาจากรายงานล่าสุดเท่านั้น ของที่เคยค้างในรายงานเก่าไม่นับ", () => {
  const [p] = buildPeople({
    users, groups, tasks: [], now: NOW,
    reports: [
      { user_id: "u1", written_name: "วิว", group_id: "g1", work_date: "2026-11-08", items: [{ text: "ตัดคลิป", state: "TODO" }] },
      { user_id: "u1", written_name: "วิว", group_id: "g1", work_date: "2026-11-07", items: [{ text: "ถ่ายรีวิว", state: "TODO" }, { text: "ลงช่อง", state: "DONE" }] },
    ],
  });
  assertEquals(p.name, "วิว");
  assertEquals(p.pending, ["ตัดคลิป"]);
  assertEquals(p.done, [{ date: "2026-11-07", text: "ลงช่อง" }]);
  assertEquals(p.report_days, 2);
  assertEquals(p.last_report_date, "2026-11-08");
});

Deno.test("ใบงานแยกค้างกับปิดแล้ว และจับเลยกำหนด", () => {
  const [p] = buildPeople({
    users, groups, reports: [], now: NOW,
    tasks: [
      { id: "t1", title: "บรีฟ", status: "BLOCKED", due_at: "2026-11-08T00:00:00Z", owner_user_id: "u2", created_by_user_id: "u1", group_id: "g1", blocked_reason: "รอไฟล์" },
      { id: "t2", title: "คลิป", status: "DOING", due_at: "2026-11-20T00:00:00Z", owner_user_id: "u2", created_by_user_id: "u1", group_id: "g1" },
      { id: "t3", title: "จบแล้ว", status: "DONE", owner_user_id: "u2", group_id: "g1" },
      { id: "t4", title: "ยกเลิก", status: "CANCELLED", owner_user_id: "u2", group_id: "g1" },
    ],
  });
  assertEquals(p.open_tasks.map((t: any) => [t.id, t.overdue, t.ordered_by]), [["t1", true, "Viewww"], ["t2", false, "Viewww"]]);
  assertEquals(p.closed_recent, 1);
});

Deno.test("เรียงตามชื่อ ไม่เรียงตามจำนวนงาน เพื่อไม่ให้กลายเป็นการจัดอันดับคน", () => {
  const people = buildPeople({
    users, groups, reports: [], now: NOW,
    tasks: [
      { id: "a", title: "x", status: "TODO", owner_user_id: "u2" },
      { id: "b", title: "y", status: "TODO", owner_user_id: "u3" },
      { id: "c", title: "z", status: "TODO", owner_user_id: "u3" },
    ],
  });
  assertEquals(people.map((p: any) => p.name), ["ต๊อบ", "แบม"].sort((a, b) => a.localeCompare(b, "th")));
});

Deno.test("คนที่ลาออกแล้วไม่โผล่", () => {
  const people = buildPeople({
    users, groups, now: NOW, tasks: [{ id: "a", title: "x", status: "TODO", owner_user_id: "gone" }],
    reports: [{ user_id: "gone", written_name: "เก่า", group_id: "g1", work_date: "2026-11-08", items: [] }],
  });
  assertEquals(people.length, 0);
});
