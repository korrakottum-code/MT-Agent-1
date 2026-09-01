-- บันทึกการใช้ token ทุกครั้งที่เรียกโมเดล เพื่อให้รู้ว่าเงินหมดไปกับอะไรจริง ๆ
-- ก่อนหน้านี้ต้องประมาณเอาเพราะไม่มีข้อมูล ทำให้ optimize แบบเดาไม่ได้

create table if not exists token_usage (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,          -- chat / gate / eval / daily_summary / weekly_summary / extract_events
  model text not null,
  chat_id text,
  user_id uuid references users(id) on delete set null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,   -- อ่านจาก cache ราคาถูกกว่ามาก
  cache_write_tokens integer not null default 0,  -- เขียนลง cache ครั้งแรก
  iterations integer not null default 1,          -- ยิงเข้าโมเดลกี่รอบใน 1 คำตอบ (รวมรอบเรียก tool)
  created_at timestamptz not null default now()
);

alter table token_usage enable row level security;

create index if not exists token_usage_time_idx on token_usage (created_at desc);
create index if not exists token_usage_purpose_idx on token_usage (purpose, created_at desc);
