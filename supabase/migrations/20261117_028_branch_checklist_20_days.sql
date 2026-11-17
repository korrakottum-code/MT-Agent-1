-- ทีมขอให้เริ่มเตรียมและเตือนเช็กลิสต์ 20 วันก่อนเปิดสาขา (แชทกลุ่ม Ads 22 ต.ค. 2569) เดิมตั้งไว้ 14
-- branch_checklist_status ใช้ค่านี้เป็นค่าเริ่มต้นของ days_ahead ตัวเตือนเช็กลิสต์จึงเห็นสาขาเร็วขึ้นตามไปด้วย
update org_settings
set value = jsonb_set(value::jsonb, '{start_days_before}', '20')::text,
    updated_at = now()
where key = 'branch_checklist';
