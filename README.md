# MT Agent 1 — AI Organization on LINE

AI กลางขององค์กรที่อยู่ใน LINE Group: รู้ว่าใครพูด, สร้าง/ติดตามงาน, ค้นข้อความ, สรุปกลุ่ม และตอบคำถามเชิงข้อมูล

```text
LINE Group → LINE OA → Webhook → Supabase Edge Function
  → Identity + Permission → Agent (Claude + Tools) → Supabase Postgres
  → ตอบกลับ LINE
```

## สถานะ

- [x] Phase 1 — LINE OA "MT agent 1" (@303dpzyq) เปิด Messaging API + join group ได้
- [x] Phase 3 — Supabase project `MT-Agent-1` (ap-southeast-1) + ตาราง `users / groups / messages / tasks / audit_logs`
- [ ] Phase 2 — Webhook backend (Edge Function `line-webhook`)
- [ ] Phase 4 — Identity resolution
- [ ] Phase 5–6 — Agent + Tools 6 ตัว
- [ ] Phase 9–10 — Permission + Audit
- [ ] MVP 0.1 Definition of Done

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
