# MT Agent 1 — AI Organization on LINE

AI กลางขององค์กรที่อยู่ใน LINE Group: รู้ว่าใครพูด, สร้าง/ติดตามงาน, ค้นข้อความ, สรุปกลุ่ม และตอบคำถามเชิงข้อมูล

```text
LINE Group → LINE OA → Webhook → Supabase Edge Function
  → Identity + Permission → Agent (Claude + Tools) → Supabase Postgres
  → ตอบกลับ LINE
```

## สถานะ

- [x] Phase 1 — LINE OA "MT agent 1" (@303dpzyq) เปิด Messaging API + join group ได้
- [x] Phase 2 — Webhook backend (Edge Function `line-webhook`) ตอบ `@AI` ในกลุ่มได้
- [x] Phase 3 — Supabase project `MT-Agent-1` (ap-southeast-1) + ตาราง `users / groups / messages / tasks / audit_logs`
- [x] Phase 4 — Identity: auto-register จาก LINE profile + `register_user` สำหรับ ADMIN
- [x] Phase 5–6 — Agent (claude-sonnet-5) + Tools 8 ตัว
- [x] Phase 9–10 — Permission ตาม role + Audit log ทุก tool call
- [x] MVP 0.1 — ผ่าน Test Scenario หลัก (สร้างงาน/ดูงาน/สรุปกลุ่ม/ลงทะเบียน) เมื่อ 1 ก.ย. 2026
  - เหลือทดสอบ: คนที่ไม่ใช่ ADMIN ถามงานคนอื่นแล้วต้องโดนปฏิเสธ
- [x] MVP 0.2 (บางส่วน) — `scheduled-jobs`: Daily Summary 18:00 + เตือนงานเช้า 09:00 ผ่าน pg_cron
  - รอทำต่อหลังใช้งานจริงสักพัก: Event Extraction (จับ TASK/DECISION/DEADLINE จากข้อความทั่วไป), Weekly Summary

## โครงสร้าง

```text
supabase/
  migrations/   — schema ทั้งหมด (Source of Truth ของโครงสร้าง DB)
  functions/
    line-webhook/ — รับ LINE webhook, verify signature, เรียก agent, ตอบกลับ
docs/
  BUILD_GUIDE.md — คู่มือการสร้างฉบับเต็ม
```

## Secrets (ตั้งใน Supabase Dashboard → Edge Functions → Secrets)

ห้าม commit ลง repo เด็ดขาด

```text
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
ANTHROPIC_API_KEY
```

## MVP 0.1 — คำสั่งที่ต้องใช้งานได้

```text
@AI สร้างงานให้แพรวทำภาพโปร ส่งพรุ่งนี้
@AI วันนี้ฉันมีงานอะไร
@AI แพรวมีงานอะไรค้าง
@AI สรุปงานในกลุ่มวันนี้
@AI เดือนนี้เราทำงานเสร็จไปกี่งาน
```
