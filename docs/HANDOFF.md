# MT Agent 1 — เอกสารส่งต่อ (อัปเดต 1 ก.ย. 2026)

เอกสารนี้มีทุกอย่างที่ต้องรู้เพื่อทำงานต่อจากเครื่องใหม่

## บัญชีและทรัพยากร

| อะไร | ค่า |
|---|---|
| GitHub repo | https://github.com/korrakottum-code/MT-Agent-1 |
| Supabase org | `MT Agent` (Free plan) |
| Supabase project | `MT-Agent-1` — ref `ssjsjvcbulclnvlrkdsj` (region ap-southeast-1) |
| Dashboard | https://supabase.com/dashboard/project/ssjsjvcbulclnvlrkdsj |
| LINE OA | "MT agent 1" (@303dpzyq) — Provider "MarkTech Media" |
| Webhook URL | https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/line-webhook |
| กลุ่มทดสอบ | AA1 |
| ชื่อเล่นที่ทีมเรียกบอท | แงว |

## Secrets (ตั้งไว้แล้วใน Supabase → Edge Functions → Secrets)

ค่าจริงอยู่ในระบบคลาวด์ ไม่มีในเครื่องและไม่มีใน repo — ย้ายเครื่องแล้วไม่ต้องตั้งใหม่

```text
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
ANTHROPIC_API_KEY
ANTHROPIC_WORKSPACE_ID   (จำเป็น เพราะ API key เป็นแบบ identity-linked)
CRON_SECRET              (ค่าเดียวกันนี้ฝังอยู่ในตาราง cron.job ของ database)
```

## สิ่งที่ deploy อยู่บนคลาวด์

- Edge Function `line-webhook` — รับ LINE webhook + AI agent (โมเดล `claude-sonnet-5`) — 20 tools
- Edge Function `scheduled-jobs` — v7, 5 งานตามเวลา
- pg_cron 5 ตัว (เวลาใน cron เป็น UTC, ไทย = UTC+7):
  `daily-summary` 11:00 · `morning-reminder` 02:00 · `weekly-summary` จันทร์ 02:00 ·
  `due-reminders` ทุกนาที · `extract-events` นาที 50 ของ 01/04/07/10/13/16/19/22
  (รอบ 10:50 UTC ตั้งใจให้อยู่ก่อน daily-summary 11:00 พอดี จะได้สรุปเห็นของครบ)
  คำสั่ง cron มี CRON_SECRET ฝังอยู่ จึงไม่ commit ลง repo — ถ้าต้องสร้างใหม่ให้ดูของเดิมด้วย `select command from cron.job`
- ตาราง: `users` (มี job_title, preferences), `groups`, `messages`, `tasks`, `reminders`, `org_settings`, `events`, `audit_logs`
  — RLS เปิดทุกตาราง ไม่มี policy สำหรับ anon (เข้าถึงได้เฉพาะ service_role)

## ข้อสอบของแงว (รันทุกครั้งก่อนและหลังแก้ระบบ)

```bash
pwsh -File tests/run-eval.ps1 -TestKey <CRON_SECRET>
```

ยิงคำถามจริงเข้า agent ผ่าน header `x-test-key` (ค่าเดียวกับ CRON_SECRET) โดยไม่ส่งข้อความเข้า LINE
และไม่บันทึกลงตาราง messages — ตรวจทั้งว่าเรียก tool ถูกตัวไหม และคำตอบผิดกติกาหรือเปล่า
เพิ่มข้อสอบใหม่ได้ที่ `tests/cases.json` ทุกครั้งที่เจอบั๊ก ให้เพิ่มเคสกันไม่ให้กลับมาอีก

กติกา: ต้องผ่านครบทุกข้อก่อนถึงจะขึ้นเฟสถัดไป

## วิธี deploy หลังแก้โค้ด

ตรวจก่อนเสมอ — จับ syntax/type ผิดได้ก่อนขึ้นของจริง

```bash
npx deno@2 check supabase/functions/line-webhook/index.ts supabase/functions/scheduled-jobs/index.ts
```

**วิธีที่ควรใช้ตั้งแต่นี้ไป: Supabase CLI** (เครื่องนี้เรียกผ่าน npx ได้ ไม่ต้องติดตั้ง)

```bash
npx supabase login
npx supabase link --project-ref ssjsjvcbulclnvlrkdsj
npx supabase functions deploy line-webhook
```

`login` ทำครั้งเดียวต่อเครื่อง มันจะเปิดเบราว์เซอร์ให้อนุมัติแล้วเก็บ token ไว้ในโปรไฟล์ผู้ใช้

**ทำไมต้องเลิกใช้วิธีเดิม** — เดิม deploy ผ่าน Supabase MCP ซึ่งต้องแนบซอร์สทั้งไฟล์ไปในคำสั่งเดียว
พอ `line-webhook/index.ts` โตถึง ~55KB ก็เกินขีดจำกัดของช่องทางนั้นและ deploy ไม่ผ่านอีกต่อไป
(ถ้าจำเป็นต้องใช้ MCP จริง ๆ ต้องส่งภาษาไทยเป็น UTF-8 ตรง ๆ ห้าม escape เป็น `\uXXXX`
เพราะตัวอักษรไทยจะกลายเป็น 6 ไบต์แทนที่จะเป็น 3 ทำให้ payload บวมเท่าตัว)

## สถานะตามคู่มือ (docs/BUILD_GUIDE.md)

- ลำดับการสร้างข้อ 1–17 (คู่มือข้อ 22): ผ่านครบ
- MVP 0.1 Definition of Done: ผ่าน เหลือข้อเดียว — ยังไม่ได้ทดสอบว่า EMPLOYEE ถูกปฏิเสธเมื่อขอดูงานคนอื่น (ยังไม่มีพนักงานจริงในระบบ)
- MVP 0.2: ทำแล้ว 5/10 — Daily Summary, Search Message, Search Task, Task Reminder, Overdue Alert
- MVP 0.2 ที่เหลือ: Event Extraction (แม่ของ Auto Task/Decision/Deadline Detection) และ Weekly Summary
- MVP 0.3 Corporate Memory: ยังไม่เริ่ม (ต้องรอ Event Extraction + ข้อมูลจริงสะสม)

## ที่เบี่ยงจากคู่มือโดยตั้งใจ

1. **Hermes** ไม่ได้ใช้ของ Nous Research — บทบาท orchestrator ทำโดยฟังก์ชัน `runAgent()` ใน `line-webhook/index.ts` ซึ่งครอบคลุมหน้าที่ทั้งหมดตามคู่มือข้อ 6
2. **ฟีเจอร์นอกคู่มือ** ที่เพิ่มจาก pain point การใช้จริง: send_dm, rename_group, update_my_profile, remember_preference, อ่านรูป, ความจำบทสนทนา, ค้น/สรุปข้ามกลุ่ม, เอ่ยชื่อบอทแล้วโมเดลตัดสินใจเองว่าจะตอบหรือเงียบ

## พฤติกรรมสำคัญที่ควรรู้ก่อนแก้โค้ด

- **การตอบ**: ในกลุ่มตอบเมื่อแท็ก `@ai` หรือเอ่ยชื่อ (แงว/เอ็มที/mt agent) โดยการเอ่ยชื่อจะให้โมเดลอ่านบริบทแล้วตอบ `SILENT` ถ้าไม่ได้ถูกเรียกจริง / แชทส่วนตัวตอบทุกข้อความโดยไม่ต้องแท็ก
- **ตอบแบบอ้างข้อความ**: ในกลุ่มบอทจะแนบ `quoteToken` ของข้อความต้นทาง คำตอบจึงโผล่เป็น reply ที่อ้างข้อความนั้น
  ในแชทส่วนตัวไม่แนบ เพราะมีบทสนทนาเดียวอยู่แล้ว
- **บทสนทนาเก่าเป็นบริบท ไม่ใช่คิวคำสั่ง** (กฎ 8.1): เคยเจอบั๊กว่าถามเรื่องอื่นแล้วบอทย้อนไปตั้งเตือนซ้ำจากข้อความเก่า
  แก้ทั้งที่ prompt และใส่การกันตั้งซ้ำใน `create_reminder` (ถ้ามีข้อความเดียวกันสถานะ PENDING ในแชทนั้นอยู่แล้ว จะไม่สร้างใหม่)
- **`messages.line_group_id`** ใช้เป็น chat id: กลุ่มเก็บ groupId, แชทส่วนตัวเก็บ userId ของคู่สนทนา
- **คำตอบของบอท** ถูกเก็บลง messages ด้วย โดยใช้ `line_user_id = 'bot'`
- **ความจำ** มี 2 ชั้น: ระยะสั้น (30 ข้อความล่าสุดต่อแชท ส่งเป็นบริบททุกครั้ง) และถาวร (`users.preferences` ต่อคน + `org_settings.bot_persona` ระดับองค์กร)
- **รูป**: DM ส่งรูปตรง ๆ ได้ / ในกลุ่มต้องส่งรูปก่อนแล้วแท็กถามถึง "รูป" ระบบจะดึงรูปล่าสุดภายใน 24 ชม.
- **Event Extraction**: job `extract_events` อ่านบทสนทนาในกลุ่ม (ไม่แตะแชทส่วนตัว) ทุก 3 ชม. แล้วจับ
  งาน/ข้อตกลง/กำหนดส่ง ลงตาราง `events` สถานะ NEW — **ไม่กลายเป็นงานจริงเองเด็ดขาด** ต้องมีคนยืนยัน
  ข้ามกลุ่มที่มีข้อความใหม่น้อยกว่า 3 ข้อความ, ตัดทิ้งของที่ confidence < 0.6, และไม่รับ due_at ที่เกิน ±5 ปี
  (เคยเจอโมเดลตอบเป็น พ.ศ. 2569 ทำให้กำหนดส่งเพี้ยนไป 543 ปี)
  ป้องกันจับซ้ำ 3 ชั้น: ส่งรายการที่เคยจับไปแล้ว + รายชื่องานที่มีในระบบ ไปบอกโมเดล และมี unique index
  `(chat_id, type, title)` เป็นด่านสุดท้าย — รายการที่ถูกปัดทิ้งแล้วจะไม่ถูกเสนอซ้ำ
- **ไฟล์เอกสาร** (ตั้งแต่ v22): PDF ส่งเข้าโมเดลตรง ๆ, Word อ่านด้วย `npm:mammoth`, Excel ด้วย `npm:xlsx`,
  ส่วน txt/md/csv/tsv/json/log อ่านเป็นข้อความ — จำกัด 8MB ต่อไฟล์ และตัดข้อความที่ 120,000 ตัวอักษร
  DM ส่งไฟล์ตรง ๆ ได้ / ในกลุ่มต้องส่งไฟล์ก่อนแล้วแท็กถามถึง "ไฟล์/เอกสาร/สรุปประชุม/รายงาน" ระบบจะดึงไฟล์ล่าสุดภายใน 7 วัน

## งานที่ค้างอยู่ (เรียงตามที่แนะนำ)

1. เอาบอทเข้ากลุ่มงานจริง 2–3 กลุ่ม แล้วสั่ง `แงว ตั้งชื่อกลุ่มนี้ว่า ...` (ต้องเป็น ADMIN)
2. ชวนทีมกดเพิ่ม OA เป็นเพื่อน ไม่งั้นรับ DM และการแจ้งเตือนส่วนตัวไม่ได้
3. ~~ตั้ง role หัวหน้าทีมเป็น MANAGER~~ — ตั้ง XXXXXX เป็น MANAGER แล้วเมื่อ 1 ก.ย. 2026
4. ผูกบัญชี user "แพรว" ที่ยังเป็น `pending:` กับ LINE user id จริง
