"use client";

// 모임 한 건 (docs/모임.md 5장). 왼쪽: 제목 · 묶음 · 언제 · 어디서 + (맞추는 중이면) 격자 + 메모. 오른쪽: 사람들 · 추천 시간 · 할 일. 폰은 한 열.
// 누르면 보기만 — 고치기는 '수정' 을 한 번 더(같은 자리에서 수정 칸으로 바뀐다). 참석(온다 / 못 온다)과 할 일의 끝냄 체크만 바로 된다.
// 사람 넣고 빼기 · 핀 지우기는 수정 중에만. 내 칸 칠하기는 격자의 '수정' 을 누른 뒤에만(격자 카드에 따로 있다 — 수정 칸에 밀려 내려가지 않게). 시간을 적으면 일정에 들어가고, 일정 화면에서 그 약속을 지웠으면 '일정에 넣기' 가 보인다.
// 할 일은 플래너의 할 일과 같은 데이터다(모임에서 온 것). 다음 모임은 같은 묶음 · 사람 · 지점 · 제목으로 새로 연다.
//
// 시간 맞추기 (3 · 4장): 내 되는 칸은 일정에서 자동으로 채워진다 — 내 줄이 auto 인 동안 화면을 열 때마다 다시 계산해 저장한다.
// 격자의 '수정' 뒤에 칠하면 그 모임용으로 고친 것(auto 꺼짐), '일정에 맞추기' 로 되돌린다.
// 추천 시간 줄이나 격자의 칸을 누르면 그 시간이 격자에 보이고(보기), '이 시간으로' 를 한 번 더 눌러 정한다. 정한 뒤 '다시 열기'.
// 공개 링크는 켜야 생긴다(켜기 · 복사 · 끄기). 사람 이름을 누르면 그 사람 것만 격자에 보인다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  circleOf,
  meetStatus,
  myFreeCells,
  PEOPLE_MAX,
  pollRange,
  pollSlots,
  sameCells,
  suggestTimes,
  validateMeet,
  type Attend,
  type CellAt,
  type Cells,
  type Meet,
  type MeetPerson,
} from "../../../lib/meet";
import { DEFAULT_SETTINGS, TASK_TITLE_MAX, validateTask, type TaskRow } from "../../../lib/schedule";
import {
  addNames,
  attendLabels,
  cellHeight,
  draftInput,
  draftPatch,
  meetDraftOf,
  meetTaskInput,
  meetTasks,
  nextMeet,
  parseNames,
  pollLabel,
  publicPath,
  slotLabel,
  whenText,
  windowAt,
  type MeetDraft,
} from "../../_logic/meet";
import { personMenu } from "../../_logic/menus";
import { nowIn } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { PlaceDot } from "../schedule/PlaceSymbol";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { toEntries, useContextMenu } from "../useContextMenu";
import { MeetForm } from "./MeetForm";
import { MeetGrid, type GridPick } from "./MeetGrid";
import { refreshMeets, useMeetData, type MeetState } from "./useMeetData";

const CLOCK_MS = 60_000;
const PHONE_MAX = 760;
const tempId = () => `tmp-${globalThis.crypto.randomUUID()}`;
const isTemp = (id: string) => id.startsWith("tmp-");
const enter = (e: ReactKeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);

const mapMeet = (s: MeetState, id: string, f: (m: Meet) => Meet): MeetState => ({ ...s, meets: s.meets.map((m) => (m.id === id ? f(m) : m)) });
const mapTask = (s: MeetState, id: string, f: (t: TaskRow) => TaskRow): MeetState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? f(t) : t)) });
const mapPerson = (s: MeetState, meetId: string, personId: string, patch: Partial<MeetPerson>): MeetState =>
  mapMeet(s, meetId, (x) => ({ ...x, people: x.people.map((y) => (y.id === personId ? { ...y, ...patch } : y)) }));
const samePick = (a: GridPick | null, b: GridPick) => a !== null && a.date === b.date && a.start === b.start && a.end === b.end;

type Edit = { base: number; draft: MeetDraft };

/** 공개 링크를 복사한다 (모임 화면 · 모임 목록의 메뉴). 못 하면 주소를 알림으로 */
export async function copyMeetLink(token: string, demo: boolean, toast: (text: string) => void): Promise<void> {
  const url = `${location.origin}${publicPath(token, demo)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("링크를 복사했습니다");
  } catch {
    toast(url);
  }
}

/** 화면 크기 (격자의 칸 높이를 정한다). 처음에는 모른다 */
function useViewport(): { w: number; h: number } | null {
  const [v, setV] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const f = () => setV({ w: document.documentElement.clientWidth, h: window.innerHeight });
    f();
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return v;
}

export function MeetView({ id }: { id: string }) {
  const { src, href, fail, tick } = useApp();
  const toast = useToast();
  const router = useRouter();
  const view = useViewport();

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  const now = nowIn(DEFAULT_SETTINGS.tz, new Date(clock));

  const D = useMeetData({ tasks: true });
  const state = D.state;
  const meet = state?.meets.find((m) => m.id === id) ?? null;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [person, setPerson] = useState("");
  const [task, setTask] = useState("");
  /** 격자에서 이 사람 것만 본다 (이름) */
  const [focus, setFocus] = useState<string | null>(null);
  /** 보고 있는 시간 — '이 시간으로' 를 누르기 전 */
  const [pick, setPick] = useState<GridPick | null>(null);
  /** 격자의 '수정' — 내 칸을 칠하는 중 */
  const [painting, setPainting] = useState(false);
  /** 지우는 중 — 목록으로 넘어가는 사이 '없는 모임' 을 그리지 않는다 */
  const [leaving, setLeaving] = useState(false);
  const cm = useContextMenu();

  // 목록의 우클릭 메뉴 '수정' 으로 왔으면(?edit=1) 수정 칸을 연다 — 처음 한 번
  const editFromUrl = useRef(false);
  useEffect(() => {
    if (!state || !meet || editFromUrl.current) return;
    editFromUrl.current = true;
    if (new URLSearchParams(location.search).get("edit") !== "1") return;
    const at = nowIn(DEFAULT_SETTINGS.tz);
    setEdit({ base: meet.version, draft: meetDraftOf(meet, state.circles, at.date, at.min) });
  }, [state, meet]);

  const tasks = useMemo(() => meetTasks(state?.tasks ?? [], id), [state, id]);
  const mine = meet?.people.find((p) => p.is_owner) ?? null;
  const polling = meet !== null && meet.poll !== null && meet.meet_date === null;
  const suggestions = useMemo(
    () => (meet && meet.poll && meet.meet_date === null ? suggestTimes(meet.people, meet.poll, { date: now.date, min: now.min }) : []),
    [meet, now.date, now.min],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.key !== "Escape") return;
      if (edit) setEdit(null);
      else if (painting) setPainting(false);
      else if (pick) setPick(null);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [edit, pick, painting]);

  // ------------------------------------------------------------ 내 되는 칸: 일정에서 자동으로

  const latest = useRef({ state, meet, mine });
  latest.current = { state, meet, mine };
  const DRef = useRef(D);
  DRef.current = D;

  /** 일정(준비 · 이동 포함)을 뺀 통째로 비는 칸을 계산해, 지금 것과 다르면(또는 force) 저장한다. 내 줄은 auto 가 된다 */
  async function fill(force: boolean): Promise<void> {
    const at = latest.current;
    const poll = at.meet?.poll;
    if (!at.state || !at.meet || !poll || !at.mine || isTemp(at.mine.id)) return;
    const meetId = at.meet.id;
    const r = pollRange(poll);
    try {
      const [ev, travel] = await Promise.all([DRef.current.S.events(r.from, r.to), DRef.current.S.travel()]);
      const cur = latest.current;
      if (!cur.state || !cur.mine || cur.meet?.id !== meetId || (!force && !cur.mine.auto)) return;
      const cells = myFreeCells(poll, ev.events, ev.exceptions, cur.state.places, travel, cur.state.settings);
      if (cur.mine.auto && sameCells(cur.mine.cells, cells)) return;
      const pid = cur.mine.id;
      void DRef.current.run(
        (s) => mapPerson(s, meetId, pid, { cells, auto: true }),
        () => DRef.current.M.updatePerson(pid, { cells, auto: true }),
      );
    } catch (e) {
      DRef.current.onError(e);
    }
  }

  // 내 줄이 auto 인 동안: 화면을 열 때 · 창에 돌아올 때(tick) · 설정이 바뀔 때 다시 계산한다
  const autoKey = polling && mine?.auto && !isTemp(mine.id) ? `${id}|${JSON.stringify(meet?.poll)}|${tick}` : null;
  useEffect(() => {
    if (autoKey !== null) void fill(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  // 맞추는 중이 아니게 되면 보고 있던 것을 비운다
  useEffect(() => {
    if (!polling) {
      setPick(null);
      setFocus(null);
      setPainting(false);
    }
  }, [polling]);

  const top = (
    <div className="bar-top pl-top">
      <HomeButton />
      <Link className="iconbtn" href={href("/meet")} aria-label="모임 목록" title="모임 목록">
        <Icon name="left" />
      </Link>
      <ThemeToggle />
    </div>
  );

  if (!state || leaving) return <div className="planner meet">{top}</div>;
  if (!meet) {
    return (
      <div className="planner meet">
        {top}
        <p className="empty">없는 모임입니다</p>
      </div>
    );
  }

  const m = meet;
  const circles = state.circles;
  const status = meetStatus(m, { date: now.date, min: now.min });
  const decided = m.meet_date !== null;
  const circle = circleOf(m, circles);
  const place = m.place_id ? (state.places.find((p) => p.id === m.place_id) ?? null) : null;
  const when = whenText(m);
  const labels = attendLabels(status);
  const phone = (view?.w ?? 1440) <= PHONE_MAX;

  // ------------------------------------------------------------ 고치기

  function startEdit() {
    setEdit({ base: m.version, draft: meetDraftOf(m, circles, now.date, now.min) });
    setPerson("");
    setPick(null);
    setFocus(null);
    setPainting(false);
  }

  function startPaint() {
    setPainting(true);
    setPick(null);
    setFocus(null);
  }

  async function saveEdit() {
    if (!edit) return;
    const input = draftInput(edit.draft);
    const issue = validateMeet(input)[0];
    if (issue) {
      toast(issue.path === "title" && input.title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    const patch = draftPatch(edit.draft, m, circles);
    const current = edit;
    setEdit(null);
    if (Object.keys(patch).length === 0) return;
    const ok = await D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, ...patch })),
      () => D.M.updateMeet(m.id, current.base, patch),
    );
    if (!ok) setEdit(current);
  }

  /** 일정 화면에서 그 약속을 지운 모임: 같은 시간으로 다시 넣는다 */
  function toSchedule() {
    if (m.meet_date === null || m.start_min === null || m.end_min === null) return;
    const { meet_date, start_min, end_min } = m;
    void D.run(null, (srv) => D.M.decide(m.id, D.versionOf(srv, m.id, m.version), meet_date, start_min, end_min));
  }

  // ------------------------------------------------------------ 시간 맞추기: 칠하기 · 정하기 · 다시 열기 · 링크

  /** 격자를 칠했다 — 그 모임용으로 고친 것이라 auto 가 꺼진다 */
  function paint(cells: Cells) {
    if (!mine || isTemp(mine.id)) return;
    const pid = mine.id;
    void D.run(
      (s) => mapPerson(s, m.id, pid, { cells, auto: false }),
      () => D.M.updatePerson(pid, { cells, auto: false }),
    );
  }

  function pickCell(at: CellAt) {
    if (!m.poll) return;
    const w = windowAt(m.poll, at);
    setPick(samePick(pick, w) ? null : w);
  }

  /** 보고 있는 시간으로 정한다 — 일정이 생기고 맞추기는 닫힌다 */
  function decide(p: GridPick) {
    setPick(null);
    setFocus(null);
    void D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, meet_date: p.date, start_min: p.start, end_min: p.end })),
      (srv) => D.M.decide(m.id, D.versionOf(srv, m.id, m.version), p.date, p.start, p.end),
    );
  }

  /** 정한 시간을 비운다(딸린 일정도 지워진다). 칠한 것은 남아 있다 */
  function reopen() {
    void D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, meet_date: null, start_min: null, end_min: null, event_id: null })),
      (srv) => D.M.reopen(m.id, D.versionOf(srv, m.id, m.version)),
    );
  }

  const copyLink = (token: string) => copyMeetLink(token, src.demo, toast);

  async function linkOn() {
    const token = await D.run(null, () => D.M.link(m.id, true));
    if (token) await copyLink(token);
  }

  function linkOff() {
    void D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, token: null })),
      async () => {
        await D.M.link(m.id, false);
        return true;
      },
    );
  }

  // ------------------------------------------------------------ 사람

  /** 참석은 바로. 누른 것을 다시 누르면 비운다 */
  function attend(p: MeetPerson, value: Attend) {
    if (isTemp(p.id)) return;
    const next = p.attend === value ? null : value;
    void D.run(
      (s) => mapPerson(s, m.id, p.id, { attend: next }),
      () => D.M.updatePerson(p.id, { attend: next }),
    );
  }

  function addPeople() {
    const have = m.people.map((p) => p.name);
    const r = addNames(have, parseNames(person));
    if (r.issue) {
      toast(r.issue);
      return;
    }
    const fresh = r.names.slice(have.length);
    setPerson("");
    if (fresh.length === 0) return;
    if (r.names.length > PEOPLE_MAX) {
      toast(`한 모임에 ${PEOPLE_MAX}명까지입니다`);
      return;
    }
    const at = new Date().toISOString();
    const temps: MeetPerson[] = fresh.map((name) => ({ id: tempId(), meet_id: m.id, name, is_owner: false, cells: null, auto: false, attend: null, has_pin: false, created_at: at }));
    void D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, people: [...x.people, ...temps] })),
      async () => {
        for (const name of fresh) await D.M.addPerson(m.id, { name });
        return true;
      },
    );
  }

  /** 빼면 그 줄(칠한 것 · 참석)이 지워진다. 되돌리면 같은 값으로 다시 넣는다 (핀은 못 되살린다) */
  async function removePerson(p: MeetPerson) {
    if (p.is_owner || isTemp(p.id)) return;
    const ok = await D.run(
      (s) => mapMeet(s, m.id, (x) => ({ ...x, people: x.people.filter((y) => y.id !== p.id) })),
      async () => {
        await D.M.removePerson(p.id);
        return true;
      },
    );
    if (ok) {
      toast(`${p.name} 님을 뺐습니다`, {
        label: "되돌리기",
        run: () => void D.run(null, () => D.M.addPerson(m.id, { id: p.id, name: p.name, attend: p.attend, cells: p.cells })),
      });
    }
  }

  /** 핀을 잊은 사람: 지우면 그 이름으로 다시 들어오며 새 핀을 정한다. 칠한 것은 그대로 */
  async function clearPin(p: MeetPerson) {
    if (isTemp(p.id)) return;
    const ok = await D.run(
      (s) => mapPerson(s, m.id, p.id, { has_pin: false }),
      async () => {
        await D.M.clearPin(p.id);
        return true;
      },
    );
    if (ok) toast(`${p.name} 님의 핀번호를 지웠습니다`);
  }

  // ------------------------------------------------------------ 할 일 (플래너와 같은 데이터)

  function addTask() {
    const title = task.trim();
    if (title === "") return;
    const issue = validateTask({ title })[0];
    if (issue) {
      toast(issue.reason);
      return;
    }
    setTask("");
    const input = meetTaskInput(title, m, circles, state!.roles);
    const at = new Date().toISOString();
    const temp: TaskRow = {
      id: tempId(),
      title,
      note: null,
      due: null,
      est_min: null,
      sort: 0,
      done_at: null,
      origin_kind: "meet",
      origin_id: m.id,
      place_id: input.place_id ?? null,
      due_event_id: null,
      checklist: [],
      rule_id: null,
      rule_date: null,
      role_id: input.role_id ?? null,
      bench_order: null,
      bench_at: null,
      version: 1,
      created_at: at,
      updated_at: at,
    };
    void D.run((s) => ({ ...s, tasks: [...s.tasks, temp] }), () => D.T.createTask(input));
  }

  function toggleTask(t: TaskRow) {
    if (isTemp(t.id)) return;
    const done = t.done_at === null;
    const at = new Date().toISOString();
    void D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, done_at: done ? at : null })),
      (srv) => D.T.setDone(t.id, D.taskVersion(srv, t.id, t.version), done),
    );
  }

  // ------------------------------------------------------------ 다음 모임 · 지우기

  async function makeNext() {
    const n = nextMeet(m, circles);
    const made = await D.run(null, () => D.M.createMeet(n.input, n.people));
    if (!made) return;
    setEdit(null);
    router.push(href(`/meet/${made.id}`));
  }

  /** 지우면 목록으로. 딸린 일정 · 할 일은 남는다. 알림에서 되돌린다 */
  async function remove() {
    setLeaving(true);
    router.push(href("/meet"));
    const ok = await D.run(
      (s) => ({ ...s, meets: s.meets.filter((x) => x.id !== m.id) }),
      async (srv) => {
        await D.M.deleteMeet(m.id, D.versionOf(srv, m.id, m.version));
        return true;
      },
    );
    refreshMeets();
    if (ok) {
      toast("모임을 지웠습니다", {
        label: "되돌리기",
        run: () => void src.meet.restoreMeet(m.id).then(refreshMeets, fail),
      });
    }
  }

  // ------------------------------------------------------------ 그리기

  const head = edit ? (
    <MeetForm
      draft={edit.draft}
      onChange={(d) => setEdit((x) => (x ? { ...x, draft: d } : x))}
      circles={circles}
      places={state.places}
      isNew={false}
      askName={false}
      today={now.date}
      onSave={() => void saveEdit()}
      onCancel={() => setEdit(null)}
    />
  ) : (
    <>
      <div className="dp-h">
        <h2>{m.title}</h2>
      </div>
      {circle && (
        <div className="dp-f">
          <Icon name="meet" />
          <div>{circle.name}</div>
        </div>
      )}
      {(when || m.poll) && (
        <div className="dp-f">
          <Icon name="clock" />
          <div>
            {when ? (
              m.event_id && m.meet_date ? (
                <Link className="go-ev num" href={href(`/schedule?date=${m.meet_date}&event=${m.event_id}`)}>
                  {when}
                </Link>
              ) : (
                <span className="num">{when}</span>
              )
            ) : (
              m.poll && <span className="num">{pollLabel(m.poll)}</span>
            )}
          </div>
        </div>
      )}
      {(place || m.place_text) && (
        <div className={place ? `dp-f pc-${place.color}` : "dp-f"}>
          {place ? <PlaceDot className="at" /> : <Icon name="pin" />}
          <div>
            {place && <span>{place.name}</span>}
            {m.place_text && <span className={place ? "dim" : undefined}>{m.place_text}</span>}
          </div>
        </div>
      )}
      <div className="dp-acts">
        {decided && m.event_id === null && (
          <button type="button" className="btn" onClick={toSchedule}>
            일정에 넣기
          </button>
        )}
        <button type="button" className="ghost" onClick={startEdit}>
          수정
        </button>
        {decided && m.poll && (
          <button type="button" className="ghost" onClick={reopen}>
            다시 열기
          </button>
        )}
        {m.token === null ? (
          <button type="button" className="ghost" onClick={() => void linkOn()}>
            <Icon name="link" />
            링크 켜기
          </button>
        ) : (
          <>
            <button type="button" className="ghost" onClick={() => void copyLink(m.token!)}>
              <Icon name="copy" />
              링크 복사
            </button>
            <button type="button" className="ghost" onClick={linkOff}>
              링크 끄기
            </button>
          </>
        )}
        <button type="button" className="ghost" onClick={() => void makeNext()}>
          다음 모임
        </button>
        <button type="button" className="del" onClick={() => void remove()}>
          지우기
        </button>
      </div>
    </>
  );

  const pickShown = pick !== null && !suggestions.some((s) => samePick(pick, s));

  return (
    <div className="planner meet">
      {top}
      <div className="pl-list mt-page">
        <div className="pl-cols two mt-cols">
          <div className="pl-col">
            <section className="pl-sec mt-card" aria-label="모임">
              {head}
            </section>
            {polling && m.poll && view && (
              <section className="pl-sec mt-gridsec" aria-label="되는 시간">
                {!edit && (
                  <div className="mt-gridtop">
                    {painting && mine && !mine.auto && (
                      <button type="button" className="ghost" onClick={() => void fill(true)}>
                        일정에 맞추기
                      </button>
                    )}
                    {painting ? (
                      <button type="button" className="btn" onClick={() => setPainting(false)}>
                        완료
                      </button>
                    ) : (
                      <button type="button" className="ghost" onClick={startPaint}>
                        수정
                      </button>
                    )}
                  </div>
                )}
                <MeetGrid
                  poll={m.poll}
                  people={m.people}
                  me={mine?.name ?? null}
                  variant="host"
                  editable={painting && !edit}
                  focus={focus}
                  pick={pick}
                  cellH={cellHeight(pollSlots(m.poll).length, view.h, phone)}
                  label="되는 시간"
                  onPick={pickCell}
                  onPaint={paint}
                />
              </section>
            )}
            {!edit && m.note && (
              <section className="pl-sec" aria-label="메모">
                <h2 className="pl-h">메모</h2>
                <p className="mt-note">{m.note}</p>
              </section>
            )}
          </div>
          <div className="pl-col">
            <section className="pl-sec" aria-label="사람들">
              <h2 className="pl-h">
                사람들<span className="num">{m.people.length}</span>
              </h2>
              <ul className="mt-people">
                {m.people.map((p) => (
                  <li
                    key={p.id}
                    {...cm.bind(`person:${p.id}`, () =>
                      toEntries(
                        personMenu({ temp: isTemp(p.id), decided, attend: p.attend, owner: p.is_owner, hasPin: p.has_pin, labels }),
                        (act) => {
                          if (act === "yes" || act === "no") attend(p, act);
                          else if (act === "clear") {
                            if (p.attend) attend(p, p.attend);
                          } else if (act === "pin") void clearPin(p);
                          else void removePerson(p);
                        },
                      ),
                    )}
                  >
                    {polling && !edit && !painting ? (
                      <button type="button" className="nm" aria-pressed={focus === p.name} onClick={() => setFocus(focus === p.name ? null : p.name)}>
                        {p.name}
                      </button>
                    ) : (
                      <span className="nm">{p.name}</span>
                    )}
                    {decided && !edit && (
                      <span className="att" role="group" aria-label={`${p.name} 참석`}>
                        <button type="button" aria-pressed={p.attend === "yes"} onClick={() => attend(p, "yes")}>
                          {labels.yes}
                        </button>
                        <button type="button" className="no" aria-pressed={p.attend === "no"} onClick={() => attend(p, "no")}>
                          {labels.no}
                        </button>
                      </span>
                    )}
                    {edit && p.has_pin && (
                      <button type="button" className="ghost pinx" onClick={() => void clearPin(p)}>
                        핀 지우기
                      </button>
                    )}
                    {edit && !p.is_owner && (
                      <button type="button" className="iconbtn" aria-label={`${p.name} 빼기`} title="빼기" onClick={() => void removePerson(p)}>
                        <Icon name="x" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {edit && m.people.length < PEOPLE_MAX && (
                <label className="role-add">
                  <Icon name="plus" />
                  <input
                    value={person}
                    aria-label="사람 더하기"
                    enterKeyHint="done"
                    onChange={(e) => setPerson(e.target.value)}
                    onKeyDown={(e) => {
                      if (!enter(e)) return;
                      e.preventDefault();
                      addPeople();
                    }}
                  />
                </label>
              )}
            </section>
            {polling && !edit && !painting && (suggestions.length > 0 || pickShown) && (
              <section className="pl-sec" aria-label="추천 시간">
                <h2 className="pl-h">추천 시간</h2>
                <ul className="mt-sugs">
                  {[...(pickShown && pick ? [{ ...pick, count: null }] : []), ...suggestions.map((s) => ({ date: s.date, start: s.start, end: s.end, count: s.count }))].map((s) => {
                    const on = samePick(pick, s);
                    return (
                      <li key={`${s.date}|${s.start}`} className={on ? "on" : undefined}>
                        <button type="button" className="sg" aria-pressed={on} onClick={() => setPick(on ? null : { date: s.date, start: s.start, end: s.end })}>
                          <span className="num">{slotLabel(s)}</span>
                          {s.count !== null && (
                            <span className="cnt num" title="되는 사람 수">
                              {s.count}
                            </span>
                          )}
                        </button>
                        {on && (
                          <button type="button" className="btn" onClick={() => decide(s)}>
                            이 시간으로
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <section className="pl-sec" aria-label="할 일">
              <h2 className="pl-h">
                할 일{tasks.length > 0 && <span className="num">{tasks.filter((t) => t.done_at === null).length}</span>}
              </h2>
              {tasks.length > 0 && (
                <ul className="pl-rows">
                  {tasks.map((t) => {
                    const done = t.done_at !== null;
                    return (
                      <li key={t.id} className={done ? "pl-row mt-task done" : "pl-row mt-task"}>
                        <button
                          type="button"
                          className="chk"
                          role="checkbox"
                          aria-checked={done}
                          aria-label={done ? `${t.title} 끝냄 풀기` : `${t.title} 끝냄`}
                          title={done ? "끝냄 풀기" : "끝냄"}
                          onClick={() => toggleTask(t)}
                        >
                          <Icon name={done ? "ring-check" : "ring"} />
                        </button>
                        <span className="nm">{t.title}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <label className="role-add">
                <Icon name="plus" />
                <input
                  value={task}
                  maxLength={TASK_TITLE_MAX}
                  aria-label="할 일 추가"
                  enterKeyHint="done"
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (!enter(e)) return;
                    e.preventDefault();
                    addTask();
                  }}
                />
              </label>
            </section>
          </div>
        </div>
      </div>
      {cm.node}
    </div>
  );
}
