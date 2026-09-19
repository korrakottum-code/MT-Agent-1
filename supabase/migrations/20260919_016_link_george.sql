-- ผูกบัญชีจอร์จที่ตั้มลงทะเบียนไว้ล่วงหน้า เข้ากับบัญชีไลน์จริงของเขา (ตั้มสั่งเมื่อ 19 ก.ย. 2569)
--
-- ตั้มลงทะเบียน "จอร์จ" ไว้เมื่อ 16 ก.ย. พร้อมตำแหน่งกับแผนก ส่วนจอร์จตัวจริงพิมพ์ในกลุ่มครั้งแรก 18 ก.ย.
-- ระบบเลยสร้างบัญชีใหม่ชื่อ "Gจอร์จ 🗂️" แยกออกมา แต่ไม่มีใครสั่งผูก งานหรือเตือนที่สั่งถึง "จอร์จ"
-- จึงไปตกที่บัญชีที่ไม่มีไลน์ ไม่มีวันถึงตัวจริง
--
-- ทำแบบเดียวกับเครื่องมือ link_user ทุกขั้น ตอนผูกไม่มีงาน เตือน หรือเหตุการณ์ค้างที่บัญชีไหนเลย
-- แต่ยังย้ายให้ครบทุกตาราง เผื่อไฟล์นี้ถูกรันซ้ำบนฐานข้อมูลที่มีของค้าง
-- จับด้วยทั้ง id และ line_user_id ถ้าสถานะเปลี่ยนไปจากตอนเขียนไฟล์นี้จะไม่ไปแตะอะไร
do $$
declare
  pending_id uuid := '565affa1-c190-4459-a738-af5b454d1041';
  real_id uuid := '12d686f9-f082-4838-8f2e-f724885f4892';
begin
  if not exists (select 1 from users where id = pending_id and line_user_id like 'pending:%')
     or not exists (select 1 from users where id = real_id and line_user_id not like 'pending:%') then
    raise notice 'สถานะบัญชีไม่ตรงกับตอนเขียนไฟล์นี้ ข้ามการผูก';
    return;
  end if;

  update tasks set owner_user_id = real_id, updated_at = now() where owner_user_id = pending_id;
  update tasks set created_by_user_id = real_id, updated_at = now() where created_by_user_id = pending_id;
  update reminders set target_user_id = real_id where target_user_id = pending_id;
  update events set owner_user_id = real_id where owner_user_id = pending_id;
  update events set said_by_user_id = real_id where said_by_user_id = pending_id;
  update task_attachments set uploaded_by_user_id = real_id where uploaded_by_user_id = pending_id;

  -- ย้ายตำแหน่งกับแผนกที่ตั้มตั้งไว้ ไปที่บัญชีจริงเฉพาะช่องที่ยังว่าง
  update users r set
    job_title = coalesce(r.job_title, p.job_title),
    department = coalesce(r.department, p.department),
    updated_at = now()
  from users p
  where r.id = real_id and p.id = pending_id;

  update users set is_active = false, updated_at = now() where id = pending_id;
end $$;
