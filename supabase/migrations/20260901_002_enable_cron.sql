-- MVP 0.2: เปิดใช้ตัวตั้งเวลา (pg_cron) และตัวยิง HTTP จากฐานข้อมูล (pg_net)
-- ใช้เรียก Edge Function scheduled-jobs ตามเวลา (daily summary / task reminder)
create extension if not exists pg_cron;
create extension if not exists pg_net;
