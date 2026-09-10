-- ล้างงานที่ข้อสอบสร้างค้างไว้ในฐานข้อมูลจริง
-- เปิด Supabase > SQL Editor แล้ววางทั้งไฟล์นี้ กด Run ครั้งเดียวจบ
-- ขั้นแรกสำเนาไว้ก่อน ถ้าลบผิดคืนได้จากตาราง tasks_exam_backup_20260911

create table if not exists tasks_exam_backup_20260911 as
select * from tasks
where status = 'CANCELLED' and (
  title in ('ทดสอบระบบข้อสอบ','ปิดงบเดือน','ทำสไลด์เสนอลูกค้า','ตรวจรายชื่อเพจสาขา','ประชุม: สรุปงาน')
  or (title ilike '%รายงาน%' and group_id is null and created_at < '2026-09-04')
);

delete from tasks t
using tasks_exam_backup_20260911 b
where t.id = b.id;

-- ควรได้ 153 และ 13
select (select count(*) from tasks_exam_backup_20260911) as ลบไป,
       (select count(*) from tasks) as เหลืออยู่;

-- ถ้าลบผิด กู้คืนด้วยบรรทัดนี้
-- insert into tasks select * from tasks_exam_backup_20260911;
