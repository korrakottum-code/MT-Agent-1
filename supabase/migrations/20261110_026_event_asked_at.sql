-- แงวถามในกลุ่มเมื่อเห็นงานที่ยังไม่รู้ครบว่าใครสั่ง ใครรับ ส่งเมื่อไหร่ จดเวลาที่ถามไว้จะได้ไม่ถามซ้ำ
alter table events add column if not exists asked_at timestamptz;
