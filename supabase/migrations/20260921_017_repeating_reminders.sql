-- เตือนซ้ำได้จนกว่างานจะเสร็จ
--
-- 21 ก.ย. 2569 ตั้มสั่งว่า "ถามในกลุ่มทุกวันจนกว่าจะบอกว่าเสร็จ" แล้วแงวตอบว่าระบบทำไม่ได้
-- ซึ่งจริงตอนนั้น เพราะการเตือนหนึ่งแถวยิงได้ครั้งเดียวแล้วจบ
--
-- repeat_rule  = daily | weekdays | weekly ถ้าว่างคือเตือนครั้งเดียวเหมือนเดิม
-- task_id      = งานที่ผูกไว้ พอปิดงานแล้วการเตือนหยุดเอง ไม่ต้องไปตามยกเลิก
-- repeat_until = กันเตือนวนไม่รู้จบถ้าไม่มีใครปิดงาน
alter table reminders
  add column if not exists repeat_rule text,
  add column if not exists task_id uuid references tasks(id) on delete set null,
  add column if not exists repeat_count integer not null default 0,
  add column if not exists repeat_until timestamptz;

comment on column reminders.repeat_rule is 'daily | weekdays | weekly | null = ครั้งเดียว';
comment on column reminders.task_id is 'ผูกกับงาน พองานเป็น DONE หรือ CANCELLED การเตือนซ้ำจะหยุด';

create index if not exists reminders_due on reminders (status, remind_at);
