"use client";

// 모임 목록 (docs/모임.md 5장). 맨 위 새 모임 → 정렬 줄(날짜 · 묶음 · 역할 + 방향, 묶음 시트) → 카드 셋(정할 것 · 다가오는 모임 · 지난 모임 접힘).
// 줄을 누르면 그 모임 화면으로 간다(보기). 거르지 않고 정렬만 한다 — 묶음 · 역할로 정렬하면 경계에 이름 + 선(플래너와 같은 방식).
// 새 모임 칸과 묶음 시트는 플래너의 보기 · 수정과 같은 그릇: 넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 시트.
// 전환(docs/모션.md): 줄이 생기고 · 빠지고 · 자리를 바꾸면 FLIP 으로 미끄러진다(useFlip). 데이터는 먼저 바뀐다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CIRCLE_NAME_MAX,
  circleOf,
  DEFAULT_MY_NAME,
  MEET_SORT_KEYS,
  parseMeetSort,
  PERSON_NAME_MAX,
  sortMeets,
  splitMeets,
  validateMeet,
  type Circle,
  type Meet,
  type MeetCard,
  type MeetGroup,
  type MeetSort,
  type MeetSortKey,
} from "../../../lib/meet";
import { DEFAULT_SETTINGS } from "../../../lib/schedule";
import { meetMenu } from "../../_logic/menus";
import { addNames, draftInput, draftPeople, lineWhen, newMeetDraft, nextMeet, parseNames, type MeetDraft } from "../../_logic/meet";
import { nowIn } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { Presence } from "../motion/Presence";
import { useFlip } from "../motion/useFlip";
import { PlaceDot } from "../schedule/PlaceSymbol";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { toEntries, useContextMenu } from "../useContextMenu";
import { CircleEdit } from "./CircleEdit";
import { MeetForm } from "./MeetForm";
import { copyMeetLink } from "./MeetView";
import { refreshMeets, useMeetData, type MeetState } from "./useMeetData";

const PHONE_MAX = 760;
const PANEL_MIN = 1180;
const CLOCK_MS = 60_000;
/** 고른 정렬과 방향을 이 기기에 기억한다 ({key, dir}) */
const SORT_KEY = "ezwork.meet.sort";
const SORT_LABEL: Record<MeetSortKey, string> = { date: "날짜", circle: "묶음", role: "역할" };

function readSort(): MeetSort {
  try {
    return parseMeetSort(localStorage.getItem(SORT_KEY));
  } catch {
    return parseMeetSort(null);
  }
}

function useViewportWidth(): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const f = () => setW(document.documentElement.clientWidth);
    f();
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

const mapCircle = (id: string, patch: Partial<Circle>) => (s: MeetState): MeetState => ({ ...s, circles: s.circles.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

export function MeetListView() {
  const { href, src, fail } = useApp();
  const cm = useContextMenu();
  const toast = useToast();
  const router = useRouter();
  const width = useViewportWidth();
  const phone = (width ?? 1440) <= PHONE_MAX;
  const wide = (width ?? 1440) >= PANEL_MIN;

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_MS);
    const vis = () => document.visibilityState === "visible" && setClock(Date.now());
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  const now = nowIn(DEFAULT_SETTINGS.tz, new Date(clock));

  const D = useMeetData();
  const state = D.state;
  const [draft, setDraft] = useState<MeetDraft | null>(null);
  const [circleEdit, setCircleEdit] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [sort, setSort] = useState<MeetSort>(readSort);

  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, ".pl-row[data-id], .pl-g[data-flip]");

  const lists = useMemo(() => splitMeets(state?.meets ?? [], { date: now.date, min: now.min }), [state, now.date, now.min]);
  const placeOf = useMemo(() => new Map((state?.places ?? []).map((p) => [p.id, p])), [state]);

  const closePanel = useCallback(() => {
    setDraft(null);
    setCircleEdit(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.key !== "Escape") return;
      if (!draft && !circleEdit) return;
      closePanel();
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [draft, circleEdit, closePanel]);

  // ------------------------------------------------------------ 새 모임

  function openNew() {
    if (draft) {
      setDraft(null);
      return;
    }
    setCircleEdit(false);
    setDraft(newMeetDraft(now.date, now.min));
  }

  async function saveNew() {
    if (!draft || !state) return;
    const input = draftInput(draft);
    const issue = validateMeet(input)[0];
    if (issue) {
      toast(issue.path === "title" && input.title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    if (input.poll && input.poll.dates[0]! < now.date) {
      toast("지난 날짜는 후보로 둘 수 없습니다");
      return;
    }
    // 내 이름: 설정에 없으면 처음 한 번 묻고 기억한다 (docs/모임.md 7장)
    const known = state.settings.my_name;
    const typed = draft.myName.trim();
    if (known === null && (typed === "" || [...typed].length > PERSON_NAME_MAX)) {
      toast(typed === "" ? "내 이름을 써 주세요" : `내 이름은 ${PERSON_NAME_MAX}자까지입니다`);
      return;
    }
    const myName = known ?? typed;
    const people = draftPeople(draft, myName);
    if (people.issue) {
      toast(people.issue);
      return;
    }
    const current = draft;
    setDraft(null);
    const at = new Date().toISOString();
    const temp: Meet = {
      id: `tmp-${globalThis.crypto.randomUUID()}`,
      ...input,
      event_id: null,
      token: null,
      version: 1,
      created_at: at,
      updated_at: at,
      people: [myName || DEFAULT_MY_NAME, ...people.names].map((name, i) => ({ id: `tmp-${i}`, meet_id: "", name, is_owner: i === 0, cells: null, auto: i === 0 && input.poll !== null, attend: null, has_pin: false, created_at: at })),
    };
    const made = await D.run(
      (s) => ({ ...s, meets: [...s.meets, temp], settings: { ...s.settings, my_name: myName } }),
      async () => {
        if (known === null) await D.S.saveSettings({ my_name: myName });
        return D.M.createMeet(input, people.names);
      },
    );
    if (!made) setDraft(current);
  }

  // ------------------------------------------------------------ 정렬 · 묶음 시트

  function pickSort(next: MeetSort) {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      // 기억만 못 한다
    }
  }

  function openCircles() {
    if (circleEdit) {
      setCircleEdit(false);
      return;
    }
    setDraft(null);
    setCircleEdit(true);
  }

  /** 잘못된 이름이면 알리고 false */
  function renameCircle(c: Circle, value: string): boolean {
    const name = value.trim();
    if (name === c.name) return true;
    if (name === "" || [...name].length > CIRCLE_NAME_MAX) {
      toast(`묶음 이름은 1~${CIRCLE_NAME_MAX}자입니다`);
      return false;
    }
    void D.run(mapCircle(c.id, { name }), () => D.M.updateCircle(c.id, { name }));
    return true;
  }

  function changeMembers(c: Circle, change: { add: string } | { remove: string }): boolean {
    let members: string[];
    if ("remove" in change) members = c.members.filter((n) => n !== change.remove);
    else {
      const r = addNames(c.members, parseNames(change.add));
      if (r.issue) {
        toast(r.issue);
        return false;
      }
      members = r.names;
    }
    if (members.length === c.members.length) return true;
    void D.run(mapCircle(c.id, { members }), () => D.M.updateCircle(c.id, { members }));
    return true;
  }

  async function addCircle(value: string): Promise<string | null> {
    const name = value.trim();
    if (name === "") return null;
    if ([...name].length > CIRCLE_NAME_MAX) {
      toast(`묶음 이름은 1~${CIRCLE_NAME_MAX}자입니다`);
      return null;
    }
    return (await D.run(null, () => D.M.createCircle({ name })))?.id ?? null;
  }

  /** 지우면 그 묶음의 모임은 남고 묶음만 없는 것으로 읽힌다. 되돌리면 다시 붙는다 */
  async function removeCircle(c: Circle) {
    const ok = await D.run(
      (s) => ({ ...s, circles: s.circles.filter((x) => x.id !== c.id) }),
      async () => {
        await D.M.deleteCircle(c.id);
        return true;
      },
    );
    if (ok) toast("묶음을 지웠습니다", { label: "되돌리기", run: () => void D.run(null, () => D.M.restoreCircle(c.id)) });
  }

  // ------------------------------------------------------------ 줄의 우클릭 메뉴 (docs/공통.md 2장) — 모임 화면에 있는 동작

  /** 다음 모임: 같은 묶음 · 사람 · 지점 · 제목으로 새로 열고 그리로 간다 */
  async function makeNext(m: Meet) {
    if (!state) return;
    const n = nextMeet(m, state.circles);
    const made = await D.run(null, () => D.M.createMeet(n.input, n.people));
    if (made) router.push(href(`/meet/${made.id}`));
  }

  /** 딸린 일정 · 할 일은 남는다. 알림에서 되돌린다 */
  async function removeMeet(m: Meet) {
    const ok = await D.run(
      (s) => ({ ...s, meets: s.meets.filter((x) => x.id !== m.id) }),
      async (srv) => {
        await D.M.deleteMeet(m.id, D.versionOf(srv, m.id, m.version));
        return true;
      },
    );
    if (ok) toast("모임을 지웠습니다", { label: "되돌리기", run: () => void src.meet.restoreMeet(m.id).then(refreshMeets, fail) });
  }

  const lineMenu = (m: Meet) =>
    toEntries(meetMenu({ temp: m.id.startsWith("tmp-"), linked: m.token !== null }), (act) => {
      if (act === "open") router.push(href(`/meet/${m.id}`));
      else if (act === "edit") router.push(href(`/meet/${m.id}?edit=1`));
      else if (act === "next") void makeNext(m);
      else if (act === "copy") void copyMeetLink(m.token!, src.demo, toast);
      else void removeMeet(m);
    });

  // ------------------------------------------------------------ 그리기

  if (width === null || !state) return <div className="planner meet" />;

  const circles = state.circles;
  const roles = state.roles;

  const line = (m: Meet) => {
    const place = m.place_id ? placeOf.get(m.place_id) : undefined;
    const temp = m.id.startsWith("tmp-");
    const to = href(`/meet/${m.id}`);
    return (
      <li key={m.id} className="pl-row mt-row" data-id={m.id} {...cm.bind(`meet:${m.id}`, () => lineMenu(m))} onClick={() => !temp && router.push(to)}>
        {/* 지점이 없어도 점 자리는 둔다 — 제목이 줄끼리 가지런하게 */}
        <span className={place ? `sym pc-${place.color}` : "sym"} title={place?.name}>
          {place && <PlaceDot />}
        </span>
        {temp ? (
          <span className="nm">{m.title}</span>
        ) : (
          <Link className="nm" href={to} onClick={(e) => e.stopPropagation()}>
            {m.title}
          </Link>
        )}
        <span className="when num">{lineWhen(m)}</span>
        {sort.key !== "circle" && <span className="grp">{circleOf(m, circles)?.name ?? ""}</span>}
        <span className="cnt num" title="사람 수">
          {m.people.length}
        </span>
      </li>
    );
  };

  /** 한 카드의 줄들: 정렬에 따라 경계 묶음으로. 묶음 · 역할 정렬이면 묶음마다 라벨 줄(소제목 + 가는 선) */
  const rows = (card: MeetCard, list: readonly Meet[]) => (
    <div className="pl-groups">
      {sortMeets(list, sort, card, { circles, roles }).map((g: MeetGroup<Meet>) => (
        <Fragment key={g.key}>
          {g.kind !== "all" && (
            <h3 className="pl-g" data-flip={`g:${card}:${g.key}`}>
              <span className="t">{g.label}</span>
            </h3>
          )}
          <ul className="pl-rows">{g.items.map(line)}</ul>
        </Fragment>
      ))}
    </div>
  );

  let panel: ReactNode = null;
  let panelLabel = "";
  const panelKey = circleEdit ? "circles" : "new";
  if (circleEdit) {
    panelLabel = "묶음";
    panel = (
      <CircleEdit
        circles={circles}
        roles={roles}
        onRename={renameCircle}
        onMembers={changeMembers}
        onRole={(c, role_id) => void D.run(mapCircle(c.id, { role_id }), () => D.M.updateCircle(c.id, { role_id }))}
        onAdd={addCircle}
        onDelete={(c) => void removeCircle(c)}
      />
    );
  } else if (draft) {
    panelLabel = "새 모임";
    panel = (
      <MeetForm draft={draft} onChange={setDraft} circles={circles} places={state.places} isNew askName={state.settings.my_name === null} today={now.date} onSave={() => void saveNew()} onCancel={() => setDraft(null)} />
    );
  }

  const close = (
    <button type="button" className="iconbtn pl-x" aria-label="닫기" title="닫기" onClick={closePanel}>
      <Icon name="x" />
    </button>
  );
  const two = lists.todo.length > 0 && lists.upcoming.length + lists.past.length > 0;

  return (
    <div className="planner meet">
      <div className="bar-top pl-top">
        <HomeButton />
        <button type="button" className="btn mt-new" aria-expanded={draft !== null} onClick={openNew}>
          <Icon name="plus" />새 모임
        </button>
        <ThemeToggle />
      </div>
      <div className="pl-ctl">
        <div className="pl-sort" role="group" aria-label="정렬">
          {MEET_SORT_KEYS.map((k) => (
            <button type="button" key={k} className="rf" aria-pressed={sort.key === k} onClick={() => pickSort({ ...sort, key: k })}>
              {SORT_LABEL[k]}
            </button>
          ))}
          <button
            type="button"
            className="iconbtn rf-dir"
            aria-label={sort.dir === "asc" ? "오름차순" : "내림차순"}
            title={sort.dir === "asc" ? "오름차순" : "내림차순"}
            onClick={() => pickSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
          >
            <Icon name={sort.dir === "asc" ? "asc" : "desc"} />
          </button>
          <button type="button" className="iconbtn rf-edit" aria-label="묶음" title="묶음" aria-expanded={circleEdit} onClick={openCircles}>
            <Icon name="pen" />
          </button>
        </div>
      </div>
      <div className="pl-stage">
        <div className="pl-list" ref={listRef}>
          {/* 데스크톱은 두 열(왼쪽: 정할 것 · 오른쪽: 정해진 것), 좁으면 한 열로 쌓인다 */}
          <div className={two ? "pl-cols two" : "pl-cols"}>
            {lists.todo.length > 0 && (
              <div className="pl-col">
                <section className="pl-sec open" aria-label="정할 것">
                  <h2 className="pl-h">
                    정할 것<span className="num">{lists.todo.length}</span>
                  </h2>
                  {rows("todo", lists.todo)}
                </section>
              </div>
            )}
            {lists.upcoming.length + lists.past.length > 0 && (
              <div className="pl-col">
                {lists.upcoming.length > 0 && (
                  <section className="pl-sec" aria-label="다가오는 모임">
                    <h2 className="pl-h">
                      다가오는 모임<span className="num">{lists.upcoming.length}</span>
                    </h2>
                    {rows("upcoming", lists.upcoming)}
                  </section>
                )}
                {lists.past.length > 0 && (
                  <section className="pl-sec" aria-label="지난 모임">
                    <button type="button" className="pl-h pl-fold" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
                      지난 모임
                      <span className="num">{lists.past.length}</span>
                      <Icon name={showPast ? "up" : "down"} />
                    </button>
                    <Presence>
                      {showPast && (
                        <div className="fold" data-flip-skip="">
                          <div>{rows("past", lists.past)}</div>
                        </div>
                      )}
                    </Presence>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
        {!phone && wide && panel && (
          <aside className="dp pl-dp" aria-label={panelLabel}>
            {circleEdit && close}
            <div className="dp-in" key={panelKey}>
              {panel}
            </div>
          </aside>
        )}
        <Presence>
          {!phone && !wide && panel && (
            <aside className="dp pl-dp float" aria-label={panelLabel}>
              {circleEdit && close}
              <div className="dp-in" key={panelKey}>
                {panel}
              </div>
            </aside>
          )}
        </Presence>
      </div>
      <Presence>{phone && panel && <div className="scrim" onClick={closePanel} />}</Presence>
      <Presence>
        {phone && panel && (
          <div className="sheet" role="dialog" aria-label={panelLabel}>
            <span className="grab" />
            <div className="sh-in" key={panelKey}>
              {panel}
            </div>
          </div>
        )}
      </Presence>
      {cm.node}
    </div>
  );
}
