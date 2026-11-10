-- ฟีดแบ็คถึงทีมพัฒนาเคยเก็บเป็นใบงานในชื่อคนเสนอ เลยไปโผล่ในรายการงานของคนนั้นทั้งที่เขาไม่ต้องทำอะไร
-- ย้ายมาเก็บแยกที่นี่ และยกเลิกใบงานเดิมที่ยังเปิดอยู่ ข้อความไม่หาย ย้ายมาครบ
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  from_user_id uuid references users(id),
  group_id uuid references groups(id),
  status text not null default 'NEW' check (status in ('NEW', 'DONE', 'DROPPED')),
  created_at timestamptz not null default now()
);
create index if not exists feedback_status_idx on feedback (status, created_at desc);
alter table feedback enable row level security;

insert into feedback (text, from_user_id, group_id, created_at)
select trim(regexp_replace(title, '^ฟีดแบ็ค:?\s*', '')) || coalesce(E'\n' || nullif(description, ''), ''),
       coalesce(owner_user_id, created_by_user_id), group_id, created_at
from tasks
where title like 'ฟีดแบ็ค%' and status in ('TODO', 'DOING', 'REVIEW', 'BLOCKED');

update tasks set status = 'CANCELLED', updated_at = now()
where title like 'ฟีดแบ็ค%' and status in ('TODO', 'DOING', 'REVIEW', 'BLOCKED');

-- ห้องประชุมเคยสร้างใบงาน "ประชุม: ..." ไว้ด้วย ไม่มีใครปิด ค้างเป็นงานในมือตั้งแต่ ก.ย.
-- ตอนนี้เลิกสร้างแล้ว การเตือนก่อนประชุมยังอยู่ครบ
update tasks set status = 'CANCELLED', updated_at = now()
where title like 'ประชุม:%' and status in ('TODO', 'DOING', 'REVIEW', 'BLOCKED');
