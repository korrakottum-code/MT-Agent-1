-- สิ่งที่ได้จากการอ่านบทสนทนาทั้งวันเมื่อคืน เก็บไว้ให้แงวอ่านตอนเช้า
--
-- ประวัติแชทดิบตอบได้แค่ว่าใครพิมพ์อะไร แต่ตอบไม่ได้ว่าตกลงกันว่าอะไร ใครรับงานไหนไป
-- และเรื่องไหนยังค้างคำตอบอยู่ การไล่อ่านย้อนหลังทุกครั้งที่มีคนถามก็แพงและช้า
-- จึงสรุปคืนละครั้งแล้วให้ทุกข้อความของวันรุ่งขึ้นใช้ของก้อนเดียวกัน
create table if not exists chat_context (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  for_date date not null,
  summary text not null,
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (chat_id, for_date)
);

create index if not exists chat_context_lookup
  on chat_context (chat_id, for_date desc);

alter table chat_context enable row level security;
