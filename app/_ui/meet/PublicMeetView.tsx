"use client";

// 모임의 공개 페이지 /m/[열쇠] (docs/모임.md 5장) — 로그인 없이 0012 의 함수 넷만 부른다(ez_meet_public · enter · answer · rsvp).
// 처음: 제목 · 지점 · 사람 이름들(미리 넣어 둔 이름은 눌러 고르고, 없으면 적는다) → 핀번호(처음이면 정하기, 다시 오면 확인).
// 이 기기에는 이름과 핀을 기억해 다시 묻지 않는다. 맞추는 중이면 격자를 끌어 칠하고(손을 떼면 저장), 정해진 뒤에는 정한 시간이 크게 + 온다 / 못 온다.
// 없는 열쇠 · 끈 링크 · 지운 모임은 한 줄 "없는 링크입니다" (있었는지 드러내지 않는다). 일정 제목 · 메모 같은 주최자 것은 애초에 오지 않는다.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { clipCells, nameKey, PERSON_NAME_MAX, PIN_RE, pollSlots, type Attend, type Cells, type PublicMeet } from "../../../lib/meet";
import { useSource } from "../../_data/source";
import { cellHeight, decidedText, publicKorean } from "../../_logic/meet";
import { Icon } from "../Icon";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { MeetGrid } from "./MeetGrid";

const PHONE_MAX = 760;
/** 이 기기에 기억하는 이름 · 핀 (링크마다 따로) */
const memoKey = (token: string) => `ezwork.meet.${token}`;
const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

type Me = { name: string; pin: string };

function remembered(token: string): Me | null {
  try {
    const v = JSON.parse(localStorage.getItem(memoKey(token)) ?? "null") as Partial<Me> | null;
    return v && typeof v.name === "string" && typeof v.pin === "string" ? { name: v.name, pin: v.pin } : null;
  } catch {
    return null;
  }
}

function remember(token: string, me: Me | null): void {
  try {
    if (me) localStorage.setItem(memoKey(token), JSON.stringify(me));
    else localStorage.removeItem(memoKey(token));
  } catch {
    // 기억만 못 한다
  }
}

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

export function PublicMeetView({ token }: { token: string }) {
  const src = useSource();
  const toast = useToast();
  const view = useViewport();
  const P = src?.meetPublic ?? null;

  const [meet, setMeet] = useState<PublicMeet | null | "gone">(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  /** 저장은 줄 세워 하나씩 — 늦게 온 앞 저장의 답이 뒤 저장을 덮지 않게 */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saving = useRef(0);

  const gone = useCallback((e: unknown) => {
    // 연결 실패만 따로 알린다. 그 밖의 실패는 없는 링크와 똑같이
    const k = publicKorean(e);
    if (k.code === "NETWORK") setNetError(k.message);
    setMeet("gone");
  }, []);

  // 처음: 읽고, 이 기기에 기억해 둔 이름 · 핀이 있으면 바로 들어간다
  useEffect(() => {
    if (!P) return;
    let alive = true;
    P.open(token).then(async (m) => {
      if (!alive) return;
      if (!m) return setMeet("gone");
      setMeet(m);
      const memo = remembered(token);
      if (!memo) return;
      try {
        const r = await P.enter(token, memo.name, memo.pin);
        if (!alive) return;
        setMe({ name: r.me, pin: memo.pin });
        setMeet(r.meet);
      } catch (e) {
        if (!alive) return;
        // 핀이 바뀌었거나 잠겼다 — 기억을 지우고 다시 묻는다
        remember(token, null);
        setName(memo.name);
        setErr(publicKorean(e).message);
      }
    }, (e) => alive && gone(e));
    return () => {
      alive = false;
    };
  }, [P, token, gone]);

  // 창에 돌아오면 다른 사람이 칠한 것을 다시 읽는다 (저장 중이면 건너뛴다)
  useEffect(() => {
    if (!P) return;
    const f = () => {
      if (document.visibilityState !== "visible" || saving.current > 0) return;
      void P.open(token).then((m) => {
        if (saving.current > 0) return;
        setMeet((cur) => (cur === null ? cur : (m ?? "gone")));
      }, () => {});
    };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [P, token]);

  const m = meet !== null && meet !== "gone" ? meet : null;
  const mine = useMemo(() => (m && me ? (m.people.find((p) => p.name === me.name) ?? null) : null), [m, me]);

  if (meet === null) return null;
  if (!m || !P) {
    return (
      <div className="app">
        <div className="corner-tools">
          <ThemeToggle />
        </div>
        <div className="gone">{netError ?? "없는 링크입니다"}</div>
      </div>
    );
  }

  const when = decidedText(m);
  const polling = m.poll !== null && when === null;
  const phone = (view?.w ?? 1440) <= PHONE_MAX;
  const others = m.people.filter((p) => !p.is_owner);
  const picked = others.find((p) => nameKey(p.name) === nameKey(name)) ?? null;

  // ------------------------------------------------------------ 들어오기 · 나가기

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !P) return;
    const n = name.trim();
    if (n === "") return setErr("이름을 고르거나 적어 주세요");
    if ([...n].length > PERSON_NAME_MAX) return setErr(`이름은 ${PERSON_NAME_MAX}자까지입니다`);
    if (!PIN_RE.test(pin)) return setErr("핀번호는 숫자 4~6자리입니다");
    setBusy(true);
    setErr(null);
    try {
      const r = await P.enter(token, n, pin);
      const next = { name: r.me, pin };
      remember(token, next);
      setMe(next);
      setMeet(r.meet);
      setPin("");
    } catch (e2) {
      const k = publicKorean(e2);
      if (k.code === "EZ_NOT_FOUND") setMeet("gone");
      else setErr(k.message);
    } finally {
      setBusy(false);
    }
  }

  function leave() {
    remember(token, null);
    setName(me?.name ?? "");
    setMe(null);
    setPin("");
    setErr(null);
    setFocus(null);
  }

  // ------------------------------------------------------------ 저장 (화면 먼저, 실패하면 되돌린다)

  function save(apply: (cur: PublicMeet) => PublicMeet, call: (who: Me) => Promise<{ meet: PublicMeet }>) {
    if (!me || !m) return;
    const who = me;
    const before = m;
    setMeet(apply(m));
    saving.current++;
    queue.current = queue.current.then(async () => {
      try {
        const r = await call(who);
        saving.current--;
        if (saving.current === 0) setMeet(r.meet);
      } catch (e) {
        saving.current--;
        const k = publicKorean(e);
        if (k.code === "EZ_NOT_FOUND") return setMeet("gone");
        setMeet(before);
        if (k.code === "EZ_PIN" || k.code === "EZ_LOCKED") {
          // 주최자가 핀을 지웠거나 잠겼다 — 다시 들어오게 한다
          remember(token, null);
          setName(who.name);
          setMe(null);
          setErr(k.message);
        } else {
          toast(k.message);
          // 그 사이 시간이 정해졌을 수 있다 — 새로 읽는다
          void P!.open(token).then((x) => setMeet(x ?? "gone"), () => {});
        }
      }
    });
  }

  function paint(cells: Cells) {
    const poll = m!.poll;
    if (!poll || !me) return;
    const inside = clipCells(cells, poll);
    save(
      (cur) => ({ ...cur, people: cur.people.map((p) => (p.name === me.name ? { ...p, cells } : p)) }),
      (who) => P!.answer(token, who.name, who.pin, inside),
    );
  }

  function rsvp(value: Attend) {
    if (!me) return;
    const next = mine?.attend === value ? null : value;
    save(
      (cur) => ({ ...cur, people: cur.people.map((p) => (p.name === me.name ? { ...p, attend: next } : p)) }),
      (who) => P!.rsvp(token, who.name, who.pin, next),
    );
  }

  // ------------------------------------------------------------ 그리기

  const place = [m.place, m.where].filter((x): x is string => x !== null && x !== "");

  return (
    <div className="app pm">
      <div className="corner-tools">
        <ThemeToggle />
      </div>
      <main className="pm-in">
        <header className="pm-head">
          <h1>{m.title}</h1>
          {place.length > 0 && (
            <p className="pm-place">
              <Icon name="pin" />
              <span>{place.join(" · ")}</span>
            </p>
          )}
        </header>

        {me && (
          <div className="pm-me">
            <span className="chip who">
              {me.name}
              <button type="button" aria-label="나가기" title="나가기" onClick={leave}>
                <Icon name="x" />
              </button>
            </span>
          </div>
        )}

        {when && (
          <section className="pm-card pm-when" aria-label="정한 시간">
            <p className="day">{when.day}</p>
            <p className="time num">{when.time}</p>
            {me && (
              <div className="att big" role="group" aria-label="참석">
                <button type="button" aria-pressed={mine?.attend === "yes"} onClick={() => rsvp("yes")}>
                  온다
                </button>
                <button type="button" className="no" aria-pressed={mine?.attend === "no"} onClick={() => rsvp("no")}>
                  못 온다
                </button>
              </div>
            )}
          </section>
        )}

        {!me && (
          <form className="pm-card pm-enter" aria-label="들어가기" onSubmit={(e) => void submit(e)}>
            {others.length > 0 && (
              <div className="chips" role="group" aria-label="이름 고르기">
                {others.map((p) => (
                  <button type="button" key={p.name} className="chip" aria-pressed={picked?.name === p.name} onClick={() => { setName(picked?.name === p.name ? "" : p.name); setErr(null); }}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <input
              className="txt-in"
              placeholder="이름"
              aria-label="이름"
              autoComplete="off"
              maxLength={PERSON_NAME_MAX}
              value={name}
              onChange={(e) => { setName(e.target.value); setErr(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && composing(e)) e.preventDefault();
              }}
            />
            <input
              className="txt-in num pin"
              placeholder="핀번호 4~6자리"
              aria-label={picked?.has_pin ? "핀번호" : "핀번호 정하기"}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/[^0-9]/g, "")); setErr(null); }}
            />
            {err && (
              <p className="err" role="alert">
                {err}
              </p>
            )}
            <button type="submit" className="btn" disabled={busy}>
              들어가기
            </button>
          </form>
        )}

        {m.poll && view && (polling ? me !== null : true) && (
          <section className="pm-card pm-grid" aria-label="되는 시간">
            <MeetGrid
              poll={m.poll}
              people={m.people}
              me={me?.name ?? null}
              variant="guest"
              editable={polling && me !== null}
              focus={focus}
              cellH={cellHeight(pollSlots(m.poll).length, view.h, phone)}
              label="되는 시간"
              onPaint={paint}
            />
          </section>
        )}

        {me && m.people.length > 0 && (
          <section className="pm-card pm-people" aria-label="사람들">
            <div className="chips" role="group" aria-label="사람들">
              {m.people.map((p) =>
                m.poll ? (
                  <button type="button" key={p.name} className="chip" aria-pressed={focus === p.name} onClick={() => setFocus(focus === p.name ? null : p.name)}>
                    {p.name}
                    {when && p.attend && <i className={p.attend}>{p.attend === "yes" ? "온다" : "못 온다"}</i>}
                  </button>
                ) : (
                  <span key={p.name} className="chip">
                    {p.name}
                    {when && p.attend && <i className={p.attend}>{p.attend === "yes" ? "온다" : "못 온다"}</i>}
                  </span>
                ),
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
