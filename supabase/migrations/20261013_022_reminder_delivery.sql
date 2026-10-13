-- ตัวเตือนต้องรู้ว่าส่งถึงจริงหรือเปล่า และคิดเนื้อหาใหม่ตอนถึงเวลาได้
--
-- เดิมส่งไม่ออกก็นับว่าส่งแล้ว เลื่อนไปรอบถัดไปเงียบ ๆ (12-13 ต.ค. โควตา LINE หมด
-- ตัวเตือนเช็กลิสต์เปิดสาขา 9 โมงหายไปสองวันโดยระบบรายงานว่าส่งสำเร็จ)
-- และตัวเตือนส่งได้แค่ข้อความตายตัว ตั้มขอให้ส่งสถานะเช็กลิสต์ทุกเช้า
-- สิ่งที่ส่งออกไปจริงคือคำอธิบายว่าจะทำอะไร ไม่ใช่ตัวเช็กลิสต์

-- TEXT = ส่งข้อความตามที่ตั้งไว้ / AGENT = ให้แงวทำตามคำสั่งในข้อความตอนถึงเวลาแล้วส่งผล
alter table reminders add column if not exists kind text not null default 'TEXT';
do $$ begin
  alter table reminders add constraint reminders_kind_check check (kind in ('TEXT', 'AGENT'));
exception when duplicate_object then null; end $$;

-- ผลการส่งรอบล่าสุดที่ไม่สำเร็จ ให้แงวตอบได้ว่าทำไมไม่เห็นข้อความ
alter table reminders add column if not exists last_error text;
alter table reminders add column if not exists last_failed_at timestamptz;
alter table reminders add column if not exists fail_count integer not null default 0;

-- cron ยิงทุกนาที ตัวเตือนแบบ AGENT ใช้เวลาคิดหลายสิบวินาที รอบถัดไปจะหยิบอันเดิมซ้ำ
-- จองไว้ก่อนส่ง จองค้างนานเกิน 5 นาทีถือว่ารอบนั้นตายไปแล้ว หยิบใหม่ได้
alter table reminders add column if not exists claimed_at timestamptz;
