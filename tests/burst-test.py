# -*- coding: utf-8 -*-
"""ซ้อมส่งหลายบอลลูนเข้าแงว แล้วนับว่าตอบกี่ครั้ง

มีไว้เพราะเรื่องนี้แก้ผิดมาสามรอบ และทุกรอบตัดสินด้วยการอ่านโค้ดแล้วเดาว่าน่าจะถูก
การซ้อมเดินโค้ดเส้นเดียวกับของจริงทุกบรรทัด ต่างแค่ไม่เรียกโมเดลและไม่ส่งเข้า LINE
จึงตอบได้ตรง ๆ ว่าส่ง N บอลลูนแล้วได้คำตอบกี่ครั้ง

ใช้: python3 tests/burst-test.py <CRON_SECRET>
"""
import json
import sys
import urllib.request

URL = "https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/line-webhook"
KEY = sys.argv[1] if len(sys.argv) > 1 else ""

CASES = [
    ("แชทส่วนตัว ส่งรัว 8 บอลลูนแล้วเคาะว่าสรุป", False, [
        {"text": "จากที่คุยกับทีมคลินิกสาขาอุบล", "gap_ms": 200},
        {"text": "ลูกค้าตั้งแต่ 25 สิงหาคมเป็นกลุ่มที่อัพไม่ได้", "gap_ms": 200},
        {"text": "บางวันก็ไม่มีคิว", "gap_ms": 200},
        {"text": "หลังจาก 25 คิวปิดได้เยอะ แต่ส่วนใหญ่ 499", "gap_ms": 200},
        {"text": "อันนี้คือเสียงสะท้อนจากหน้าร้าน", "gap_ms": 200},
        {"text": "เมื่อวานอุบลสองแสนต้น ๆ", "gap_ms": 200},
        {"text": "จำนวนลูกค้าที่เข้ารับลดลง", "gap_ms": 200},
        {"text": "สรุป", "gap_ms": 0},
    ], 1),
    ("แชทส่วนตัว พิมพ์ช้า ห่างกัน 3 วินาที 4 บอลลูน", False, [
        {"text": "เรื่องงบเดือนนี้", "gap_ms": 3000},
        {"text": "อุบลใช้ไปเท่าไหร่แล้ว", "gap_ms": 3000},
        {"text": "กับขอนแก่นด้วย", "gap_ms": 3000},
        {"text": "สรุปมาให้ที", "gap_ms": 0},
    ], 1),
    ("แชทส่วนตัว ข้อความเดียวโดด ๆ ต้องยังตอบ", False, [
        {"text": "สวัสดีจ้า", "gap_ms": 0},
    ], 1),
    # บอลลูนที่ไม่ได้แท็กจะไม่ถูกตอบอยู่แล้ว บอลลูนที่แท็กจึงถอยให้ใครไม่ได้
    # ข้อนี้จึงวัดว่า "ตอบครั้งเดียว และตอนตอบเห็นครบทุกบอลลูนแล้ว" ไม่ได้วัดว่าอันสุดท้ายเป็นคนตอบ
    ("กลุ่ม แท็กครั้งเดียวแล้วตามด้วยบอลลูนที่ไม่ได้แท็ก", True, [
        {"text": "แงว ช่วยดูให้หน่อย", "gap_ms": 300},
        {"text": "เรื่องยอดอุบล", "gap_ms": 300},
        {"text": "กับคิวที่หายไป", "gap_ms": 0},
    ], 1),
    ("กลุ่ม แท็กสองครั้งคนละเรื่อง ต้องตอบครั้งเดียวที่อันหลัง", True, [
        {"text": "แงว สรุปยอดให้หน่อย", "gap_ms": 400},
        {"text": "แงว แล้วก็ดูคิวด้วย", "gap_ms": 0},
    ], 1),
    # เคสจริงจากแชทตั้ม 12 ก.ย. 11:55 ส่งรูปแล้วพิมพ์ตามสามบอลลูน ได้คำตอบสามครั้ง
    ("แชทส่วนตัว ส่งรูปแล้วพิมพ์ตามอีกสามบอลลูน", False, [
        {"type": "image", "text": "", "gap_ms": 800},
        {"text": "สรุป", "gap_ms": 3500},
        {"text": "ปัญหานี้", "gap_ms": 1800},
        {"text": "Nv clinic", "gap_ms": 0},
    ], 1),
    ("แชทส่วนตัว ส่งสามรูปแล้วพิมพ์ถามตาม", False, [
        {"type": "image", "text": "", "gap_ms": 500},
        {"type": "image", "text": "", "gap_ms": 500},
        {"type": "image", "text": "", "gap_ms": 900},
        {"text": "ดูให้หน่อย", "gap_ms": 0},
    ], 1),
    ("แชทส่วนตัว ส่งสี่รูปเปล่า ๆ ไม่พิมพ์อะไรเลย", False, [
        {"type": "image", "text": "", "gap_ms": 700},
        {"type": "image", "text": "", "gap_ms": 700},
        {"type": "image", "text": "", "gap_ms": 700},
        {"type": "image", "text": "", "gap_ms": 0},
    ], 1),
    ("กลุ่ม ไม่มีใครแท็กเลย ต้องไม่ตอบ", True, [
        {"text": "ยอดเมื่อวานเท่าไหร่นะ", "gap_ms": 300},
        {"text": "เดี๋ยวเช็คให้", "gap_ms": 0},
    ], 0),
]


def run(in_group, bubbles):
    body = json.dumps({"simulate": {"in_group": in_group, "bubbles": bubbles}}).encode()
    req = urllib.request.Request(
        URL, data=body,
        headers={"Content-Type": "application/json", "x-test-key": KEY},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main():
    if not KEY:
        print("ต้องใส่ CRON_SECRET เป็นอาร์กิวเมนต์")
        return 2
    failed = 0
    for name, in_group, bubbles, want in CASES:
        try:
            res = run(in_group, bubbles)
        except Exception as e:
            print("[ERROR] %s -> %s" % (name, str(e)[:120]))
            failed += 1
            continue
        got = res.get("answered", -1)
        seen = (res.get("seen_at_answer") or [0])[0]
        saw_all = seen >= len(bubbles)
        ok = got == want and (want != 1 or saw_all)
        print("%s %s -> ส่ง %s บอลลูน ตอบ %s ครั้ง%s" % (
            "[PASS]" if ok else "[FAIL]",
            name,
            res.get("sent"),
            got,
            "" if want != 1 or saw_all else " (ตอบตอนเห็นแค่ %s จาก %s บอลลูน)" % (seen, len(bubbles)),
        ))
        if not ok:
            failed += 1
    print("\n%s / %s ผ่าน" % (len(CASES) - failed, len(CASES)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
