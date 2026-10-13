import { assertEquals } from "jsr:@std/assert@1";
import { dropToolNames, looksLikeLeakedReasoning, scrubToolNames } from "./leak_guard.ts";

// ข้อความที่หลุดไปถึงลูกค้าจริง ตัดมาเฉพาะส่วนที่ทำให้รู้ว่าเป็นบันทึกความคิด
const LEAK_21_SEP = `ผู้ใช้ต้องการให้ "จดจำอัพเดทงานหน่อย" พร้อมลิสต์รายการ 7 ข้อ
ตามกฎของระบบ:
กฎ "ก่อนจะเก็บเรื่องไหนไปเป็นประเด็น ข้อสรุป หรือสร้างงาน ให้ถามยืนยันก่อนเสมอ" (ใน System Prompt ระบุว่า: ...)
และ กฎ 1.1 ห้ามใช้ markdown เด็ดขาด
เขียนตอบอย่างน่ารัก เป็นกันเอง น่าเชื่อถือตามบุคลิกแงว
แงวรับทราบและสรุปรายการอัปเดตงานทั้ง 7 ข้อไว้ให้ตามนี้เลยค่า 📝✨`;

const LEAK_12_OCT = `ตั้มสั่ง: "ฝากปิดแอด gmv live ที่เปิดไว้ใน em ให้หน่อยครับ"

วิเคราะห์:
ตั้มสั่งปิดแอดใน Facebook Ads ซึ่งแงวไม่มีสิทธิ์ (ระบบมี monday, task, reminder แต่ไม่มี Facebook Ads API)
ถ้าพูดกับแงว: แงวเข้าไปกดปิดแอดให้ไม่ได้จริง ๆ เพราะไม่มี tool หรือสิทธิ์เข้าถึง
ตามกฎ:
2.3 ห้ามรับปากอนาคตที่คุณทำไม่ได้
เขียนข้อความให้เป็นกันเอง สุภาพ น่ารัก ตามคาแรคเตอร์
พี่ตั้มค้าบ แงวเข้าไปกดปิดแอดใน Ads Manager/EM ให้โดยตรงไม่ได้น้า 🥺`;

Deno.test("จับบันทึกความคิดที่หลุดไปถึงลูกค้าจริงได้ทั้งสองครั้ง", () => {
  assertEquals(looksLikeLeakedReasoning(LEAK_21_SEP), true);
  assertEquals(looksLikeLeakedReasoning(LEAK_12_OCT), true);
});

Deno.test("คำตอบปกติไม่โดนจับ", () => {
  const normal = [
    "สรุปจำนวนงานเฉพาะของวันนี้ (28 ก.ย. 69) ค่า 🐱✨\n\n🎬 แบม (คลิปวิดีโอ)\nส่งคลิปวิดีโอแล้ว 1 คลิปงับ",
    "⏰ ออฟ ขอกราฟฟิกพิโค่ 2190",
    "ตั้งเตือนให้เรียบร้อยแล้วค่าพี่ออฟ ⏰\n\nรายการเตือน: ขอกราฟฟิกพิโค่ 2190\nเวลา: พฤหัสที่ 15 ต.ค. 10:00 น.",
    "แงวเข้าไปกดปิดแอดให้ไม่ได้น้า ให้แงวตั้งเตือนพี่ Thong แทนไหมคะ",
  ];
  for (const t of normal) assertEquals(looksLikeLeakedReasoning(t), false, t);
});

Deno.test("หัวข้อวิเคราะห์ในรายงานจริงหัวข้อเดียวไม่นับว่ารั่ว", () => {
  // รายงานผลแอดมีหัวข้อ "วิเคราะห์:" ได้ตามปกติ ต้องเจอเครื่องหมายอื่นด้วยถึงจะนับ
  const report = "ยอดแอดสัปดาห์นี้\n1. คลิก 1,240\n2. ทัก 86\n\nวิเคราะห์:\nต้นทุนต่อทักลดลง 12% จากสัปดาห์ก่อน";
  assertEquals(looksLikeLeakedReasoning(report), false);
});

const NAMES = ["create_reminder", "list_reminders", "remember_preference", "register_user", "rename_group", "create_task"];

Deno.test("ลบชื่อเครื่องมือในวงเล็บทิ้ง ความหมายไม่เสีย", () => {
  const r = scrubToolNames("แงวเช็กระบบเตือน (list_reminders) ให้แล้วค่ะ\nตั้งเตือนล่วงหน้า (create_reminder) ได้เลย", NAMES);
  assertEquals(r.text, "แงวเช็กระบบเตือน ให้แล้วค่ะ\nตั้งเตือนล่วงหน้า ได้เลย");
  assertEquals(r.bare, []);
  const r2 = scrubToolNames("จำไว้แล้วค่า (`remember_preference`, create_task) ✨", NAMES);
  assertEquals(r2.text, "จำไว้แล้วค่า ✨");
});

Deno.test("ชื่อกลางประโยคส่งต่อให้รอบเขียนใหม่", () => {
  const r = scrubToolNames("ลงทะเบียนชื่อด้วยคำสั่ง register_user ได้เลยค่ะ", NAMES);
  assertEquals(r.bare, ["register_user"]);
  assertEquals(dropToolNames(r.text, r.bare), "ลงทะเบียนชื่อ ได้เลยค่ะ");
});

Deno.test("คำที่บังเอิญมีชื่อเครื่องมือเป็นส่วนหนึ่งไม่โดน", () => {
  const t = "ลิงก์ https://x.com/?create_task=1 กับ my_create_task_v2 กับ create_tasks";
  const r = scrubToolNames(t, NAMES);
  assertEquals(r.text, t);
  assertEquals(r.bare, []);
});
