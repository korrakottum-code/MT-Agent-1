// งบโฆษณา Meta ของ Class Clinic สำหรับเครื่องมือ clinic_meta_ads
//
// อ่านจาก Korrakot-DB ช่อง /api/external/ads-spend ซึ่งรวม ad_daily_metrics ของทุกบัญชีโฆษณา (ตัดบัญชีซ้ำแล้ว)
// ห้ามเปลี่ยนไปใช้ branch-metrics: ช่องนั้นนับงบได้แค่ราว 74% ของจริง (ตรวจแล้ว 5 พ.ย. 2569)
// ช่องนี้ให้แค่งบ ไม่มีจำนวนคนทักหรือคิวจากแอด ถ้าถูกถามเรื่องนั้นต้องบอกตรง ๆ ว่ายังไม่มี

import { baht, thaiDate, thaiRange } from "./clinic_sales.ts";

export type SpendResponse = { since: string; until: string; spend: number; daily?: { day: string; spend: number }[] };

export type AdsResult = {
  source: string;
  period: { from: string; to: string; last_day_with_spend: string | null };
  spend: number;
  compare?: { from: string; to: string; spend: number; change_pct: number | null };
  note: string;
};

const pct = (cur: number, prev: number) => prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10;

export function adsResult(cur: SpendResponse, prev: SpendResponse | null): AdsResult {
  const days = (cur.daily ?? []).map((d) => d.day).sort();
  const out: AdsResult = {
    source: "งบโฆษณา Meta ทุกบัญชี จากฐาน Korrakot-DB",
    period: { from: cur.since, to: cur.until, last_day_with_spend: days.at(-1) ?? null },
    spend: Math.round(cur.spend),
    note: "มีแค่งบโฆษณา Meta ไม่มีจำนวนคนทักหรือคิวจากแอด · งบของวันนี้ยังไม่จบวัน",
  };
  if (prev) out.compare = { from: prev.since, to: prev.until, spend: Math.round(prev.spend), change_pct: pct(cur.spend, prev.spend) };
  return out;
}

export function formatAdsThai(r: AdsResult): string {
  const lines = [`งบโฆษณา Meta ${thaiRange(r.period)} ทั้งเครือ`, baht(r.spend)];
  if (r.compare) {
    const p = r.compare.change_pct;
    lines.push(`เทียบ ${thaiRange(r.compare)}: ${baht(r.compare.spend)} (${p == null ? "ไม่มีฐานเทียบ" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`})`);
  }
  if (r.period.last_day_with_spend && r.period.last_day_with_spend < r.period.to) {
    lines.push(`มีงบถึง ${thaiDate(r.period.last_day_with_spend)}`);
  }
  lines.push("", "ที่มา: ฐานแอด Korrakot-DB ทุกบัญชี Meta");
  return lines.join("\n");
}
