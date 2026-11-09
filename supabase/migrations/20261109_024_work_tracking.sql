-- ให้เห็นว่าแต่ละคนทำอะไรอยู่ ปัญหาที่ตั้มเล่า 9 พ.ย. คือสั่งงานไปแล้วได้ยินว่างานแน่น แต่ไม่มีอะไรให้ดู
-- ทีมส่ง To do list ในกลุ่มอยู่แล้ว work_reports เอามาเก็บเป็นรายคนรายวัน คนละแถวต่อวันต่อกลุ่ม
-- ส่งซ้ำในวันเดียวกันให้ทับ เพราะคนมักส่งฉบับเต็มอีกรอบหลังแก้
create table if not exists work_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id),
  line_user_id    text not null,
  written_name    text,
  group_id        uuid not null references groups(id),
  line_message_id text,
  work_date       date not null,
  items           jsonb not null default '[]'::jsonb,
  posted_at       timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (line_user_id, group_id, work_date)
);
create index if not exists work_reports_date on work_reports (work_date desc);
create index if not exists work_reports_user on work_reports (user_id, work_date desc);
alter table work_reports enable row level security;

-- เริ่มงาน ตามงาน จบงาน ผ่านไลน์ ต้องมีสถานะรอตรวจกับติดปัญหา และรู้ว่าเริ่มเมื่อไร
alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status = any (array['TODO', 'DOING', 'REVIEW', 'BLOCKED', 'DONE', 'CANCELLED']));
alter table tasks add column if not exists started_at timestamptz;
alter table tasks add column if not exists blocked_reason text;
alter table tasks add column if not exists brand text;
alter table tasks add column if not exists branch text;
alter table tasks add column if not exists monday_code text;

-- ลิงก์ดูบอร์ด อ่านอย่างเดียว ใช้ซ้ำได้จนหมดอายุ ต่างจาก LINK ของหลังบ้านที่ใช้ครั้งเดียว
alter table admin_sessions drop constraint admin_sessions_kind_check;
alter table admin_sessions add constraint admin_sessions_kind_check
  check (kind = any (array['LINK', 'SESSION', 'GOOGLE', 'BOARD']));
