-- ฟีดแบ็คข้อ 3: แนบไฟล์หรือรูปเข้ากับงานได้
-- เก็บไฟล์จริงไว้ใน Supabase Storage ส่วนตารางนี้เก็บว่าไฟล์ไหนผูกกับงานไหน ใครแนบ เมื่อไร
create table if not exists task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  file_name text not null,
  content_type text,
  size_bytes integer,
  storage_path text not null,
  uploaded_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on task_attachments (task_id, created_at desc);
alter table task_attachments enable row level security;

insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

-- ฟีดแบ็คข้อ 5: ปฏิทิน
-- เชื่อม Google Calendar แบบสองทางต้องผ่าน OAuth ซึ่งต้องให้เจ้าของตั้งค่าฝั่ง Google เอง
-- ทางที่ทำได้ทันทีคือปล่อยไฟล์ปฏิทิน (.ics) ให้เอาไปกดสมัครใน Google Calendar
-- ได้ผลเดียวกันในมุมผู้ใช้ คือเห็นงานและกำหนดส่งในปฏิทิน โดยไม่ต้องขอสิทธิ์เข้าบัญชีใคร
-- เก็บเฉพาะ hash ของ token เหมือน admin_sessions คนที่อ่านฐานข้อมูลได้จึงปลอมลิงก์ไม่ได้
create table if not exists calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  revoked_at timestamptz,
  last_read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists calendar_feeds_lookup on calendar_feeds (token_hash);
alter table calendar_feeds enable row level security;
