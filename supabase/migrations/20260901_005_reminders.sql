-- การเตือนตามเวลาที่สั่งไว้ เช่น "เตือนอีก 2 นาที" หรือ "พรุ่งนี้เตือนแพรวส่งภาพก่อนเที่ยง"
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid references users(id),
  chat_id text not null,               -- ปลายทางที่จะส่ง: line_group_id หรือ line_user_id
  message text not null,
  remind_at timestamptz not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'CANCELLED')),
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ใช้ค้นการเตือนที่ถึงกำหนดทุกนาที
create index if not exists idx_reminders_due
  on reminders (remind_at) where status = 'PENDING';

alter table reminders enable row level security;
