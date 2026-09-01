-- Event Extraction (MVP 0.2 → 0.3)
-- สิ่งที่บอทจับได้จากบทสนทนาปกติโดยไม่ต้องมีใครสั่ง: งานที่ถูกมอบหมาย / การตัดสินใจ / กำหนดส่ง
-- เก็บเป็น "ข้อเสนอ" สถานะ NEW เท่านั้น ห้ามกลายเป็นงานจริงเองโดยไม่มีคนยืนยัน

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,                       -- line_group_id ของแชทที่เกิดเรื่อง
  group_id uuid references groups(id) on delete set null,
  type text not null check (type in ('TASK', 'DECISION', 'DEADLINE')),
  title text not null,                         -- สรุปสั้น ๆ ว่าคืออะไร
  detail text,
  owner_user_id uuid references users(id) on delete set null,   -- คนที่ดูเหมือนต้องรับผิดชอบ
  said_by_user_id uuid references users(id) on delete set null, -- คนที่พูดเรื่องนี้
  due_at timestamptz,
  confidence numeric(3, 2),                    -- 0.00–1.00 ความมั่นใจของโมเดล
  source_excerpt text,                         -- ข้อความต้นทางไว้ให้คนตรวจย้อนได้
  status text not null default 'NEW' check (status in ('NEW', 'CONVERTED', 'DISMISSED')),
  task_id uuid references tasks(id) on delete set null,
  reviewed_by_user_id uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table events enable row level security;

create index if not exists events_chat_status_idx
  on events (chat_id, status, created_at desc);

-- กันจับซ้ำเรื่องเดิมทุกครั้งที่ job รัน และกันเสนอซ้ำสิ่งที่คนเคยปัดทิ้งไปแล้ว
create unique index if not exists events_unique_idx
  on events (chat_id, type, title);
