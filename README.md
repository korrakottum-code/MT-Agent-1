# MT Agent 1 — AI Organization on LINE

> ความคืบหน้าตามแผนล่าสุด: [docs/PROGRESS.md](docs/PROGRESS.md) — อัปเดตทุกรอบที่มีงานเสร็จ

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
- [x] UX upgrade (1 ก.ย. 2026) — ความจำบทสนทนา (~12 ข้อความล่าสุดต่อแชท), DM ตอบโดยไม่ต้องแท็ก,
  เก็บคำตอบบอทลง messages, tools เพิ่ม: send_dm / rename_group / ค้นหา-สรุปข้ามกลุ่ม (MANAGER ขึ้นไป)
- [x] อ่านไฟล์เอกสาร (1 ก.ย. 2026) — PDF / Word / Excel / CSV / ข้อความ ส่งเข้าแชทแล้วให้บอทสรุปและแตกเป็นงานได้
- [x] MVP 0.2 ครบ (1 ก.ย. 2026) — Event Extraction: อ่านบทสนทนาเองทุก 3 ชม. แล้วจับ TASK / DECISION / DEADLINE
  เก็บเป็นรายการรอยืนยัน ไม่กลายเป็นงานจริงจนกว่าจะมีคนกดยืนยัน

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

ตั้งเพิ่มเฉพาะตอนจะเอาโมเดลค่ายอื่นมาเทียบ (ใช้กับข้อสอบเท่านั้น ไม่แตะโมเดลที่ทีมใช้จริง)
รายละเอียดอยู่ใน [docs/HANDOFF.md](docs/HANDOFF.md)

```text
OPENAI_API_KEY + EVAL_LUNA_MODEL
GEMINI_API_KEY + EVAL_GEMINI_MODEL
```

## MVP 0.1 — คำสั่งที่ต้องใช้งานได้

```text
@AI สร้างงานให้แพรวทำภาพโปร ส่งพรุ่งนี้
@AI วันนี้ฉันมีงานอะไร
@AI แพรวมีงานอะไรค้าง
@AI สรุปงานในกลุ่มวันนี้
@AI เดือนนี้เราทำงานเสร็จไปกี่งาน
```
