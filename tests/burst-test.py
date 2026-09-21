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
    # เคสจริง 15 ก.ย. แงวเพิ่งตอบ ตั้มส่งรูปแล้วพิมพ์ "ขอรหัส" โดยไม่เรียกชื่อ แงวเงียบ ทองพิมพ์ "แม่งเงียบเลย"
    ("กลุ่ม แงวเพิ่งตอบ แล้วส่งรูปตามด้วยขอรหัสโดยไม่เรียกชื่อ", True, [
        {"type": "image", "text": "", "gap_ms": 1500},
        {"text": "ขอรหัส", "gap_ms": 0},
    ], 1, {"prior_bot": True}),
    # เคสจริง 21 ก.ย. กลุ่มงานทอง แงวเพิ่งตอบ แล้วตั้มพิมพ์สามบอลลูนโดยไม่เรียกชื่อ แงวตอบสามครั้ง
    ("กลุ่ม แงวเพิ่งตอบ แล้วพิมพ์สามบอลลูนไม่เรียกชื่อ", True, [
        {"text": "5555", "gap_ms": 1200},
        {"text": "ได้หรอว่ากุยังไม่มั่นใจ", "gap_ms": 1400},
        {"text": "ไหนสร้างส่งมา", "gap_ms": 0},
    ], 1, {"prior_bot": True}),
    # มีคนอื่นพูดแทรกหลังแงวตอบ บทสนทนาเปลี่ยนมือไปแล้ว "ขอรหัส" ของคนแรกต้องไม่ผ่านด่าน
    # ส่วนข้อความของคนที่พูดต่อจากแงวทันทีผ่านด่านได้ เพราะด่านนี้แค่ส่งให้โมเดลตัดสินว่าจะตอบหรือเงียบ
    ("กลุ่ม แงวเพิ่งตอบ แต่มีคนอื่นพูดแทรกก่อน", True, [
        {"text": "เดี๋ยวผมจัดการเอง", "from": "other", "gap_ms": 1200},
        {"text": "ขอรหัส", "gap_ms": 0},
    ], 1, {"prior_bot": True, "expect_ids": [0]}),
    ("กลุ่ม ไม่มีใครแท็กเลย ต้องไม่ตอบ", True, [
        {"text": "ยอดเมื่อวานเท่าไหร่นะ", "gap_ms": 300},
        {"text": "เดี๋ยวเช็คให้", "gap_ms": 0},
    ], 0),
]

# เคสจริง 21 ก.ย. ทองฝากเตือนงาน แงวถามเวลา ตั้มตอบรายละเอียดโดยไม่แท็ก แล้วแท็กเปล่า ๆ ตามมา
# แงวทักทายเฉย ๆ ไม่พูดถึงเรื่องค้างเลย ต้นเหตุคือแท็กเปล่าถูกแปลงเป็นคำว่า "สวัสดี" ตรง ๆ ก่อนส่งให้โมเดล
# นี่คือชุดเดียวที่เรียกโมเดลจริงผ่านโค้ดจริง (capture_answer) ไม่ใช่แค่ดูว่าตอบหรือเงียบ
CONTENT_CASES = [
    ("กลุ่ม แท็กเปล่า ๆ ต้องหยิบเรื่องค้างจากประวัติ ไม่ใช่แค่ทักทาย", {
        "in_group": True,
        "capture_answer": True,
        "bubbles": [
            {"text": "แงว ฝากเตือนงานพรุ่งนี้ให้หน่อย\n\nมีตาม aw มุกดาหาร กับ ยโสธร", "gap_ms": 1500},
            {"text": "6.00-18.00 ทุก1ชั่วโมง จนกว่าจะเสร็จ", "gap_ms": 4000},
            {"text": "@MT agent 1", "gap_ms": 0},
        ],
    }, {
        "forbid": r"^(สวัสดี|หวัดดี|แงวอยู่นี่แล้ว|แงวมาแล้ว)ค่ะ?ะ?พี่?ตั้ม[^\n]{0,30}(มีอะไรให้แงวช่วย|พร้อมเสมอ|พร้อมลุย|พร้อมรับใช้)",
        "expect": r"มุกดาหาร|ยโสธร|เตือนซ้ำ|ทุก\s?1\s?ชั่วโมง|ทุกชั่วโมง",
    }),
]


def run(in_group, bubbles, extra=None):
    body = json.dumps({"simulate": {"in_group": in_group, "bubbles": bubbles, **(extra or {})}}).encode()
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
    for case in CASES:
        name, in_group, bubbles, want = case[:4]
        extra = dict(case[4]) if len(case) > 4 else {}
        expect_ids = extra.pop("expect_ids", None)
        try:
            res = run(in_group, bubbles, extra)
        except Exception as e:
            print("[ERROR] %s -> %s" % (name, str(e)[:120]))
            failed += 1
            continue
        got = res.get("answered", -1)
        seen = (res.get("seen_at_answer") or [0])[0]
        saw_all = seen >= len([b for b in bubbles if b.get("from") != "other"])
        ok = got == want and (want != 1 or saw_all or expect_ids is not None)
        if expect_ids is not None:
            got_idx = sorted(int(x.rsplit("-", 1)[1]) for x in res.get("answered_ids", []))
            ok = ok and got_idx == sorted(expect_ids)
        print("%s %s -> ส่ง %s บอลลูน ตอบ %s ครั้ง%s" % (
            "[PASS]" if ok else "[FAIL]",
            name,
            res.get("sent"),
            got,
            "" if want != 1 or saw_all else " (ตอบตอนเห็นแค่ %s จาก %s บอลลูน)" % (seen, len(bubbles)),
        ))
        if not ok:
            failed += 1
    import re as _re
    for name, extra, checks in CONTENT_CASES:
        try:
            res = run(extra.get("in_group", True), extra["bubbles"],
                      {k: v for k, v in extra.items() if k not in ("in_group", "bubbles")})
        except Exception as e:
            print("[ERROR] %s -> %s" % (name, str(e)[:150]))
            failed += 1
            continue
        ans = res.get("captured_answer") or ""
        bad = checks.get("forbid") and _re.search(checks["forbid"], ans)
        good = (not checks.get("expect")) or _re.search(checks["expect"], ans)
        ok = (not bad) and good
        print("%s %s" % ("[PASS]" if ok else "[FAIL]", name))
        print("   คำตอบจริง:", ans[:200].replace("\n", " / "))
        if not ok:
            failed += 1

    total = len(CASES) + len(CONTENT_CASES)
    print("\n%s / %s ผ่าน" % (total - failed, total))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
