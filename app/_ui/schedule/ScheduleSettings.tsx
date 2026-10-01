"use client";

// 일정 설정 (docs/일정.md 6장 '설정'): 지점(이름 · 역할 · 심볼 · 색 · 순서 · 지우기, 12개까지) · 이동시간 표(빈칸 = 모름)
// · 외출 준비 처음/다시 · 집 들르기 · 식사 길이. 바꾸면 바로 저장하고, 실패하면 알린 뒤 다시 읽는다.

import Link from "next/link";
import { useState, type KeyboardEvent } from "react";
import {
  DEFAULT_SETTINGS,
  PLACE_COLORS,
  PLACE_NAME_MAX,
  PLACE_SYMBOLS,
  PLACES_MAX,
  type Place,
  type PlaceRole,
  type Settings,
} from "../../../lib/schedule";
import { mondayOf, nowIn } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { PlaceSymbol, SYMBOL_NAMES } from "./PlaceSymbol";
import { useScheduleData, type Meta } from "./useScheduleData";

const ROLES: { role: PlaceRole | null; label: string }[] = [
  { role: "home", label: "집" },
  { role: "work", label: "근무지" },
  { role: "school", label: "학교" },
  { role: null, label: "없음" },
];

const COLOR_NAMES: Record<string, string> = {
  sky: "하늘",
  violet: "보라",
  peach: "살구",
  sand: "모래",
  mint: "민트",
  pink: "분홍",
  teal: "청록",
  yellow: "노랑",
};

const NUMS: { key: keyof Pick<Settings, "prep_first" | "prep_again" | "home_stay" | "meal_min">; label: string; max: number }[] = [
  { key: "prep_first", label: "처음 외출 준비", max: 120 },
  { key: "prep_again", label: "다시 나갈 때 준비", max: 120 },
  { key: "home_stay", label: "집 들르기 최소", max: 600 },
  { key: "meal_min", label: "식사", max: 120 },
];

/** 한글 조합 중 Enter 는 글자 확정용 */
const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);

export function ScheduleSettings() {
  const { href } = useApp();
  const toast = useToast();
  const [week] = useState(() => mondayOf(nowIn(DEFAULT_SETTINGS.tz).date));
  const D = useScheduleData(week);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const meta = D.meta;
  const live = (meta?.places ?? []).filter((p) => !p.deleted).sort((a, b) => a.sort - b.sort);

  const patchPlace = (id: string, patch: Partial<Place>) => (m: Meta): Meta => ({
    ...m,
    places: m.places.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });

  /** 잘못된 값이면 알리고 false — 칸을 원래 값으로 되돌린다 */
  function rename(p: Place, value: string): boolean {
    const name = value.trim();
    if (name === p.name) return true;
    if (name === "" || [...name].length > PLACE_NAME_MAX) {
      toast(`지점 이름은 1~${PLACE_NAME_MAX}자입니다`);
      return false;
    }
    void D.runMeta(patchPlace(p.id, { name }), () => D.S.updatePlace(p.id, { name }));
    return true;
  }

  function setPlace(p: Place, patch: Partial<Pick<Place, "role" | "symbol" | "color">>) {
    void D.runMeta(patchPlace(p.id, patch), () => D.S.updatePlace(p.id, patch));
  }

  async function addPlace() {
    const name = newName.trim();
    if (name === "") return;
    if ([...name].length > PLACE_NAME_MAX) {
      toast(`지점 이름은 1~${PLACE_NAME_MAX}자입니다`);
      return;
    }
    const sort = Math.max(0, ...live.map((p) => p.sort)) + 1;
    const made = await D.runMeta(null, () => D.S.createPlace({ name, role: null, sort }));
    if (made) {
      setNewName("");
      setOpen(made.id);
    }
  }

  async function swap(i: number, j: number) {
    const a = live[i];
    const b = live[j];
    if (!a || !b) return;
    // 같은 sort 가 섞여 있으면 순서대로 다시 매긴다
    const sorts = live.map((p, k) => (new Set(live.map((x) => x.sort)).size === live.length ? p.sort : k + 1));
    const sa = sorts[j]!;
    const sb = sorts[i]!;
    await D.runMeta(
      (m) => ({ ...m, places: m.places.map((p) => (p.id === a.id ? { ...p, sort: sa } : p.id === b.id ? { ...p, sort: sb } : p)) }),
      async () => {
        if (sorts.some((s, k) => s !== live[k]!.sort)) {
          for (const [k, p] of live.entries()) if (p.id !== a.id && p.id !== b.id) await D.S.updatePlace(p.id, { sort: sorts[k]! });
        }
        await D.S.updatePlace(a.id, { sort: sa });
        await D.S.updatePlace(b.id, { sort: sb });
      },
    );
  }

  function remove(p: Place) {
    if (confirmDel !== p.id) {
      setConfirmDel(p.id);
      return;
    }
    setConfirmDel(null);
    void D.runMeta((m) => ({ ...m, places: m.places.map((x) => (x.id === p.id ? { ...x, deleted: true } : x)) }), () => D.S.deletePlace(p.id));
  }

  function travelOf(a: string, b: string): number | null {
    const [x, y] = a < b ? [a, b] : [b, a];
    return meta?.travel.find((t) => t.a === x && t.b === y)?.minutes ?? null;
  }

  function setTravel(a: string, b: string, value: string): boolean {
    const v = value.trim();
    const minutes = v === "" ? null : Number(v);
    if (minutes === travelOf(a, b)) return true;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) {
      toast("이동시간은 1~600분입니다. 모르면 비워 두세요");
      return false;
    }
    const [x, y] = a < b ? [a, b] : [b, a];
    void D.runMeta(
      (m) => ({
        ...m,
        travel: [...m.travel.filter((t) => !(t.a === x && t.b === y)), ...(minutes === null ? [] : [{ a: x, b: y, minutes }])],
      }),
      () => D.S.setTravel(x, y, minutes),
    );
    return true;
  }

  function setNum(key: (typeof NUMS)[number]["key"], max: number, value: string): boolean {
    if (!meta) return true;
    const n = Number(value.trim());
    if (value.trim() === "" || !Number.isInteger(n) || n < 0 || n > max) {
      toast(`0~${max}분으로 써 주세요`);
      return false;
    }
    if (n === meta.settings[key]) return true;
    void D.runMeta((m) => ({ ...m, settings: { ...m.settings, [key]: n } }), () => D.S.saveSettings({ [key]: n }));
    return true;
  }

  return (
    <div className="sched">
      <div className="bar-top">
        <HomeButton />
        <Link className="iconbtn" href={href("/schedule")} aria-label="일정으로" title="일정으로">
          <Icon name="left" />
        </Link>
        <h1>설정</h1>
        <span className="grow" />
        <ThemeToggle />
      </div>
      {meta && (
        <div className="sset">
          <section aria-labelledby="h-places">
            <h2 id="h-places">지점</h2>
            {live.map((p, i) => (
              <div key={p.id} className={`prow pc-${p.color}`}>
                <button
                  type="button"
                  className="sym"
                  aria-expanded={open === p.id}
                  aria-label={`${p.name} 역할 · 심볼 · 색`}
                  title="역할 · 심볼 · 색"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  <PlaceSymbol symbol={p.symbol} />
                </button>
                <input
                  className="txt-in nm"
                  defaultValue={p.name}
                  key={`${p.id}:${p.name}`}
                  aria-label="지점 이름"
                  maxLength={PLACE_NAME_MAX}
                  onBlur={(e) => {
                    if (!rename(p, e.target.value)) e.target.value = p.name;
                  }}
                  onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
                />
                <div className="ord">
                  <button type="button" className="iconbtn" aria-label="위로" title="위로" disabled={i === 0} onClick={() => void swap(i, i - 1)}>
                    <Icon name="up" />
                  </button>
                  <button type="button" className="iconbtn" aria-label="아래로" title="아래로" disabled={i === live.length - 1} onClick={() => void swap(i, i + 1)}>
                    <Icon name="down" />
                  </button>
                </div>
                {confirmDel === p.id ? (
                  <button type="button" className="del" onClick={() => remove(p)} onBlur={() => setConfirmDel(null)} autoFocus>
                    지우기
                  </button>
                ) : (
                  <button type="button" className="iconbtn" aria-label={`${p.name} 지우기`} title="지우기" onClick={() => remove(p)}>
                    <Icon name="trash" />
                  </button>
                )}
                {open === p.id && (
                  <div className="opts">
                    <div className="chips" role="group" aria-label="역할">
                      {ROLES.map((r) => (
                        <button
                          type="button"
                          key={r.label}
                          className="chip"
                          aria-pressed={p.role === r.role}
                          onClick={() => p.role !== r.role && setPlace(p, { role: r.role })}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="symbols" role="group" aria-label="심볼">
                      {PLACE_SYMBOLS.map((s) => (
                        <button type="button" key={s} aria-pressed={p.symbol === s} aria-label={SYMBOL_NAMES[s]} title={SYMBOL_NAMES[s]} onClick={() => setPlace(p, { symbol: s })}>
                          <PlaceSymbol symbol={s} />
                        </button>
                      ))}
                    </div>
                    <div className="swatches" role="group" aria-label="색">
                      {PLACE_COLORS.map((c) => (
                        <button
                          type="button"
                          key={c}
                          className={`swatch pc-${c}`}
                          aria-pressed={p.color === c}
                          aria-label={COLOR_NAMES[c]}
                          title={COLOR_NAMES[c]}
                          onClick={() => setPlace(p, { color: c })}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {live.length < PLACES_MAX && (
              <div className="prow">
                <span className="sym" aria-hidden="true">
                  <Icon name="plus" />
                </span>
                <input
                  className="txt-in nm"
                  placeholder="새 지점"
                  aria-label="새 지점 이름"
                  maxLength={PLACE_NAME_MAX}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (enter(e)) {
                      e.preventDefault();
                      void addPlace();
                    }
                  }}
                />
                {newName.trim() !== "" && (
                  <button type="button" className="ghost" onClick={() => void addPlace()}>
                    더하기
                  </button>
                )}
              </div>
            )}
          </section>

          {live.length >= 2 && (
            <section aria-labelledby="h-travel">
              <h2 id="h-travel">이동시간 (분)</h2>
              <div className="ttable">
                <table>
                  <thead>
                    <tr>
                      <th />
                      {live.slice(1).map((p) => (
                        <th key={p.id} scope="col">
                          {p.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {live.slice(0, -1).map((a, i) => (
                      <tr key={a.id}>
                        <th scope="row">{a.name}</th>
                        {live.slice(1).map((b, j) =>
                          j + 1 > i ? (
                            <td key={b.id}>
                              <input
                                inputMode="numeric"
                                defaultValue={travelOf(a.id, b.id) ?? ""}
                                key={`${a.id}:${b.id}:${travelOf(a.id, b.id) ?? ""}`}
                                aria-label={`${a.name} – ${b.name} 이동시간(분)`}
                                onBlur={(e) => {
                                  if (!setTravel(a.id, b.id, e.target.value)) e.target.value = String(travelOf(a.id, b.id) ?? "");
                                }}
                                onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
                              />
                            </td>
                          ) : (
                            <td key={b.id} />
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section aria-labelledby="h-prep">
            <h2 id="h-prep">외출 준비 · 식사 (분)</h2>
            <div className="nums">
              {NUMS.map((n) => (
                <label key={n.key}>
                  {n.label}
                  <input
                    inputMode="numeric"
                    defaultValue={meta.settings[n.key]}
                    key={`${n.key}:${meta.settings[n.key]}`}
                    onBlur={(e) => {
                      if (!setNum(n.key, n.max, e.target.value)) e.target.value = String(meta.settings[n.key]);
                    }}
                    onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
                  />
                </label>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
