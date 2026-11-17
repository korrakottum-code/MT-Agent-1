-- ทีมขอให้เริ่มเตรียมและเตือนเช็กลิสต์ 20 วันก่อนเปิดสาขา (แชทกลุ่ม Ads 22 ต.ค. 2569) เดิมตั้งไว้ 14
-- branch_checklist_status ใช้ค่านี้เป็นค่าเริ่มต้นของ days_ahead ตัวเตือนเช็กลิสต์จึงเห็นสาขาเร็วขึ้นตามไปด้วย
update org_settings
set value = jsonb_set(value::jsonb, '{start_days_before}', '20')::text,
    updated_at = now()
where key = 'branch_checklist';

-- ตัวเตือนเช็กลิสต์ของตั้ม (ef7dc737) เขียน "ภายใน 14 วัน" ไว้ในคำสั่งเอง จะไม่ขยับตามค่าข้างบน
-- เปลี่ยนเป็นช่วงเตรียมตามตั้งค่า ต่อไปแก้ตัวเลขที่ org_settings ที่เดียวพอ
update reminders
set message = replace(message, 'เฉพาะสาขาที่อยู่ในช่วงเตรียม (ภายใน 14 วัน)', 'เฉพาะสาขาที่อยู่ในช่วงเตรียม (ไม่ต้องใส่ days_ahead ระบบใช้ช่วงเตรียมตามตั้งค่า)')
where id = 'ef7dc737-33c9-439a-b4ba-39a96226e189' and status = 'PENDING';
