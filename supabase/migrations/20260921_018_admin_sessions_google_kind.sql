-- เพิ่ม 'GOOGLE' เป็นค่าที่ตาราง admin_sessions รับได้
--
-- 21 ก.ย. 2569 ตั้มลองพิมพ์ "เชื่อม Google" แล้วระบบพังทันที ด้วยข้อความ
-- admin_sessions violates check constraint เพราะ google_connect_link เขียน kind = 'GOOGLE'
-- แต่ตารางจำกัดไว้แค่ 'LINK' กับ 'SESSION' ตั้งแต่วันที่สร้างตาราง ก่อนที่ฟีเจอร์เชื่อม Google จะมีอยู่จริง
alter table admin_sessions drop constraint admin_sessions_kind_check;
alter table admin_sessions add constraint admin_sessions_kind_check
  check (kind = any (array['LINK', 'SESSION', 'GOOGLE']));
