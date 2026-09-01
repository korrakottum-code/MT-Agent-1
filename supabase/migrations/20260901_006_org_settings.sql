-- ค่าตั้งระดับองค์กร ใช้ร่วมกันทุกคนทุกกลุ่ม เช่น บุคลิกของบอท
-- ต่างจาก users.preferences ที่เป็นของใครของมัน
create table if not exists org_settings (
  key text primary key,
  value text not null,
  updated_by_user_id uuid references users(id),
  updated_at timestamptz not null default now()
);

alter table org_settings enable row level security;
