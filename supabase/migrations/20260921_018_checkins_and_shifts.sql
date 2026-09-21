-- เช็กชื่อรายวันกับตารางเวร
--
-- 21 ก.ย. 2569 ตั้มส่งภาพแชทของบอทคู่แข่ง (สมบัติ ของ Saifa AI) ที่ทีม Class Clinic ใช้เช็กว่า
-- แต่ละสาขาลงสตอรี่วันนี้หรือยัง มันนับในหัวโมเดล จึงบอกว่า "จดแล้ว" ทั้งที่ไม่ได้จด นับสาขาที่ไม่มีใครแจ้ง
-- และไม่เคยส่งสรุปปิดวันตามที่รับปาก
--
-- แงวจึงเก็บการเช็กชื่อลงตารางจริง นับด้วย SQL ไม่ใช่ด้วยความจำ และให้ cron ส่งสรุปปิดวันตามเวลาที่ตั้ง
--
-- checkin_campaigns = เรื่องที่ต้องเช็กทุกวัน เช่น "ลงสตอรี่ PDRN" หนึ่งแชทมีได้หลายเรื่อง
-- units            = รายชื่อหน่วยที่ต้องเช็ก (สาขา หรือคน) ว่างได้ แปลว่าจดตามที่มีคนแจ้งโดยไม่รู้ว่าใครยังขาด
-- checkins         = หนึ่งแถวต่อหนึ่งหน่วยต่อหนึ่งวัน กันนับซ้ำด้วย unique
create table if not exists checkin_campaigns (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  group_id uuid references groups(id),
  name text not null,
  units text[] not null default '{}',
  target_count integer,
  summary_time text not null default '18:00',
  active boolean not null default true,
  last_summary_on date,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists checkin_campaigns_chat on checkin_campaigns (chat_id) where active;

create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references checkin_campaigns(id) on delete cascade,
  unit text not null,
  checked_on date not null,
  reported_by_user_id uuid references users(id),
  note text,
  created_at timestamptz not null default now(),
  unique (campaign_id, unit, checked_on)
);
create index if not exists checkins_day on checkins (campaign_id, checked_on);

-- ตารางเวร ใครดูแลเรื่องอะไรช่วงเวลาไหน คลังถามบอทคู่แข่งว่า "เวลาไหนใครคุมแชท" แล้วไม่มีใครรับไปทำ
-- weekday = เวรประจำสัปดาห์ (0 อาทิตย์ … 6 เสาร์) on_date = เวรเฉพาะวัน ใส่อย่างใดอย่างหนึ่ง
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  group_id uuid references groups(id),
  user_id uuid not null references users(id),
  duty text not null default 'เฝ้าแชท',
  weekday smallint check (weekday between 0 and 6),
  on_date date,
  start_time time not null,
  end_time time not null,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  check (weekday is not null or on_date is not null)
);
create index if not exists shifts_chat on shifts (chat_id);

alter table checkin_campaigns enable row level security;
alter table checkins enable row level security;
alter table shifts enable row level security;
