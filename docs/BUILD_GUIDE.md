# AI Organization on LINE — Detailed Build Guide (No-Code Friendly)

> เป้าหมาย: สร้าง AI กลางขององค์กรที่อยู่ใน LINE Group, รู้จักว่าใครพูด, เก็บงาน, ค้นข้อมูล, สรุป, วิเคราะห์ และเรียกใช้ Tools ผ่าน Hermes ได้

## แนวคิดหลัก

```text
LINE = หน้าบ้าน
Hermes = ผู้จัดการ AI
LLM = สมองที่ใช้คิด
Supabase/Postgres = ความจริงของบริษัท
Tools = มือและขาของ AI
Backend = สะพานเชื่อมทุกอย่าง
```

---

# 0. ภาพรวมก่อนเริ่ม

## Architecture Version 0.1

```text
พนักงาน
  ↓
LINE Group
  ↓
LINE OA
  ↓
Webhook
  ↓
Backend
  ↓
Identity + Permission
  ↓
Hermes Agent
  ↓
Tools
  ├── create_task
  ├── get_my_tasks
  ├── get_user_tasks
  ├── update_task
  ├── search_messages
  └── get_group_summary
  ↓
Supabase / PostgreSQL
  ↓
Hermes
  ↓
LLM
  ↓
ตอบกลับ LINE
```

# 1. เป้าหมาย MVP แรก

MVP แรกต้องทำให้คำสั่งต่อไปนี้ใช้งานได้จริงใน LINE Group

```text
@AI สร้างงานให้แพรวทำภาพโปร ส่งพรุ่งนี้
@AI วันนี้ฉันมีงานอะไร
@AI แพรวมีงานอะไรค้าง
@AI สรุปงานในกลุ่มวันนี้
@AI เดือนนี้เราทำงานเสร็จไปกี่งาน
```

## เกณฑ์ผ่าน MVP 0.1

- [ ] Bot เข้า LINE Group ได้
- [ ] พนักงานแท็ก `@AI` แล้ว Bot ตอบ
- [ ] Bot รู้ว่าใครเป็นคนถาม
- [ ] Bot รู้ว่าอยู่กลุ่มไหน
- [ ] Bot สร้าง Task ได้
- [ ] Bot อ่าน Task ได้
- [ ] Bot อัปเดต Task ได้
- [ ] Bot สรุปข้อความในกลุ่มได้
- [ ] Bot Query จำนวนงานตามช่วงเวลาได้
- [ ] ทุก Action มี Log

# 2. Phase 1 — เตรียม LINE OA

## 2.1 สร้าง LINE Official Account

สร้าง LINE OA สำหรับ AI โดยเฉพาะ

ชื่อชั่วคราวแนะนำ:

```text
Company AI
Team AI
Office AI
AI Assistant
```

ยังไม่ต้องใช้ชื่อจริงของแบรนด์ในช่วงทดสอบ

## 2.2 เปิด Messaging API

ต้องเปิด:

- [ ] Messaging API
- [ ] Webhook
- [ ] Allow bot to join group chats
- [ ] Auto-reply ปิดหรือจัดการให้ไม่ชนกับระบบเรา

## 2.3 สิ่งที่ต้องเก็บไว้

ห้ามส่งลง GitHub หรือวางในไฟล์สาธารณะ

```text
LINE_CHANNEL_ID
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
```

## 2.4 สิ่งที่ต้องทดสอบ

- [ ] เพิ่ม OA เป็นเพื่อน
- [ ] เชิญ OA เข้า Group ทดลอง
- [ ] OA อยู่ใน Group ได้จริง
- [ ] LINE ส่ง Webhook มาหา Backend ได้

## เกณฑ์ผ่าน Phase 1

เมื่อพิมพ์ข้อความใน LINE Group แล้ว Backend เห็น Event จาก LINE

# 3. Phase 2 — Backend

Backend มีหน้าที่เป็นสะพาน

```text
LINE
↓
Backend
↓
Hermes
↓
Database / Tools
```

## 3.1 Backend ต้องทำอะไร

- [ ] รับ LINE Webhook
- [ ] Verify Signature
- [ ] อ่าน User ID
- [ ] อ่าน Group ID
- [ ] อ่าน Message
- [ ] ตรวจว่ามีการเรียก AI หรือไม่
- [ ] ส่ง Context ให้ Hermes
- [ ] รับผลลัพธ์จาก Hermes
- [ ] ส่งข้อความกลับ LINE

## 3.2 Event พื้นฐานที่ควรเก็บ

```yaml
event_type: message
line_user_id: Uxxxxxxxx
line_group_id: Cxxxxxxxx
message_text: "@AI วันนี้ฉันมีงานอะไร"
timestamp: 2026-09-01T13:00:00+07:00
```

## 3.3 Logic เบื้องต้น

```text
ถ้าไม่มี @AI
→ เก็บข้อความ
→ ไม่จำเป็นต้องตอบ

ถ้ามี @AI
→ เก็บข้อความ
→ Resolve Identity
→ เช็ค Permission
→ ส่งเข้า Hermes
→ Execute Tool ถ้าจำเป็น
→ ส่งคำตอบกลับ
```

## เกณฑ์ผ่าน Phase 2

พิมพ์ `@AI สวัสดี` ใน Group แล้วระบบตอบกลับได้

# 4. Phase 3 — Supabase / Database

Supabase คือ Source of Truth

ห้ามออกแบบให้ AI "จำเอง" แล้วถือว่าเป็นข้อมูลจริง

## 4.1 ตารางขั้นต่ำ

เริ่มจาก 4 ตาราง

```text
users
groups
messages
tasks
```

## 4.2 ตาราง users

ตัวอย่าง Field:

```text
id
line_user_id
display_name
employee_code
department
role
manager_user_id
is_active
created_at
updated_at
```

## 4.3 ตาราง groups

```text
id
line_group_id
group_name
department
project_name
is_active
created_at
```

## 4.4 ตาราง messages

```text
id
line_message_id
line_user_id
line_group_id
message_text
message_type
created_at
```

ใช้สำหรับ Search, Summary, Context, Audit และ Analytics ในอนาคต

## 4.5 ตาราง tasks

```text
id
title
description
owner_user_id
created_by_user_id
group_id
status
priority
due_at
source_message_id
created_at
updated_at
completed_at
```

### Status

```text
TODO
DOING
DONE
CANCELLED
```

# 5. Phase 4 — Identity

AI ต้องรู้ว่า "ฉัน" คือใคร และ "แพรว" คือ User ID ไหน

## Flow

```text
LINE User ID
↓
users table
↓
พบว่า = แพรว
↓
Department = Marketing
↓
Role = Designer
```

## ต้องรองรับ

- [ ] คนเดียวอยู่หลาย Group
- [ ] ชื่อเล่นซ้ำกัน
- [ ] เปลี่ยนชื่อ LINE
- [ ] พนักงานลาออก
- [ ] พนักงานใหม่
- [ ] Manager / Team Mapping

# 6. Phase 5 — Hermes อยู่ตรงไหน

Hermes ไม่ใช่ Database
Hermes ไม่ใช่ LINE
Hermes ไม่ใช่ข้อมูลบริษัท

Hermes คือ:

> Agent Orchestrator / ผู้จัดการ AI

## หน้าที่ Hermes

- [ ] อ่าน Intent
- [ ] วางแผน
- [ ] เลือก Tool
- [ ] เรียก Tool
- [ ] เรียก Tool ต่อหลายขั้น
- [ ] เรียก Skill
- [ ] เรียก Sub-Agent ในอนาคต
- [ ] รวมผลลัพธ์
- [ ] ส่งให้ LLM ช่วยสรุป/วิเคราะห์
- [ ] ตอบกลับ Backend

# 7. Phase 6 — Tools รุ่นแรก

เริ่มเพียง 6 Tools

## Tool 1 — create_task()

สร้าง Task จากภาษาปกติ

## Tool 2 — get_my_tasks()

ดึงงานของคนที่กำลังถาม

## Tool 3 — get_user_tasks()

ดึงงานของคนอื่น โดยต้องผ่าน Permission

## Tool 4 — update_task()

อัปเดตสถานะ/Deadline/Owner

## Tool 5 — search_messages()

ค้นข้อความเก่า

## Tool 6 — get_group_summary()

สรุปสิ่งสำคัญของกลุ่มตามช่วงเวลา

# 8. Phase 7 — Message Intelligence

เวอร์ชันแรก:

```text
ทุก Message
→ เก็บ Raw Message

เฉพาะ Message ที่ @AI
→ Hermes วิเคราะห์และ Action
```

เวอร์ชันต่อไป:

```text
ทุก Message
→ Event Extractor
→ TASK
→ DECISION
→ DEADLINE
→ IDEA
→ RESULT
```

# 9. Phase 8 — Model

MVP แรกใช้ Model เดียวก่อน

ต้องทำได้ดีในเรื่อง:

- ภาษาไทย
- Tool Calling
- JSON / Structured Output
- Reasoning
- Context

หลัง MVP ผ่านค่อยแบ่ง:

```text
Fast Model → classify / extract
Main Model → chat / tool calling
Reasoning Model → analytics / strategy
```

# 10. Phase 9 — Permission

ต้องมีตั้งแต่ต้น

## Role ตัวอย่าง

```text
EMPLOYEE
MANAGER
ADMIN
EXECUTIVE
```

### Employee
- ดู Task ตัวเอง
- สร้าง Task
- อัปเดต Task ตัวเอง
- ดู Summary กลุ่มที่อยู่

### Manager
- ดู Task ทีม
- ดูงานค้าง
- ดู Summary ทีม
- Assign งาน

### Executive
- ดูหลายทีม
- ถาม Analytics
- ดู KPI
- ดู Cross-Team Summary

### Admin
- จัดการ User
- จัดการ Group
- แก้ Mapping
- ดู Audit

# 11. Phase 10 — Audit Log

สร้างตาราง `audit_logs`

```text
id
user_id
action
tool_name
input
result
status
created_at
```

ทุก Action ของ AI ต้องตรวจสอบย้อนหลังได้

# 12. Phase 11 — Confirmation

ไม่ต้อง Confirm:
- ค้นข้อมูล
- สรุป
- ดู Task
- ดูข้อความ

ควร Confirm:
- ลบ Task
- ส่งประกาศทั้งบริษัท
- เปลี่ยน Deadline จำนวนมาก
- แก้ข้อมูลสำคัญ
- ส่ง DM จำนวนมาก

# 13. Phase 12 — Test Scenario

## Test 1
`@AI สร้างงานให้แพรวทำภาพโปร ส่งพรุ่งนี้ 15:00`

Expected:
- สร้าง Task
- Owner = แพรว
- Due = พรุ่งนี้ 15:00
- Created by = คนสั่ง

## Test 2
แพรวถาม `@AI วันนี้ฉันมีงานอะไร`

Expected:
- เห็น Task ของแพรว

## Test 3
Manager ถาม `@AI วันนี้ทีมมีงานอะไรค้าง`

Expected:
- Query งานของทีม
- เรียง Deadline

## Test 4
`@AI สรุปกลุ่มวันนี้`

Expected:
- สรุปจาก messages table

## Test 5
`@AI เดือนนี้เราทำงานเสร็จไปกี่งาน`

Expected:
- Query tasks
- status = DONE
- ช่วงเวลา = เดือนนี้

# 14. MVP 0.1 — Definition of Done

- [ ] LINE OA เข้า Group ได้
- [ ] `@AI` แล้วตอบ
- [ ] Identity ใช้งานจริง
- [ ] สร้าง Task ผ่านภาษาปกติ
- [ ] ดู Task ตัวเอง
- [ ] ดู Task คนอื่นตาม Permission
- [ ] Update Task
- [ ] Summary Group
- [ ] Query Metrics ง่าย ๆ
- [ ] Audit Log
- [ ] ไม่มีข้อมูลสำคัญเก็บอยู่ใน LLM Memory เพียงอย่างเดียว

# 15. MVP 0.2 — เพิ่ม Intelligence

- [ ] Event Extraction จากข้อความทั่วไป
- [ ] Auto Task Detection
- [ ] Decision Detection
- [ ] Deadline Detection
- [ ] Daily Summary อัตโนมัติ
- [ ] Weekly Summary
- [ ] Search Message
- [ ] Search Task
- [ ] Task Reminder
- [ ] Overdue Alert

# 16. MVP 0.3 — Corporate Memory

```text
Raw Messages
↓
Structured Events
↓
Tasks / Decisions / Results
↓
Memory
↓
Analytics
```

รองรับคำถาม:
- เดือนนี้เราทำภาพไปกี่รูป
- โปรไหนทำภาพเยอะที่สุด
- เรื่องนี้เคยตัดสินใจกันหรือยัง
- ใครเป็นคนตัดสินใจ
- เดือนนี้งานเยอะกว่าเดือนก่อนหรือไม่

# 17. MVP 0.4 — AI Analyst

AI เริ่มตอบว่า "แล้วควรทำอะไรต่อ"

```text
Query Data
↓
Find Pattern
↓
Reason
↓
Recommendation
```

# 18. MVP 1.0 — AI Organization

- [ ] CEO Mode
- [ ] Manager Mode
- [ ] Marketing Agent
- [ ] Data Analyst Agent
- [ ] HR Agent
- [ ] Task Agent
- [ ] Multi-Agent Delegation
- [ ] Google Drive
- [ ] Calendar
- [ ] Dashboard
- [ ] Admin Console
- [ ] Corporate Search
- [ ] Campaign Analytics
- [ ] Creative Analytics

# 19. Multi-Agent ในอนาคต

```text
Company AI
  │
  ├── Task Agent
  ├── Data Analyst Agent
  ├── Marketing Agent
  ├── HR Agent
  └── CEO Agent
```

Hermes ทำหน้าที่ Orchestrate

# 20. CEO Mode

คำถามหลัก:

`@AI วันนี้มีอะไรที่ฉันควรรู้`

ตอบเฉพาะ:
1. งานเสี่ยง
2. Deadline ใกล้
3. KPI ผิดปกติ
4. Decision ที่รอ
5. งานไม่มี Owner
6. ปัญหาซ้ำ
7. Recommendation

# 21. สิ่งที่ไม่ควรทำใน Version แรก

- อย่าเริ่มจาก 20 Agents
- อย่าสร้าง Knowledge Graph ก่อน
- อย่าใส่ Vector DB ถ้ายังไม่ต้องใช้
- อย่าสร้าง Dashboard ใหญ่ก่อน
- อย่าทำ Model Router ซับซ้อนก่อน
- อย่าพยายามอ่านทุกระบบบริษัทตั้งแต่วันแรก
- อย่าใช้ AI Memory เป็น Source of Truth

# 22. ลำดับการสร้างที่แนะนำ

```text
1. LINE OA
2. Webhook
3. Backend
4. Supabase
5. users
6. groups
7. messages
8. tasks
9. Identity
10. Hermes
11. create_task tool
12. get_my_tasks tool
13. update_task tool
14. group_summary
15. Permission
16. Audit
17. Testing
```

ห้ามกระโดดไป Multi-Agent ก่อนข้อ 1–17 ผ่าน

# 23. User Experience ที่ต้องการ

พนักงานควรรู้สึกว่า:

> แค่เพิ่ม AI เข้ากลุ่ม แล้วคุยเหมือนคุยกับคน

ไม่ควรต้องเรียน Syntax
ไม่ควรต้องจำ Command
ไม่ควรต้องกรอกรหัสทุกครั้ง

ตัวอย่างที่ดี:

`@AI พรุ่งนี้เตือนแพรวส่งภาพก่อนเที่ยงนะ`

ไม่ใช่:

`/create_task --owner=praew --date=2026-09-02 --time=12:00`

# 24. Data Ownership

ข้อมูลสำคัญทั้งหมดต้องอยู่ในระบบของเรา

```text
Employees
Tasks
Messages
Campaigns
Creative
KPI
Decisions
Permissions
Audit Logs
```

Hermes และ LLM สามารถเปลี่ยนได้

Database ต้องไม่ผูกกับ Provider ใด Provider หนึ่ง

# 25. Final Architecture

```text
                  LINE
                   │
                Webhook
                   │
             Identity Layer
                   │
            Permission Layer
                   │
              Hermes Agent
          ┌────────┼────────┐
          │        │        │
        Skills    Tools   Sub-Agents
          │        │        │
          └────────┼────────┘
                   │
              Model Layer
                   │
        ┌──────────┼──────────┐
        │          │          │
      Fast       Main      Reasoning
      Model      Model       Model
                   │
            Knowledge / Data
                   │
      ┌────────────┼────────────┐
      │            │            │
   Supabase      Drive       Calendar
      │
 ┌────┼────┬──────┬──────┐
Users Groups Tasks Messages Metrics
      │
    Audit
```

# 26. คำจำง่าย ๆ

```text
LINE = ปากและหู
Hermes = ผู้จัดการ
LLM = สมอง
Tools = มือ
Supabase = ความจำจริง
Permission = กุญแจ
Audit = กล้องวงจรปิด
```

# 27. จุดเริ่มต้นวันนี้

1. สร้าง LINE OA ทดลอง
2. เปิด Messaging API
3. สร้าง Group ทดลอง
4. เชิญ Bot เข้า Group
5. สร้าง Backend รับ Webhook
6. ให้ `@AI สวัสดี` ตอบได้
7. สร้าง Supabase
8. สร้าง `users / groups / messages / tasks`
9. ต่อ Identity
10. เสียบ Hermes
11. ทำ Tool แรก `create_task()`
12. ทดสอบ `@AI สร้างงานให้แพรวทำภาพโปร ส่งพรุ่งนี้ 15:00`

ถ้าข้อนี้ทำงานจริง ถือว่าเราเริ่มมี AI องค์กรตัวแรกแล้ว

# 28. Checklist สำหรับทีม Dev / Coding Agent

- [ ] LINE webhook works
- [ ] signature verification works
- [ ] group event works
- [ ] user mapping works
- [ ] group mapping works
- [ ] messages stored
- [ ] task schema complete
- [ ] Hermes receives context
- [ ] Hermes can call tools
- [ ] create_task works
- [ ] get_my_tasks works
- [ ] get_user_tasks works
- [ ] update_task works
- [ ] summary works
- [ ] permission works
- [ ] audit works
- [ ] error handling works
- [ ] production secrets protected

# 29. Principle

อย่าสร้าง "Chatbot ที่เก่ง"

ให้สร้าง:

> "ระบบองค์กรที่ AI สามารถเข้าใจ ใช้ข้อมูล และลงมือทำงานแทนคนได้"

```text
Conversation
↓
Structured Data
↓
Knowledge
↓
Analytics
↓
Reasoning
↓
Action
```

นี่คือแกนของ AI Organization บน LINE
