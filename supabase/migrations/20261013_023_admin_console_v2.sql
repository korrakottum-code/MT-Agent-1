-- หลังบ้านรุ่นสอง: ตัวเตือน สุขภาพระบบ การใช้งาน เช็กลิสต์เปิดสาขา ดูแชท จัดการกลุ่ม

-- ---------------------------------------------------------------- Monday รายกลุ่ม ผูกด้วยแถว ไม่ใช่ชื่อ
-- เดิมเปิดด้วย secret MONDAY_ALLOWED_GROUPS ที่เป็นชื่อกลุ่ม แงวมีคำสั่งเปลี่ยนชื่อกลุ่มอยู่แล้ว
-- และหลังบ้านจะมีปุ่มเปลี่ยนชื่อ เปลี่ยนชื่อเมื่อไร Monday ในกลุ่มนั้นพังเงียบ ๆ ทันที
-- ณ วันนี้ secret เปิดไว้กลุ่มเดียวคือ Ads Class Clinic (ยืนยันจากข้อความ error ใน audit_logs)
alter table groups add column if not exists monday_enabled boolean not null default false;
update groups set monday_enabled = true where group_name = 'Ads Class Clinic';

-- ---------------------------------------------------------------- ราคาโมเดล
-- หน้าภาพรวมเดิมคิดด้วยราคา Claude ที่ฝังในโค้ด ตอนนี้แงวใช้ Gemini ตัวเลขเลยสูงเกินจริงราว 2.7 เท่า
-- ย้ายมาไว้ในตาราง แก้ราคาได้ไม่ต้อง deploy จับคู่แบบขึ้นต้น (ตัวยาวสุดชนะ) เหมือน tests/prices.json
create table if not exists model_prices (
  model_prefix text primary key,
  input        numeric not null,
  output       numeric not null,
  cache_read   numeric not null default 0,
  cache_write  numeric not null default 0,
  note         text,
  updated_at   timestamptz not null default now()
);
alter table model_prices enable row level security;
insert into model_prices (model_prefix, input, output, cache_read, cache_write, note) values
  ('claude-sonnet-5',  2,    10,   0.2,   2.5,  null),
  ('claude-haiku-4-5', 1,    5,    0.1,   1.25, null),
  ('gpt-5.6',          0.2,  1.2,  0.02,  0,    null),
  ('gemini-3.7-flash', 0.75, 3.75, 0.075, 0,    'ราคาโปรถึง 31 ธ.ค. 2026 หลังจากนั้นเท่าตัว (1.50 / 7.50 / 0.15)')
on conflict (model_prefix) do update set
  input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
  cache_write = excluded.cache_write, note = excluded.note, updated_at = now();

create or replace function usage_cost(p_model text, p_in numeric, p_out numeric, p_cr numeric, p_cw numeric)
returns numeric language sql stable set search_path = public as $$
  select coalesce((
    select (coalesce(p_in,0) * mp.input + coalesce(p_out,0) * mp.output
          + coalesce(p_cr,0) * mp.cache_read + coalesce(p_cw,0) * mp.cache_write) / 1000000
    from model_prices mp
    where p_model like mp.model_prefix || '%'
    order by length(mp.model_prefix) desc limit 1
  ), 0)
$$;

-- ---------------------------------------------------------------- การใช้งาน (คำนวณในฐานข้อมูล)
-- หน้าเว็บเดิมดึง token_usage ทั้งตารางมาบวกเอง ซึ่ง PostgREST ตัดที่ 1,000 แถวเงียบ ๆ
-- ตอนนี้มีเกือบ 4,000 แถว ยอดรวมจึงขาดไปสามในสี่ รวมในฐานข้อมูลแทน ไม่มีเพดาน
-- นับเฉพาะ purpose chat = แงวตอบคนจริง ไม่รวมข้อสอบ ซึ่งยิงในนามคนจริงและจะทำให้ตัวเลขเพี้ยน

create or replace function admin_usage_people(p_days int)
returns table (user_id uuid, display_name text, role text, answers bigint, active_days bigint,
               last_used timestamptz, chats text, usd numeric)
language sql stable security definer set search_path = public as $$
  select u.id, u.display_name, u.role,
    count(*),
    count(distinct (tu.created_at at time zone 'Asia/Bangkok')::date),
    max(tu.created_at),
    string_agg(distinct coalesce(g.group_name, 'แชทส่วนตัว'), ', '),
    round(sum(usage_cost(tu.model, tu.input_tokens, tu.output_tokens, tu.cache_read_tokens, tu.cache_write_tokens)), 4)
  from token_usage tu
  join users u on u.id = tu.user_id
  left join groups g on g.line_group_id = tu.chat_id
  where tu.purpose = 'chat'
    and tu.created_at > now() - make_interval(days => p_days)
    and (g.id is not null or tu.chat_id like 'U%')
    and coalesce(g.group_name, '') not like 'SIMTEST%'
  group by u.id, u.display_name, u.role
  order by count(*) desc
$$;

create or replace function admin_usage_chats(p_days int)
returns table (chat_id text, chat_name text, answers bigint, people bigint, active_days bigint,
               last_used timestamptz, human_messages bigint, chat_usd numeric, jobs_usd numeric)
language sql stable security definer set search_path = public as $$
  with tu as (
    select t.*,
      usage_cost(t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens) as usd
    from token_usage t
    where t.created_at > now() - make_interval(days => p_days)
      and t.purpose not in ('eval', 'gate')
  ), chats as (
    select g.line_group_id as chat_id, g.group_name as chat_name from groups g
    where coalesce(g.group_name, '') not like 'SIMTEST%'
    union all select 'DM', 'แชทส่วนตัว (รวมทุกคน)'
  )
  select c.chat_id, c.chat_name,
    count(*) filter (where tu.purpose = 'chat'),
    count(distinct tu.user_id) filter (where tu.purpose = 'chat'),
    count(distinct (tu.created_at at time zone 'Asia/Bangkok')::date) filter (where tu.purpose = 'chat'),
    max(tu.created_at) filter (where tu.purpose = 'chat'),
    (select count(*) from messages m
      where m.line_user_id <> 'bot' and m.created_at > now() - make_interval(days => p_days)
        and (case when c.chat_id = 'DM' then m.line_group_id like 'U%' else m.line_group_id = c.chat_id end)),
    round(coalesce(sum(tu.usd) filter (where tu.purpose = 'chat'), 0), 4),
    round(coalesce(sum(tu.usd) filter (where tu.purpose <> 'chat'), 0), 4)
  from chats c
  left join tu on (case when c.chat_id = 'DM' then tu.chat_id like 'U%' else tu.chat_id = c.chat_id end)
  group by c.chat_id, c.chat_name
  order by 3 desc
$$;

create or replace function admin_spend(p_days int)
returns table (purpose text, calls bigint, usd numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(purpose, '?'), count(*),
    round(sum(usage_cost(model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)), 4)
  from token_usage
  where created_at > now() - make_interval(days => p_days)
  group by 1 order by 3 desc
$$;

-- ---------------------------------------------------------------- สุขภาพงานตามเวลา
-- ตาราง cron ไม่เปิดผ่าน API จึงต้องมีฟังก์ชันอ่านให้
-- ห้ามคืนคอลัมน์ command เด็ดขาด ในนั้นมี CRON_SECRET ฝังอยู่
create or replace function admin_job_health()
returns table (jobname text, schedule text, active boolean, last_start timestamptz, last_status text,
               last_message text, runs_24h bigint, failed_24h bigint)
language sql stable security definer set search_path = public, cron as $$
  select j.jobname::text, j.schedule::text, j.active,
    l.start_time, l.status::text, left(l.return_message, 200),
    (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours'),
    (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours'
       and d.status <> 'succeeded')
  from cron.job j
  left join lateral (
    select d.start_time, d.status, d.return_message from cron.job_run_details d
    where d.jobid = j.jobid order by d.start_time desc limit 1
  ) l on true
  order by j.jobname
$$;

-- ฟังก์ชันพวกนี้เปิดข้อมูลการใช้งานของทุกคน ให้เรียกได้เฉพาะ service_role (ฟังก์ชันหลังบ้าน)
revoke execute on function admin_usage_people(int) from public, anon, authenticated;
revoke execute on function admin_usage_chats(int) from public, anon, authenticated;
revoke execute on function admin_spend(int) from public, anon, authenticated;
revoke execute on function admin_job_health() from public, anon, authenticated;
grant execute on function admin_usage_people(int) to service_role;
grant execute on function admin_usage_chats(int) to service_role;
grant execute on function admin_spend(int) to service_role;
grant execute on function admin_job_health() to service_role;

-- ---------------------------------------------------------------- เช็กลิสต์เปิดสาขา
-- เดิมแงวต้องไปควานจากแชททุกครั้งที่มีคนถาม ตัวเตือน 9 โมงก็ต้องควานเหมือนกัน แม่นได้ไม่เกินที่คนพิมพ์ไว้
-- items เก็บสถานะต่อข้อ {key: {done, at, by, note}} รายการข้อเก็บใน org_settings แก้ได้ไม่ต้อง deploy
create table if not exists branch_openings (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  brand         text,
  open_date     date not null,
  aliases       text[] not null default '{}',
  owner_user_id uuid references users(id),
  chat_id       text,
  items         jsonb not null default '{}'::jsonb,
  note          text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists branch_openings_name_date on branch_openings (name, open_date);
alter table branch_openings enable row level security;

insert into org_settings (key, value, updated_at) values ('branch_checklist', '{
  "items": [
    {"key": "page",        "label": "สร้างเพจ"},
    {"key": "fb_checkin",  "label": "Check in บน Facebook ได้"},
    {"key": "google_map",  "label": "ปักหมุด Google Map"},
    {"key": "promo_ads",   "label": "โปรเปิดสาขาพร้อมขึ้นแอด"},
    {"key": "ad_account",  "label": "Ad account ใช้บัญชีใหม่"}
  ],
  "start_days_before": 14,
  "ready_days_before": 7
}', now())
on conflict (key) do nothing;

-- ตั้งต้นจากไทม์ไลน์ที่แงวอ่านจากรูปให้ตั้มเมื่อ 13 ต.ค. ยังไม่ติ๊กข้อไหนเสร็จ ไม่เดาสถานะ
insert into branch_openings (name, brand, open_date, aliases, chat_id, note)
select v.name, v.brand, v.open_date::date, v.aliases, g.line_group_id,
  'ตั้งต้นจากรูปไทม์ไลน์ที่แงวอ่านเมื่อ 13 ต.ค. 2569 ตรวจวันเปิดอีกครั้ง' ||
    coalesce(' · ' || v.extra, '')
from (values
  ('มุกดาหาร',        'CLASS CLINIC', '2026-10-01', '{MDH}'::text[], null),
  ('ยโสธร',           'CLASS CLINIC', '2026-10-05', '{}'::text[],    null),
  ('ปลวกแดง',         'CLASS CLINIC', '2026-10-20', '{PLD}'::text[], null),
  ('โคราช (ที่ใหม่)',   'CLASS CLINIC', '2026-10-25', '{}'::text[],    'ย้ายจากที่เดิม ที่เดิมจะเปลี่ยนเป็น Class Go'),
  ('บ้านฉาง',         'CLASS CLINIC', '2026-10-30', '{}'::text[],    null),
  ('โคราช',           'CLASS GO',     '2026-11-01', '{}'::text[],    'ในแชท 9 ต.ค. พิมพ์ว่า Class Go เปิด 16 พ.ย. (ปากช่อง) ไม่ตรงกับรูป ตรวจด้วย'),
  ('ตรัง',            'CLASS CLINIC', '2026-11-10', '{}'::text[],    null),
  ('อยุธยา',          'CLASS CLINIC', '2026-11-14', '{}'::text[],    null),
  ('ภูเก็ต',          'CLASS CLINIC', '2026-11-21', '{}'::text[],    null),
  ('นครศรีธรรมราช',   'CLASS CLINIC', '2026-11-26', '{}'::text[],    null),
  ('บางใหญ่',         'CLASS CLINIC', '2026-12-03', '{}'::text[],    null),
  ('กระบี่',          'CLASS CLINIC', '2026-12-16', '{}'::text[],    null),
  ('หาดใหญ่',         'CLASS CLINIC', '2026-12-20', '{}'::text[],    null),
  ('พัทยา',           'CLASS CLINIC', '2026-12-24', '{}'::text[],    null)
) as v(name, brand, open_date, aliases, extra)
left join groups g on g.group_name = 'Ads Class Clinic'
on conflict (name, open_date) do nothing;

-- ---------------------------------------------------------------- ติดธงคำตอบที่แย่
-- ตั้มอ่านแชทย้อนหลังในหลังบ้านแล้วกดติดธงได้ ใช้เป็นกองตัวอย่างให้แก้และเขียนข้อสอบเพิ่ม
create table if not exists message_flags (
  id                 uuid primary key default gen_random_uuid(),
  message_id         uuid not null references messages(id) on delete cascade,
  flagged_by_user_id uuid references users(id),
  reason             text,
  resolved           boolean not null default false,
  created_at         timestamptz not null default now()
);
create unique index if not exists message_flags_open on message_flags (message_id) where not resolved;
alter table message_flags enable row level security;
