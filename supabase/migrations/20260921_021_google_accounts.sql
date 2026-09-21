-- กุญแจของ Google ที่ต่อไว้ ใช้สร้างลิงก์ Google Meet จริง
--
-- ลิงก์ Meet สร้างได้ผ่าน Google Calendar API เท่านั้น และต้องทำในนามคนที่ล็อกอินจริง
-- บัญชีบริการเปล่า ๆ สร้างไม่ได้ จึงต้องให้เจ้าของกดยินยอมหนึ่งครั้ง แล้วเก็บ refresh token ไว้
-- ตารางนี้เก็บได้หลายบัญชี แต่ใช้ตัวที่ is_default เป็นหลัก
--
-- ถูก apply ลงฐานข้อมูลจริงแล้วเมื่อ 21 ก.ย. 2569 (version 20260921050905 ชื่อ google_oauth_tokens)
-- โดย session ที่ทำเรื่อง Google Meet แต่ไม่ได้เขียนไฟล์ไว้ในรีโป ไฟล์นี้คัดจาก statements ที่บันทึกในฐานข้อมูล
-- เพื่อให้รีโปกับฐานข้อมูลตรงกันตามกฎข้อ 7 ห้ามรันซ้ำ (มี if not exists กันไว้แล้ว)
create table if not exists google_accounts (
  id uuid primary key default gen_random_uuid(),
  email text,
  refresh_token text not null,
  scope text,
  connected_by_user_id uuid references users(id) on delete set null,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email)
);

alter table google_accounts enable row level security;
