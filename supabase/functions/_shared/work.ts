// ภาพรวมว่าแต่ละคนทำอะไรอยู่ ใช้ร่วมกันระหว่างคำตอบในไลน์กับหน้าบอร์ด ทั้งสองทางต้องเห็นตัวเลขชุดเดียวกัน
//
// เรียงตามชื่อเสมอ ตั้งใจไม่เรียงตามจำนวนงาน จำนวนข้อไม่ได้บอกว่างานหนัก
// ตัดคลิปห้าคลิปกับตอบแชทห้าข้อไม่เท่ากัน ถ้าเรียงให้จะกลายเป็นการจัดอันดับคน

export const OPEN_TASK_STATUSES = ["TODO", "DOING", "REVIEW", "BLOCKED"];

export type WorkItem = { text: string; state: "DONE" | "TODO" };

// ส่งหลังเที่ยงคืนยังนับเป็นงานของเมื่อวาน ทีมส่ง To do list กันดึก
export function workReportDate(iso: string): string {
  const bkk = new Date(new Date(iso).getTime() + 7 * 3600_000);
  if (bkk.getUTCHours() < 6) bkk.setUTCDate(bkk.getUTCDate() - 1);
  return bkk.toISOString().slice(0, 10);
}

export function buildPeople(
  input: { users: any[]; groups: any[]; reports: any[]; tasks: any[]; now: number; doneLimit?: number },
) {
  const userById = new Map(input.users.map((u) => [u.id, u]));
  const groupById = new Map(input.groups.map((g) => [g.id, g.group_name]));
  const people = new Map<string, any>();
  const person = (id: string) => {
    if (!people.has(id)) {
      const u = userById.get(id);
      people.set(id, {
        user_id: id,
        name: u?.display_name ?? "ไม่ทราบชื่อ",
        line_name: u?.display_name ?? null,
        groups: [] as string[],
        last_report_date: null as string | null,
        report_days: 0,
        done: [] as { date: string; text: string }[],
        pending: [] as string[],
        open_tasks: [] as any[],
        closed_recent: 0,
      });
    }
    return people.get(id);
  };
  const addGroup = (p: any, groupId: string | null) => {
    const name = groupId ? groupById.get(groupId) : null;
    if (name && !p.groups.includes(name)) p.groups.push(name);
  };

  // reports ต้องเรียงใหม่ไปเก่า แถวแรกของแต่ละคนจึงเป็นรายงานล่าสุด
  const days = new Map<string, Set<string>>();
  for (const r of input.reports) {
    if (!r.user_id || !userById.has(r.user_id)) continue;
    const p = person(r.user_id);
    addGroup(p, r.group_id);
    const items = (Array.isArray(r.items) ? r.items : []) as WorkItem[];
    if (!p.last_report_date) {
      p.last_report_date = r.work_date;
      if (r.written_name) p.name = r.written_name;
      p.pending = items.filter((i) => i.state === "TODO").map((i) => i.text);
    }
    if (!days.has(r.user_id)) days.set(r.user_id, new Set());
    days.get(r.user_id)!.add(r.work_date);
    for (const i of items) if (i.state === "DONE") p.done.push({ date: r.work_date, text: i.text });
  }
  for (const [id, d] of days) people.get(id).report_days = d.size;

  for (const t of input.tasks) {
    if (!t.owner_user_id || !userById.has(t.owner_user_id)) continue;
    const p = person(t.owner_user_id);
    addGroup(p, t.group_id);
    if (t.status === "DONE") {
      p.closed_recent++;
      continue;
    }
    if (!OPEN_TASK_STATUSES.includes(t.status)) continue;
    p.open_tasks.push({
      id: t.id,
      title: t.title,
      status: t.status,
      due_at: t.due_at,
      overdue: Boolean(t.due_at && new Date(t.due_at).getTime() < input.now),
      ordered_by: userById.get(t.created_by_user_id)?.display_name ?? null,
      group: t.group_id ? groupById.get(t.group_id) ?? null : null,
      started_at: t.started_at ?? null,
      blocked_reason: t.blocked_reason ?? null,
      branch: t.branch ?? null,
      monday_code: t.monday_code ?? null,
    });
  }

  const limit = input.doneLimit ?? 30;
  return [...people.values()]
    .map((p) => ({ ...p, done: p.done.slice(0, limit) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "th"));
}

export async function loadTeamWork(sb: any, opts: { userId?: string | null; days?: number; doneLimit?: number; withReports?: boolean }) {
  const days = Math.min(30, Math.max(1, Number(opts.days ?? 7)));
  const now = Date.now();
  const since = new Date(now - days * 24 * 3600_000).toISOString();
  const sinceDate = since.slice(0, 10);

  let reportQuery = sb.from("work_reports")
    .select("user_id, written_name, group_id, work_date, items")
    .gte("work_date", sinceDate)
    .order("work_date", { ascending: false }).limit(1000);
  let taskQuery = sb.from("tasks")
    .select("id, title, status, due_at, completed_at, owner_user_id, created_by_user_id, group_id, started_at, blocked_reason, branch, monday_code")
    .or(`status.in.(${OPEN_TASK_STATUSES.join(",")}),and(status.eq.DONE,completed_at.gte.${since})`)
    .order("due_at", { ascending: true, nullsFirst: false }).limit(1000);
  if (opts.userId) {
    reportQuery = reportQuery.eq("user_id", opts.userId);
    taskQuery = taskQuery.eq("owner_user_id", opts.userId);
  }
  // To do list หยุดเก็บแล้ว (WORK_REPORTS_ON ใน scheduled-jobs) หน้าบอร์ดจึงไม่ดึงของเก่ามาโชว์
  const [reports, tasks, users, groups] = await Promise.all([
    opts.withReports === false ? Promise.resolve({ data: [], error: null }) : reportQuery,
    taskQuery,
    sb.from("users").select("id, display_name, is_active").eq("is_active", true),
    sb.from("groups").select("id, group_name"),
  ]);
  if (reports.error) throw new Error(reports.error.message);
  if (tasks.error) throw new Error(tasks.error.message);
  return buildPeople({
    users: users.data ?? [],
    groups: groups.data ?? [],
    reports: reports.data ?? [],
    tasks: tasks.data ?? [],
    now,
    doneLimit: opts.doneLimit,
  });
}
