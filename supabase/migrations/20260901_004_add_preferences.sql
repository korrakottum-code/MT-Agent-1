-- ความจำถาวรต่อผู้ใช้: ข้อกำหนดที่ผู้ใช้สั่งบอทให้จำ (ชื่อเล่นบอท, โทนการตอบ ฯลฯ)
alter table users add column if not exists preferences text;
