-- เก็บตำแหน่งงานของพนักงาน (บอทถามตอนทักส่วนตัวครั้งแรก)
alter table users add column if not exists job_title text;
