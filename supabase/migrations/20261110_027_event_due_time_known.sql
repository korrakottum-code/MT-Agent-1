-- กำหนดส่งต้องรู้ทั้งวันและเวลา ถ้าแชทบอกแค่วัน แงวยังเปิดงานเองไม่ได้ ต้องถามเวลาก่อน
alter table events add column if not exists due_time_known boolean;
