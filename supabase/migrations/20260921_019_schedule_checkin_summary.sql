-- สรุปปิดวันของการเช็กชื่อ ส่งตามเวลาที่แต่ละเรื่องตั้งไว้ (summary_time เวลาไทย)
-- cron วิ่งทุก 5 นาที ตัว job เช็คเองว่าเรื่องไหนถึงเวลาแล้วและวันนี้ยังไม่ได้ส่ง จึงส่งวันละครั้งพอดี
-- ใช้คำสั่งของงาน due-reminders เป็นแม่แบบ จะได้ใช้กุญแจตัวเดียวกันโดยไม่ต้องเขียนกุญแจลงไฟล์นี้
select cron.schedule(
  'checkin-summary',
  '*/5 * * * *',
  (
    select replace(replace(command, '"job":"due_reminders"', '"job":"checkin_summary"'),
                   'timeout_milliseconds := 30000', 'timeout_milliseconds := 60000')
    from cron.job where jobname = 'due-reminders'
  )
);
