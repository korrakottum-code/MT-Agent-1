-- งานกลางคืน: อ่านบทสนทนาของเมื่อวานทั้งวันแล้วเขียนบริบทไว้ให้แงวอ่านพรุ่งนี้ (ตาราง chat_context)
-- ตี 2 ตามเวลาไทย = 19:00 UTC ของวันก่อนหน้า
-- ตั้งหลัง extract_events รอบสุดท้าย (22:50 ไทย) เพื่อให้เหตุการณ์ของวันถูกจับครบก่อนสรุปบริบท
-- ใช้คำสั่งของงาน extract-events เป็นแม่แบบ จะได้ใช้กุญแจตัวเดียวกันโดยไม่ต้องเขียนกุญแจลงไฟล์นี้
select cron.schedule(
  'daily-context',
  '0 19 * * *',
  (
    select replace(command, '"job":"extract_events"', '"job":"daily_context"')
    from cron.job where jobname = 'extract-events'
  )
);
