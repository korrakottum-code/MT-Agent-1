-- MT Agent 1 — MVP 0.1 core schema
-- Source of Truth ของบริษัท: users / groups / messages / tasks / audit_logs

-- ============ users ============
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text unique not null,
  display_name text,
  employee_code text,
  department text,
  role text not null default 'EMPLOYEE'
    check (role in ('EMPLOYEE', 'MANAGER', 'ADMIN', 'EXECUTIVE')),
  manager_user_id uuid references users(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ groups ============
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  line_group_id text unique not null,
  group_name text,
  department text,
  project_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============ messages ============
-- เก็บทุกข้อความในกลุ่ม ใช้ทำ search / summary / audit / analytics
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  line_message_id text unique,
  line_user_id text not null,
  line_group_id text,
  message_text text,
  message_type text not null default 'text',
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_group_time
  on messages (line_group_id, created_at desc);

-- ============ tasks ============
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  owner_user_id uuid references users(id),
  created_by_user_id uuid references users(id),
  group_id uuid references groups(id),
  status text not null default 'TODO'
    check (status in ('TODO', 'DOING', 'DONE', 'CANCELLED')),
  priority text not null default 'NORMAL'
    check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  due_at timestamptz,
  source_message_id uuid references messages(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_tasks_owner_status on tasks (owner_user_id, status);
create index if not exists idx_tasks_status_completed on tasks (status, completed_at);
create index if not exists idx_tasks_due on tasks (due_at) where status in ('TODO', 'DOING');

-- ============ audit_logs ============
-- ทุก action ของ AI ต้องตรวจสอบย้อนหลังได้
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  action text not null,
  tool_name text,
  input jsonb,
  result jsonb,
  status text not null default 'OK'
    check (status in ('OK', 'ERROR', 'DENIED')),
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_time on audit_logs (created_at desc);

-- ============ Row Level Security ============
-- เปิด RLS ทุกตารางโดยไม่สร้าง policy สำหรับ anon
-- → client ภายนอกอ่าน/เขียนอะไรไม่ได้เลย
-- → Edge Function ใช้ service_role key ซึ่ง bypass RLS
alter table users enable row level security;
alter table groups enable row level security;
alter table messages enable row level security;
alter table tasks enable row level security;
alter table audit_logs enable row level security;
