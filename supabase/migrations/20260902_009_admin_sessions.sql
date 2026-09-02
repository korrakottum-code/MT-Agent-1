-- Admin Console — ตั๋วเข้าหน้าจอ
--
-- มี 2 ชนิดในตารางเดียวกัน
--   LINK    = ลิงก์ที่ส่งให้ทาง DM ใช้ได้ครั้งเดียว อายุสั้น แลกเป็น SESSION
--   SESSION = คุกกี้ในเบราว์เซอร์หลังแลกลิงก์แล้ว
--
-- เก็บเฉพาะ SHA-256 ของ token ไม่เก็บตัวจริง คนที่อ่านฐานข้อมูลได้จึงปลอมตั๋วไม่ได้

create table if not exists admin_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  kind        text not null check (kind in ('LINK', 'SESSION')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists admin_sessions_lookup on admin_sessions (token_hash);
create index if not exists admin_sessions_user on admin_sessions (user_id, created_at desc);

alter table admin_sessions enable row level security;
-- ไม่มี policy โดยตั้งใจ — เข้าถึงได้เฉพาะ service_role เหมือนตารางอื่นในโปรเจกต์นี้
