# ความคืบหน้าตามแผน (docs/BUILD_GUIDE.md)

อัปเดตล่าสุด: 1 ก.ย. 2026 19:10 — ข้อสอบผ่าน 8/8 (หลังเพิ่มการอ่านไฟล์เอกสาร, deploy v22)

## ภาพรวม

| เป้าหมายตามคู่มือ | ความคืบหน้า | สถานะ |
|---|---|---|
| Phase 1–12 (ลำดับการสร้างข้อ 1–17) | 100% | เสร็จ |
| MVP 0.1 — AI องค์กรใช้งานได้จริง | 100% | เสร็จ |
| MVP 0.2 — เพิ่ม Intelligence | 60% | กำลังทำ |
| MVP 0.3 — Corporate Memory | 0% | ยังไม่เริ่ม (รอใช้งานจริงสะสมข้อมูล) |
| MVP 0.4 — AI Analyst | 0% | ยังไม่เริ่ม |
| MVP 1.0 — AI Organization | ~13% | ยังไม่เริ่มจริงจัง |

**ถึงเป้าหมายปลายทาง (MVP 1.0) ประมาณ 32%**

## MVP 0.1 — 11/11 ข้อ (100%)

- [x] LINE OA เข้า Group ได้
- [x] `@AI` แล้วตอบ
- [x] Identity ใช้งานจริง
- [x] สร้าง Task ผ่านภาษาปกติ
- [x] ดู Task ตัวเอง
- [x] ดู Task คนอื่นตาม Permission (ยืนยันด้วยข้อสอบ permission-block)
- [x] Update Task
- [x] Summary Group
- [x] Query Metrics ง่าย ๆ
- [x] Audit Log
- [x] ไม่มีข้อมูลสำคัญเก็บอยู่ใน LLM Memory เพียงอย่างเดียว

## MVP 0.2 — 6/10 ข้อ (60%)

- [ ] Event Extraction ← แม่ของอีก 3 ข้อล่าง
- [ ] Auto Task Detection
- [ ] Decision Detection
- [ ] Deadline Detection
- [x] Daily Summary อัตโนมัติ (18:00 ทุกวัน)
- [x] Weekly Summary (จันทร์ 09:00)
- [x] Search Message
- [x] Search Task
- [x] Task Reminder
- [x] Overdue Alert

## MVP 1.0 — 1.8/14 ข้อ (~13%)

- [x] Corporate Search (บางส่วน — ค้นข้อความข้ามกลุ่มได้ + อ่านเอกสารที่ส่งเข้ามาได้ ยังไม่ทำดัชนีเอกสารให้ค้นย้อนหลัง)
- [x] Admin Console (บางส่วน — จัดการผ่านแชทได้ ยังไม่มีหน้าจอ)
- [ ] CEO Mode / Manager Mode / Marketing Agent / Data Analyst Agent / HR Agent / Task Agent
- [ ] Multi-Agent Delegation
- [ ] Google Drive / Calendar / Dashboard
- [ ] Campaign Analytics / Creative Analytics

## ทำเกินแผน (ไม่มีในคู่มือ แต่มาจาก pain point จริง)

บุคลิกและชื่อเล่น "แงว" ระดับองค์กร · ความจำบทสนทนา 30 ข้อความต่อแชท · ความต่อเนื่องข้ามแชท ·
DM ตอบโดยไม่ต้องแท็ก · เอ่ยชื่อแล้วโมเดลตัดสินใจเองว่าจะตอบหรือเงียบ · อ่านรูปภาพ ·
ตั้งเตือนตามเวลา · ADMIN จัดการพนักงานผ่านแชท · ดึงชื่อกลุ่มจาก LINE อัตโนมัติ ·
**อ่านไฟล์เอกสาร PDF / Word / Excel / CSV / ข้อความ** ·
**ชุดข้อสอบอัตโนมัติ 8 ข้อ** (กันบั๊กเดิมกลับมา รันทุกครั้งที่ push)

## ค้างอยู่ / ต้องทำต่อ

1. Event Extraction → เปิดทาง MVP 0.3 (ควรรอข้อมูลจริง 1–2 สัปดาห์)
2. ตั้ง MANAGER ให้หัวหน้าทีมจริง เพื่อให้ฟีเจอร์ระดับ MANAGER ถูกใช้
3. ผูกบัญชี pending ที่เหลือเข้ากับ LINE จริง
4. เพิ่ม CRON_SECRET เป็น repository secret ใน GitHub เพื่อให้ข้อสอบรันเองตอน push
