// 라칸 일정 데이터를 EZ.WORK 로 옮긴다 (docs/일정.md 8장, docs/플래너.md 5장). 한 번만 쓰는 스크립트.
// ez-work 는 kv 를 읽지 않는다 — 에이전트가 미리 저장소 밖에 뽑아 둔 백업 파일만 읽는다.
//
//   npx tsx scripts/import-rakan-plan.ts <plan 백업.json> <study 백업.json>          → 무엇을 넣을지 요약만
//   npx tsx scripts/import-rakan-plan.ts <plan 백업.json> <study 백업.json> --apply  → 실제로 넣기
//
// 넣는 것: 지점 · 이동시간 · 설정 · 내 일정(+예외) · 할 일 → 직접, 스큐 근무 · 대학 수업 → ez_schedule_sync (바깥 일정)
// 이미 지점이 있으면 옮긴 것으로 보고 멈춘다. 중간에 실패하면 이번에 만든 것을 지운다.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../mcp/env";
import { addDays, dateRange, weekday } from "../lib/schedule/dates";

type RkPlace = { id: string; name: string };
type RkRepeat = null | { freq: string; days?: number[]; until?: string | null };
type RkEvent = {
  id: string;
  title: string;
  date: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  place: string;
  placeId: string;
  travelMin: number | null;
  note: string;
  repeat: RkRepeat;
  exceptions: Record<string, { skip?: boolean; date?: string; start?: number; end?: number; title?: string; place?: string }>;
};
type RkTask = {
  id: string;
  title: string;
  note: string;
  due: string | null;
  duration: number;
  done: boolean;
  doneAt: string | null;
  slot: { date: string; start: number } | null;
};
type RkShift = { id: string; date: string; start: number; end: number; title: string; place: string };
type RkCourse = { id: string; name: string; room: string; meetings: { id: string; day: number; start: number; end: number; room: string }[] };

const [planFile, studyFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
if (!planFile || !studyFile) {
  console.error("쓰는 법: npx tsx scripts/import-rakan-plan.ts <plan 백업.json> <study 백업.json> [--apply]");
  process.exit(1);
}

const backup = JSON.parse(readFileSync(planFile, "utf8")) as { rows: { k: string; v: unknown }[] };
const plan = backup.rows.find((r) => r.k === "plan")?.v as {
  events: RkEvent[];
  tasks: RkTask[];
  settings: { places: RkPlace[]; travel: Record<string, number>; homeId: string; workPlaceId: string; schoolPlaceId: string; prepMin: number; mealMin: number };
  classOverrides?: Record<string, Record<string, { skip?: boolean }>>;
};
const work = backup.rows.find((r) => r.k === "work")?.v as { shifts: RkShift[] } | undefined;
const study = (JSON.parse(readFileSync(studyFile, "utf8")) as { row: { v: { startDate: string; endDate: string; holidays: { date: string }[]; courses: RkCourse[] } } }).row.v;
if (!plan?.events || !plan.settings) throw new Error("plan 백업 파일 모양이 다릅니다");

const loaded = loadEnv();
if ("error" in loaded) throw new Error(loaded.error);
const { env } = loaded;
const owner = env.EZ_OWNER_ID;
const db = createClient(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const blank = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const st = plan.settings;
const roleOf = (id: string) => (id === st.homeId ? "home" : id === st.workPlaceId ? "work" : id === st.schoolPlaceId ? "school" : null);
const ROLE_ORDER = { home: 0, work: 1, school: 2 } as const;

// ---------- 무엇을 넣을지 ----------
const places = st.places.map((p, i) => ({ old: p.id, name: p.name.trim(), role: roleOf(p.id), sort: i }));
const travel = Object.entries(st.travel).map(([k, minutes]) => {
  const [a, b] = k.split("|") as [string, string];
  return { a, b, minutes };
});
const settings = { prep_first: st.prepMin, prep_again: Math.min(st.prepMin, 10), home_stay: 50, meal_min: st.mealMin };

const toRepeat = (r: RkRepeat) => {
  if (!r) return null;
  const until = r.until ?? undefined;
  if (r.freq === "daily") return { freq: "daily", ...(until ? { until } : {}) };
  const days = [...new Set((r.days ?? []).map((d) => (d === 0 ? 7 : d)))].sort();
  return { freq: "weekly", days, ...(until ? { until } : {}) };
};
const events = plan.events.map((e) => ({
  old: e.id,
  title: e.title.trim(),
  date: e.date,
  start_min: e.allDay ? null : e.start,
  end_min: e.allDay ? null : e.end,
  placeOld: blank(e.placeId),
  where_text: blank(e.place),
  travel_min: e.travelMin && e.travelMin > 0 ? e.travelMin : null,
  note: blank(e.note),
  repeat: toRepeat(e.repeat),
  exceptions: Object.entries(e.exceptions ?? {}).map(([on, x]) => {
    if (x.skip) return { on_date: on, skip: true, patch: null };
    const patch: Record<string, unknown> = {};
    if (x.date) patch.date = x.date;
    if (x.start !== undefined && x.end !== undefined) Object.assign(patch, { start_min: x.start, end_min: x.end });
    if (x.title) patch.title = x.title.trim();
    if (x.place !== undefined) patch.where_text = blank(x.place);
    return { on_date: on, skip: false, patch };
  }),
}));
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const tasks = plan.tasks.map((t, i) => ({
  title: t.title.trim(),
  note: blank(t.note),
  due: t.due,
  est_min: Math.min(600, Math.max(5, t.duration || 60)),
  sort: i,
  done_at: t.done ? `${t.doneAt ?? today}T12:00:00+09:00` : null,
  // 오늘 이후로 시간을 정해 둔 것만 일정으로 잇는다. 지난 것은 버린다
  slot: t.slot && t.slot.date >= today ? t.slot : null,
}));

const shifts = work?.shifts ?? [];
const holidays = new Set(study.holidays.map((h) => h.date));
const skips = plan.classOverrides ?? {};
const classes: { external_id: string; title: string; date: string; start_min: number; end_min: number; where_text: string | null }[] = [];
for (const c of study.courses) {
  for (const m of c.meetings) {
    const isoDay = m.day === 0 ? 7 : m.day;
    for (const d of dateRange(study.startDate, study.endDate)) {
      if (weekday(d) !== isoDay || holidays.has(d) || skips[`${c.id}:${m.id}`]?.[d]?.skip) continue;
      classes.push({ external_id: `${c.id}:${m.id}:${d}`, title: c.name.trim(), date: d, start_min: m.start, end_min: m.end, where_text: blank(m.room) ?? blank(c.room) });
    }
  }
}

console.log(
  [
    `지점 ${places.length} (${places.map((p) => `${p.name}${p.role ? `=${p.role}` : ""}`).join(", ")})`,
    `이동시간 ${travel.length}쌍`,
    `설정 외출 준비 ${settings.prep_first}/${settings.prep_again}분, 식사 ${settings.meal_min}분`,
    `내 일정 ${events.length} (반복 ${events.filter((e) => e.repeat).length}, 예외 ${events.reduce((n, e) => n + e.exceptions.length, 0)})`,
    `할 일 ${tasks.length} (끝냄 ${tasks.filter((t) => t.done_at).length}, 시간 이어 둘 것 ${tasks.filter((t) => t.slot).length})`,
    `스큐 근무 ${shifts.length} → studycube`,
    `대학 수업 ${classes.length}회차 (${study.courses.length}과목, ${study.startDate} ~ ${study.endDate}, 휴일 ${holidays.size}일 뺌) → univ`,
  ].join("\n"),
);
if (!APPLY) {
  console.log("\n요약만 했습니다. 넣으려면 --apply");
  process.exit(0);
}

// ---------- 넣기 ----------
const made: { table: string; ids: string[] }[] = [];
/** 맞춘 바깥 일정 (실패하면 빈 목록으로 다시 맞춰 지운다 — 바깥 일정은 sync 로만 바뀐다) */
const synced: { source: string; from: string; to: string }[] = [];
const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
};

async function run() {
  const existing = must(await db.from("ez_places").select("id").eq("owner", owner).is("deleted_at", null), "지점 확인");
  if (existing.length > 0) throw new Error("이미 지점이 있습니다. 옮긴 적이 있는 것 같아 멈춥니다");

  const placeRows = must(
    await db
      .from("ez_places")
      .insert([...places].sort((x, y) => (x.role ? ROLE_ORDER[x.role] : 9) - (y.role ? ROLE_ORDER[y.role] : 9)).map((p) => ({ owner, name: p.name, role: p.role, sort: p.sort })))
      .select("id, name"),
    "지점",
  );
  made.push({ table: "ez_places", ids: placeRows.map((r: { id: string }) => r.id) });
  const pid = new Map<string, string>();
  for (const p of places) pid.set(p.old, placeRows.find((r: { name: string }) => r.name === p.name)!.id);

  must(
    await db.from("ez_travel").insert(
      travel.map((t) => {
        const a = pid.get(t.a)!;
        const b = pid.get(t.b)!;
        return { owner, a: a < b ? a : b, b: a < b ? b : a, minutes: t.minutes };
      }),
    ),
    "이동시간",
  );

  must(await db.from("ez_schedule_settings").upsert({ owner, ...settings }), "설정");

  const taskRows = must(
    await db.from("ez_tasks").insert(tasks.map(({ slot: _slot, ...t }) => ({ owner, ...t }))).select("id, sort"),
    "할 일",
  );
  made.push({ table: "ez_tasks", ids: taskRows.map((r: { id: string }) => r.id) });

  for (const e of events) {
    const row = must(
      await db
        .from("ez_events")
        .insert({
          owner,
          title: e.title,
          date: e.date,
          start_min: e.start_min,
          end_min: e.end_min,
          place_id: e.placeOld ? (pid.get(e.placeOld) ?? null) : null,
          where_text: e.where_text,
          travel_min: e.travel_min,
          note: e.note,
          repeat: e.repeat,
        })
        .select("id")
        .single(),
      `일정 '${e.title}' (${e.date})`,
    ) as { id: string };
    made.push({ table: "ez_events", ids: [row.id] });
    for (const x of e.exceptions) {
      must(await db.from("ez_event_exceptions").insert({ event_id: row.id, on_date: x.on_date, skip: x.skip, patch: x.patch }), `일정 '${e.title}' 예외 ${x.on_date}`);
    }
  }

  for (const [i, t] of tasks.entries()) {
    if (!t.slot) continue;
    const taskId = taskRows.find((r: { sort: number }) => r.sort === i)!.id;
    const row = must(
      await db.from("ez_events").insert({ owner, title: t.title, date: t.slot.date, start_min: t.slot.start, end_min: t.slot.start + t.est_min, task_id: taskId }).select("id").single(),
      `할 일 '${t.title}' 시간`,
    ) as { id: string };
    made.push({ table: "ez_events", ids: [row.id] });
  }

  const work = pid.get(st.workPlaceId) ?? null;
  const school = pid.get(st.schoolPlaceId) ?? null;
  if (shifts.length > 0) {
    const dates = shifts.map((s) => s.date).sort();
    const r = must(
      await db.rpc("ez_schedule_sync", {
        source: "studycube",
        p_from: dates[0],
        p_to: dates[dates.length - 1],
        events: shifts.map((s) => ({ external_id: s.id, title: s.title.trim(), date: s.date, start_min: s.start, end_min: s.end, place_id: work, where_text: blank(s.place) })),
        p_label: "스터디큐브",
        p_as: owner,
      }),
      "스큐 근무 sync",
    );
    synced.push({ source: "studycube", from: dates[0]!, to: dates[dates.length - 1]! });
    console.log("스큐 근무:", JSON.stringify(r));
  }
  if (classes.length > 0) {
    const r = must(
      await db.rpc("ez_schedule_sync", {
        source: "univ",
        p_from: study.startDate,
        p_to: addDays(study.endDate, 0),
        events: classes.map((c) => ({ ...c, place_id: school })),
        p_label: "대학",
        p_as: owner,
      }),
      "대학 수업 sync",
    );
    synced.push({ source: "univ", from: study.startDate, to: study.endDate });
    console.log("대학 수업:", JSON.stringify(r));
  }
}

try {
  await run();
  console.log("\n옮기기 끝");
} catch (e) {
  console.error(`\n실패: ${(e as Error).message}\n이번에 만든 것을 지웁니다`);
  for (const x of synced) await db.rpc("ez_schedule_sync", { source: x.source, p_from: x.from, p_to: x.to, events: [], p_as: owner });
  for (const m of [...made].reverse()) {
    if (m.table === "ez_events") await db.from("ez_events").delete().in("id", m.ids);
  }
  for (const m of made.filter((x) => x.table === "ez_tasks")) await db.from("ez_tasks").delete().in("id", m.ids);
  for (const m of made.filter((x) => x.table === "ez_places")) {
    await db.from("ez_travel").delete().eq("owner", owner);
    await db.from("ez_places").delete().in("id", m.ids);
  }
  await db.from("ez_schedule_settings").delete().eq("owner", owner);
  process.exit(1);
}
