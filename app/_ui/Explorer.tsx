"use client";

// 탐색기 (설계서 5장 · 7-1장). 큰 아이콘 격자 · 여러 개 선택 · 열기 · 메뉴 · 끌어 놓기 · 새 폴더 · 이름 바꾸기
// · 복사/잘라내기/붙여넣기/사본 만들기 · 삭제 · 실행취소 · 정렬 · 찾기 · 키보드.
// 복제 단축키는 두지 않는다 — 같은 폴더에 Ctrl+C → Ctrl+V 가 '- 복사본' 을 만든다 (윈도우의 Ctrl+D 는 삭제라 반대 뜻).
// 저장은 화면을 먼저 바꾸고(낙관적) 실패하면 되돌린 뒤 알린다. 규칙의 최종 판정은 DB.

import { ThemeToggle } from "./ThemeToggle";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { toKorean } from "../../lib/errors";
import { TRASH_PATH } from "../../lib/links";
import { sameName, uniqueName, validateName } from "../../lib/names";
import type { Entry, SearchHit } from "../_data/types";
import {
  canDrop,
  folderTrail,
  freshAt,
  gridMove,
  isInside,
  isUnread,
  kindLabel,
  moveTargetsAll,
  relativeDay,
  restoreNote,
  selectRange,
  sortEntries,
  toggleId,
  type SortMode,
  type ViewMode,
} from "../_logic/drawer";
import { Crumbs, type Crumb } from "./Crumbs";
import { useDrawer } from "./DrawerContext";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";

const ROOT_NAME = "보고서 서랍";
const NEW_FOLDER = "새 폴더";
const LONG_PRESS_MS = 520;
const NAME_TAKEN = "같은 이름이 이미 있습니다";
const CYCLE = "폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다";
const SORT_KEY = "ez.drawer.sort";
const VIEW_KEY = "ez.drawer.view";
const UNDO = "되돌리기";

type Renaming = { id: string; value: string; session: number; invalid?: boolean };
type MenuState = { x: number; y: number; entries: MenuEntry[] };
type Find = { hits: SearchHit[] | null; sel: string | null };
type Item = { id: string; kind: Entry["kind"]; name: string; parent_id: string | null };

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "icons";
  } catch {
    return "icons";
  }
}

function readSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "date" ? "date" : "name";
  } catch {
    return "name";
  }
}

/** 입력칸·글자 고치기 칸에 초점이 있으면 단축키를 가로채지 않는다 */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** 알림에 쓰는 이름: 하나면 ‘이름’, 여럿이면 N개 */
const label = (items: readonly { name: string }[]) => (items.length === 1 ? `‘${items[0]!.name}’` : `${items.length}개`);

/** 단축키 글자 — 한글 자판이어도 Ctrl+ㅁ 이 Ctrl+A 로 */
function keyOf(e: KeyboardEvent): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key;
}

export function Explorer({ folderId }: { folderId: string | null }) {
  const { data, href, folders, foldersLoaded, refreshFolders, setFolders, tick, fail, rev, clip, setClip, pushUndo, undo } = useDrawer();
  const toast = useToast();
  const router = useRouter();

  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [picking, setPicking] = useState(false); // 터치: 길게 누르기 메뉴의 '선택' 으로 들어가는 선택 모드
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [unreadIn, setUnreadIn] = useState<ReadonlySet<string>>(() => new Set());
  const [sort, setSort] = useState<SortMode>("name");
  const [view, setView] = useState<ViewMode>("icons");
  const [find, setFind] = useState<Find | null>(null);

  const exRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef(0); // 진행 중인 저장 수 — 그동안은 다시 불러오기를 미룬다
  const loadSeq = useRef(0);
  const findSeq = useRef(0);
  const sessionSeq = useRef(0);
  const closedSession = useRef(-1);
  const creating = useRef(new Map<string, Promise<string | null>>());
  // 새 폴더의 임시 id 가 진짜 id 로 바뀌어도 같은 칸으로 남게 (입력 중인 이름·포커스 유지)
  const renderKey = useRef(new Map<string, string>());
  const pointerType = useRef<string>("mouse");
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });
  /** Shift 클릭의 기준 · 화살표의 출발점 */
  const anchor = useRef<string | null>(null);
  const entriesRef = useRef<Entry[] | null>(null);
  entriesRef.current = entries;
  const renamingRef = useRef<Renaming | null>(null);
  renamingRef.current = renaming;
  const selRef = useRef<string[]>(sel);
  selRef.current = sel;

  const trail = folderTrail(folders, folderId);
  const missing = folderId !== null && foldersLoaded && trail === null;
  const list = entries ? sortEntries(entries, sort) : [];
  const selected = list.filter((e) => sel.includes(e.id) && !e.id.startsWith("tmp:"));
  const cutIds = clip?.mode === "cut" ? new Set(clip.items.map((i) => i.id)) : null;
  /** 목록 보기 (찾기 결과는 늘 아이콘) */
  const isList = view === "list" && !find;

  // ------------------------------------------------------------ 불러오기

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [rows, unread] = await Promise.all([data.list(folderId), data.unreadFolders()]);
      if (seq !== loadSeq.current) return;
      setEntries(rows);
      setUnreadIn(new Set(unread));
    } catch (e) {
      if (seq === loadSeq.current) fail(e);
    }
  }, [data, folderId, fail]);

  // 폴더가 바뀌면 처음부터
  useEffect(() => {
    setEntries(null);
    setSel([]);
    anchor.current = null;
    setRenaming(null);
    setMenu(null);
    setFind(null);
    exRef.current?.focus({ preventScroll: true });
  }, [folderId]);

  // 정렬은 기기에 기억 (그리기가 끝난 뒤 읽어 서버·클라이언트 첫 그림을 맞춘다)
  useEffect(() => {
    setSort(readSort());
    setView(readView());
  }, []);
  const toggleView = () => {
    const next: ViewMode = view === "icons" ? "list" : "icons";
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 저장 못 해도 이번에는 바뀐다 */
    }
  };
  const toggleSort = () => {
    const next: SortMode = sort === "name" ? "date" : "name";
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* 저장 못 해도 이번에는 바뀐다 */
    }
  };

  // 선택이 비면 선택 모드도 끝
  useEffect(() => {
    if (sel.length === 0) setPicking(false);
  }, [sel.length]);

  // 터치 화면은 끌어 놓기 대신 메뉴의 옮기기
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 폴더에 들어오면 늘 불러온다
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void load();
  }, [load]);

  // 다시 불러오기 신호(창 복귀·30초): 저장 중이거나 이름 입력 중이면 덮어쓰지 않고 다음 신호를 기다린다
  const seenTick = useRef(tick);
  useEffect(() => {
    if (seenTick.current === tick) return;
    seenTick.current = tick;
    if (pending.current > 0 || renamingRef.current) return;
    void loadRef.current();
  }, [tick]);

  // 되돌리기가 끝나면 무조건 다시 불러온다
  const seenRev = useRef(rev);
  useEffect(() => {
    if (seenRev.current === rev) return;
    seenRev.current = rev;
    void loadRef.current();
  }, [rev]);

  // 경로에 없는 폴더(그 사이 지워짐 등)면 폴더 목록을 한 번 더 확인
  const rechecked = useRef<string | null>(null);
  useEffect(() => {
    if (folderId !== null && foldersLoaded && trail === null && rechecked.current !== folderId) {
      rechecked.current = folderId;
      void refreshFolders();
    }
  }, [folderId, foldersLoaded, trail, refreshFolders]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && renaming && document.activeElement !== el) {
      el.focus();
      el.select();
    }
  }, [renaming?.session]);

  const focusExplorer = () => exRef.current?.focus({ preventScroll: true });

  // ------------------------------------------------------------ 조작

  const patchEntry = (id: string, patch: Partial<Entry>) =>
    setEntries((prev) => prev && prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const dropEntries = (ids: ReadonlySet<string>) => setEntries((prev) => prev && prev.filter((e) => !ids.has(e.id)));

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    pending.current++;
    try {
      return await fn();
    } finally {
      pending.current--;
    }
  }

  const open = useCallback(
    (e: { id: string; kind: Entry["kind"] }) => {
      if (e.id.startsWith("tmp:")) return;
      router.push(href(e.kind === "folder" ? `/drawer/f/${e.id}` : `/drawer/r/${e.id}`));
    },
    [router, href],
  );

  const goFolder = useCallback((id: string | null) => router.push(href(id === null ? "/drawer" : `/drawer/f/${id}`)), [router, href]);

  const selectOnly = (id: string) => {
    setSel([id]);
    anchor.current = id;
  };

  const startRename = (id: string, value?: string, invalid?: boolean) => {
    const e = entriesRef.current?.find((x) => x.id === id);
    if (!e) return;
    selectOnly(id);
    setMenu(null);
    setRenaming({ id, value: value ?? e.name, session: ++sessionSeq.current, invalid });
  };

  function newFolder() {
    const cur = entriesRef.current;
    if (!cur || missing) return;
    const name = uniqueName(NEW_FOLDER, cur.map((e) => e.name));
    const tempId = `tmp:${++sessionSeq.current}`;
    const now = new Date().toISOString();
    const temp: Entry = { id: tempId, parent_id: folderId, kind: "folder", name, report_kind: null, agent_updated_at: null, read_at: null, created_at: now, updated_at: now, shared: false };
    setEntries((prev) => (prev ? [...prev, temp] : [temp]));
    selectOnly(tempId);
    setRenaming({ id: tempId, value: name, session: sessionSeq.current });

    const p = run(async () => {
      let tryName = name;
      for (let attempt = 0; ; attempt++) {
        try {
          return await data.createFolder(folderId, tryName);
        } catch (e) {
          // 그 사이 같은 이름이 생겼으면(에이전트 등) 목록을 다시 보고 한 번 더
          if ((e as { code?: string }).code !== "23505" || attempt >= 1) throw e;
          tryName = uniqueName(NEW_FOLDER, (await data.list(folderId)).map((x) => x.name));
        }
      }
    }).then(
      (created) => {
        renderKey.current.set(created.id, tempId);
        setEntries((prev) => prev && prev.map((e) => (e.id === tempId ? created : e)));
        setSel((s) => s.map((x) => (x === tempId ? created.id : x)));
        if (anchor.current === tempId) anchor.current = created.id;
        setRenaming((r) => (r && r.id === tempId ? { ...r, id: created.id } : r));
        setFolders((prev) => [...prev, { id: created.id, parent_id: created.parent_id, name: created.name }]);
        pushUndo(async () => {
          await data.remove(created.id);
        });
        return created.id;
      },
      (e) => {
        dropEntries(new Set([tempId]));
        setRenaming((r) => (r && r.id === tempId ? null : r));
        fail(e);
        return null;
      },
    );
    creating.current.set(tempId, p);
  }

  async function commitRename(value: string) {
    const r = renamingRef.current;
    if (!r || closedSession.current === r.session) return;
    closedSession.current = r.session;

    let id = r.id;
    if (id.startsWith("tmp:")) {
      const real = await creating.current.get(id);
      if (!real) return;
      id = real;
    }
    const entry = entriesRef.current?.find((e) => e.id === id);
    const name = value.trim();
    const close = () => {
      setRenaming((cur) => (cur && cur.session === r.session ? null : cur));
      focusExplorer();
    };
    if (!entry || name === "" || name === entry.name) return close();

    const reopen = (message: string) => {
      toast(message);
      setRenaming({ id, value, session: ++sessionSeq.current, invalid: true });
    };
    const bad = validateName(name);
    if (bad) return reopen(bad);
    if (entriesRef.current?.some((e) => e.id !== id && sameName(e.name, name))) return reopen(NAME_TAKEN);

    const prev = entry.name;
    patchEntry(id, { name });
    close();
    try {
      await run(() => data.rename(id, name));
      if (entry.kind === "folder") setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, name } : f)));
      pushUndo(() => data.rename(id, prev));
    } catch (e) {
      patchEntry(id, { name: prev });
      const k = toKorean(e);
      if (k.code === "NAME_TAKEN") reopen(NAME_TAKEN);
      else fail(e);
    }
  }

  function cancelRename() {
    const r = renamingRef.current;
    if (!r) return;
    closedSession.current = r.session;
    setRenaming(null);
    focusExplorer();
  }

  /**
   * 옮기기 (끌어 놓기 · 옮기기 메뉴 · 잘라내기 붙여넣기). 하나씩 옮기고, 옮긴 것은 되돌리기 하나로 묶는다.
   * here = 지금 보이는 폴더의 항목이면 화면에서 먼저 뺀다(낙관적)
   */
  async function moveItems(items: readonly Item[], target: string | null, here = true) {
    const movable = items.filter((it) => !it.id.startsWith("tmp:") && canDrop(folders, it, target));
    if (movable.length === 0) return;
    const targetName = target === null ? ROOT_NAME : (folders.find((f) => f.id === target)?.name ?? "");
    const ids = new Set(movable.map((m) => m.id));
    if (here) {
      dropEntries(ids);
      setSel((s) => s.filter((x) => !ids.has(x)));
    }
    const done: { item: Item; name: string; renamed: boolean }[] = [];
    let error: unknown = null;
    await run(async () => {
      for (const it of movable) {
        try {
          done.push({ item: it, ...(await data.move(it.id, target)) });
        } catch (e) {
          error ??= e;
        }
      }
    });
    if (movable.some((m) => m.kind === "folder")) void refreshFolders();
    if (error !== null || !here) await load();
    if (error !== null) fail(error);
    if (done.length === 0) return;
    if (!here) {
      setSel(done.map((d) => d.item.id));
      anchor.current = done[0]!.item.id;
    }

    const undoId = pushUndo(async () => {
      for (const d of [...done].reverse()) {
        const res = await data.move(d.item.id, d.item.parent_id);
        if (res.renamed && done.length === 1) toast(`이름이 겹쳐 ‘${res.name}’ 이름으로 되돌렸습니다`);
      }
    });
    if (error !== null) return;
    const one = done.length === 1 ? done[0]! : null;
    toast(
      one?.renamed ? `같은 이름이 있어 ‘${one.name}’ 이름으로 옮겼습니다` : `${label(done.map((d) => d.item))} → ${targetName}`,
      { label: UNDO, run: () => void undo(undoId) },
    );
  }

  async function removeItems(items: readonly Entry[]) {
    const live = items.filter((e) => !e.id.startsWith("tmp:"));
    if (live.length === 0) return;
    const ids = new Set(live.map((e) => e.id));
    dropEntries(ids);
    setSel([]);
    try {
      const batch = await run(() => (live.length === 1 ? data.remove(live[0]!.id) : data.removeMany([...ids])));
      if (live.some((e) => e.kind === "folder")) void refreshFolders();
      const undoId = pushUndo(async () => {
        const rows = await data.restore(batch);
        const note = restoreNote(rows, [...ids]);
        if (note) toast(note);
      });
      toast(`${label(live)} 삭제`, { label: UNDO, run: () => void undo(undoId) });
    } catch (e) {
      setEntries((prev) => prev && [...prev, ...live.filter((x) => !prev.some((p) => p.id === x.id))]);
      fail(e);
    }
  }

  /** 복사 (붙여넣기 · 사본 만들기). ez_copy 한 번 — 전부 되거나 전부 안 된다 */
  async function copyItems(items: readonly Item[], to: string | null) {
    const src = items.filter((e) => !e.id.startsWith("tmp:"));
    if (src.length === 0 || missing) return;
    try {
      const made = await run(() => data.copy(src.map((i) => i.id), to));
      if (src.some((i) => i.kind === "folder")) void refreshFolders();
      await load();
      setSel(made.map((m) => m.id));
      anchor.current = made[0]?.id ?? null;
      const undoId = pushUndo(async () => {
        const ids = made.map((m) => m.id);
        await (ids.length === 1 ? data.remove(ids[0]!) : data.removeMany(ids));
      });
      toast(`${label(made)} 복사`, { label: UNDO, run: () => void undo(undoId) });
    } catch (e) {
      fail(e);
    }
  }

  function paste() {
    if (!clip || missing || entries === null || find) return;
    if (clip.mode === "copy") return void copyItems(clip.items, folderId);
    // 잘라내기 붙여넣기 = 옮기기. 폴더를 자기 안으로는 알린다(끌어 놓기와 달리 눈에 안 보이므로)
    if (folderId !== null && clip.items.some((it) => it.kind === "folder" && isInside(folders, folderId, it.id))) return void toast(CYCLE);
    const items = clip.items;
    setClip(null);
    void moveItems(items, folderId, false);
  }

  const clipSelected = (mode: "copy" | "cut", items: readonly Entry[] = selected) => {
    if (items.length > 0) setClip({ mode, items: [...items] });
  };

  // ------------------------------------------------------------ 찾기 (서랍 전체, ez_search)

  const openFind = () => {
    setMenu(null);
    setSel([]);
    setFind({ hits: null, sel: null });
  };
  const closeFind = () => {
    findSeq.current++;
    setFind(null);
    focusExplorer();
  };
  async function runFind(q: string) {
    if (q.trim() === "") return;
    const seq = ++findSeq.current;
    try {
      const hits = await data.search(q);
      if (seq === findSeq.current) setFind((f) => f && { hits, sel: null });
    } catch (e) {
      if (seq === findSeq.current) fail(e);
    }
  }
  const pathLine = (parentId: string | null) =>
    [ROOT_NAME, ...(folderTrail(folders, parentId) ?? []).map((f) => f.name)].join(" › ");

  // ------------------------------------------------------------ 메뉴

  const closeMenu = useCallback(() => setMenu(null), []);

  function itemMenu(entry: Entry, x: number, y: number, touch = false) {
    const cur = selRef.current;
    let targets: Entry[];
    if (cur.includes(entry.id) && cur.length > 1) {
      targets = (entriesRef.current ?? []).filter((e) => cur.includes(e.id) && !e.id.startsWith("tmp:"));
    } else {
      selectOnly(entry.id);
      targets = [entry];
    }
    const one = targets.length === 1 ? targets[0]! : null;
    const items: MenuEntry[] = [];
    if (touch && !picking) {
      items.push({ kind: "item", icon: "select", label: "선택", run: () => (setPicking(true), selectOnly(entry.id)) });
    }
    if (one) {
      items.push(
        { kind: "item", icon: "open", label: "열기", run: () => open(one) },
        { kind: "item", icon: "pen", label: "이름 바꾸기", run: () => startRename(one.id) },
      );
    }
    items.push(
      { kind: "item", icon: "copy", label: "복사", run: () => clipSelected("copy", targets) },
      { kind: "item", icon: "cut", label: "잘라내기", run: () => clipSelected("cut", targets) },
      { kind: "item", icon: "dup", label: "사본 만들기", run: () => void copyItems(targets, folderId) },
      { kind: "item", icon: "move", label: "옮기기", keep: true, run: () => showMoveMenu(targets, x, y) },
    );
    if (one?.kind === "report") {
      items.push({ kind: "item", icon: "link", label: "공유", run: () => router.push(href(`/drawer/r/${one.id}?share=1`)) });
    }
    items.push({ kind: "sep" }, { kind: "item", icon: "trash", label: "삭제", danger: true, run: () => void removeItems(targets) });
    setMenu({ x, y, entries: items });
  }

  function showMoveMenu(targets: Entry[], x: number, y: number) {
    const dests = moveTargetsAll(folders, targets);
    const items: MenuEntry[] = [{ kind: "head", label: "옮길 곳" }];
    for (const f of dests) {
      items.push({ kind: "item", icon: "folder", label: f === null ? ROOT_NAME : f.name, run: () => void moveItems(targets, f === null ? null : f.id) });
    }
    if (dests.length === 0) items.push({ kind: "head", label: "옮길 폴더가 없습니다" });
    setMenu({ x, y, entries: items });
  }

  function blankMenu(x: number, y: number) {
    setSel([]);
    const items: MenuEntry[] = [{ kind: "item", icon: "folder-plus", label: NEW_FOLDER, run: newFolder }];
    if (clip) items.push({ kind: "item", icon: "paste", label: "붙여넣기", run: paste });
    setMenu({ x, y, entries: items });
  }

  // ------------------------------------------------------------ 누르기 · 길게 누르기

  const clearLongPress = () => clearTimeout(longPress.current.timer);

  const onItemPointerDown = (e: PointerEvent, entry: Entry) => {
    pointerType.current = e.pointerType;
    if (e.pointerType !== "touch") return;
    const lp = longPress.current;
    lp.fired = false;
    lp.x = e.clientX;
    lp.y = e.clientY;
    clearLongPress();
    lp.timer = setTimeout(() => {
      lp.fired = true;
      itemMenu(entry, lp.x, lp.y, true);
    }, LONG_PRESS_MS);
  };

  const onItemPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const lp = longPress.current;
    if (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10) clearLongPress();
  };

  const onItemClick = (e: MouseEvent, entry: Entry) => {
    if (longPress.current.fired) {
      longPress.current.fired = false;
      return;
    }
    if (renaming?.id === entry.id) return;
    if (pointerType.current === "touch") {
      if (picking) setSel((s) => toggleId(s, entry.id));
      else open(entry);
      return;
    }
    if (e.shiftKey) {
      setSel(selectRange(list.map((x) => x.id), anchor.current, entry.id));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => toggleId(s, entry.id));
      anchor.current = entry.id;
    } else {
      selectOnly(entry.id);
    }
    focusExplorer();
  };

  // ------------------------------------------------------------ 끌어 놓기 (선택한 것 전부)

  const dragItems = dragIds ? list.filter((e) => dragIds.includes(e.id)) : [];
  const canDropOn = (target: string | null) => dragItems.length > 0 && dragItems.every((it) => canDrop(folders, it, target));

  const folderDrop = (f: Entry) => ({
    onDragOver: (e: DragEvent) => {
      if (!canDropOn(f.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropOver(f.id);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as Element).contains(e.relatedTarget as Node | null)) setDropOver((o) => (o === f.id ? null : o));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropOver(null);
      const items = dragItems;
      setDragIds(null);
      if (items.length > 0 && items.every((it) => canDrop(folders, it, f.id))) void moveItems(items, f.id);
    },
  });

  // ------------------------------------------------------------ 키보드 (문서 전체에서 받되, 입력칸·다른 곳에 초점이 있으면 무시)

  function columns(): number {
    const items = exRef.current?.querySelectorAll<HTMLElement>(".ex");
    if (!items || items.length === 0) return 1;
    const top = items[0]!.offsetTop;
    let n = 0;
    for (const it of items) {
      if (it.offsetTop !== top) break;
      n++;
    }
    return Math.max(1, n);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isTyping(e.target) || menu) return;
    const active = document.activeElement;
    if (active && active !== document.body && !exRef.current?.contains(active)) return;
    const mod = e.ctrlKey || e.metaKey;

    if (find) {
      const hit = find.hits?.find((h) => h.id === find.sel);
      if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      } else if (e.key === "Enter" && hit) {
        e.preventDefault();
        open(hit);
      }
      return;
    }

    if (mod && !e.altKey) {
      switch (keyOf(e)) {
        case "a":
          e.preventDefault();
          setSel(list.filter((x) => !x.id.startsWith("tmp:")).map((x) => x.id));
          break;
        case "c":
          if (selected.length > 0) {
            e.preventDefault();
            clipSelected("copy");
          }
          break;
        case "x":
          if (selected.length > 0) {
            e.preventDefault();
            clipSelected("cut");
          }
          break;
        case "v":
          e.preventDefault();
          paste();
          break;
        case "z":
          if (!e.shiftKey) {
            e.preventDefault();
            void undo();
          }
          break;
      }
      return;
    }

    const lead = anchor.current !== null && sel.includes(anchor.current) ? anchor.current : (sel[sel.length - 1] ?? null);
    const i = list.findIndex((x) => x.id === lead);
    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft":
      case "ArrowDown":
      case "ArrowUp": {
        // 목록 보기는 위아래만 (윈도우 자세히 보기처럼)
        if (isList && (e.key === "ArrowLeft" || e.key === "ArrowRight")) break;
        e.preventDefault();
        const j = gridMove(i, e.key, list.length, columns());
        const next = j >= 0 ? list[j] : undefined;
        if (next) {
          selectOnly(next.id);
          exRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
        }
        break;
      }
      case "Enter":
        if (selected.length === 1) {
          e.preventDefault();
          open(selected[0]!);
        }
        break;
      case "F2":
        if (selected.length === 1) {
          e.preventDefault();
          startRename(selected[0]!.id);
        }
        break;
      case "Delete":
        if (selected.length > 0) {
          e.preventDefault();
          void removeItems(selected);
        }
        break;
      case "Backspace":
        if (folderId !== null) {
          e.preventDefault();
          goFolder(folders.find((f) => f.id === folderId)?.parent_id ?? null);
        }
        break;
      case "Escape":
        setSel([]);
        break;
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  // ------------------------------------------------------------ 그리기

  const crumbs: Crumb[] = [
    { id: null, name: ROOT_NAME },
    ...(trail ?? []).map((f) => ({ id: f.id, name: f.name })),
  ];
  // 없는 폴더면 서랍(맨 위)으로 돌아갈 수 있게 아무것도 현재로 두지 않는다
  if (!missing) crumbs[crumbs.length - 1]!.current = true;

  const sortLabel = sort === "name" ? "이름순" : "날짜순";
  const viewLabel = view === "icons" ? "목록 보기" : "아이콘 보기";

  return (
    <>
      <div className="bar-top">
        <HomeButton />
        {find ? (
          <input
            className="find"
            type="search"
            autoFocus
            aria-label="찾기"
            enterKeyHint="search"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // 한글 조합 중 Enter 는 글자 확정용
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                void runFind(e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
        ) : (
          <Crumbs
            trail={crumbs}
            onGo={goFolder}
            dnd={{
              can: canDropOn,
              drop: (target) => {
                const items = dragItems;
                setDragIds(null);
                if (items.length > 0) void moveItems(items, target);
              },
            }}
          />
        )}
        <span className="grow" />
        <div className="tools">
          <button
            type="button"
            className="iconbtn"
            aria-label="찾기"
            title="찾기"
            aria-pressed={find !== null}
            onClick={() => (find ? closeFind() : openFind())}
          >
            <Icon name="search" />
          </button>
          {!find && (
            <>
              <button type="button" className="iconbtn" aria-label={viewLabel} title={viewLabel} onClick={toggleView}>
                <Icon name={view === "icons" ? "list" : "icons"} />
              </button>
              <button type="button" className="iconbtn" aria-label={sortLabel} title={sortLabel} onClick={toggleSort}>
                <Icon name={sort === "name" ? "sort-name" : "sort-date"} />
              </button>
              <button type="button" className="iconbtn" aria-label={NEW_FOLDER} title={NEW_FOLDER} onClick={newFolder} disabled={missing}>
                <Icon name="folder-plus" />
              </button>
              {/* 폰 폭: 사이드바가 숨으므로 맨 위 화면에서만 휴지통으로 */}
              {folderId === null && (
                <Link className="iconbtn mtrash" href={href(TRASH_PATH)} aria-label="휴지통" title="휴지통">
                  <Icon name="trash" />
                </Link>
              )}
            </>
          )}
        </div>
        <ThemeToggle />
      </div>
      <div
        className={isList ? "explorer list" : "explorer"}
        ref={exRef}
        role="listbox"
        aria-label="보고서와 폴더"
        aria-multiselectable={true}
        tabIndex={0}
        onClick={(e) => {
          if ((e.target as Element).closest(".ex")) return;
          if (find) setFind((f) => f && { ...f, sel: null });
          else setSel([]);
        }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest(".ex")) return;
          e.preventDefault();
          if (!missing && entries && !find) blankMenu(e.clientX, e.clientY);
        }}
      >
        {find ? (
          find.hits === null ? null : find.hits.length === 0 ? (
            <div className="empty">찾는 것이 없습니다</div>
          ) : (
            find.hits.map((h) => (
              <div
                key={h.id}
                className={`ex ${h.kind}${find.sel === h.id ? " sel" : ""}`}
                role="option"
                aria-selected={find.sel === h.id}
                tabIndex={-1}
                data-id={h.id}
                onPointerDown={(e) => (pointerType.current = e.pointerType)}
                onClick={() => {
                  if (pointerType.current === "touch") return open(h);
                  setFind((f) => f && { ...f, sel: h.id });
                  focusExplorer();
                }}
                onDoubleClick={() => open(h)}
              >
                <Icon name={h.kind === "folder" ? "folder" : "rep"} className="ico" />
                <span className="nm">{h.name}</span>
                <span className="at">{pathLine(h.parent_id)}</span>
              </div>
            ))
          )
        ) : missing ? (
          <div className="empty">없는 폴더입니다</div>
        ) : entries === null ? null : list.length === 0 ? (
          <div className="empty">빈 폴더</div>
        ) : (
          <>
            {isList && (
              <div className="ex-head" aria-hidden="true">
                <span>이름</span>
                <span className="c-kind">종류</span>
                <span>고친 때</span>
              </div>
            )}
            {list.map((entry) => {
              const isRenaming = renaming?.id === entry.id;
              const isSel = sel.includes(entry.id);
              const unread = entry.kind === "folder" ? unreadIn.has(entry.id) : isUnread(entry);
              const cls = [
                "ex",
                entry.kind,
                isSel ? "sel" : "",
                dropOver === entry.id ? "drop-over" : "",
                dragIds?.includes(entry.id) ? "dragging" : "",
                cutIds?.has(entry.id) ? "cut" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const icon = (
                <span className="ico-wrap">
                  <Icon name={entry.kind === "folder" ? "folder" : "rep"} className="ico" />
                  {entry.kind === "report" && entry.shared && (
                    <span className="pub" aria-label="공개 중">
                      <Icon name="link" />
                    </span>
                  )}
                </span>
              );
              const dot = unread && <span className="dot" aria-label="안 읽음" />;
              const nameEl = isRenaming ? (
                  <input
                    ref={inputRef}
                    className="rn"
                    aria-label="새 이름"
                    aria-invalid={renaming.invalid ? true : undefined}
                    defaultValue={renaming.value}
                    key={renaming.session}
                    maxLength={200}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        // 한글 조합 중 Enter 는 글자 확정용 — 저장하지 않는다 (안 그러면 마지막 글자가 잘리거나 두 번 저장)
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        void commitRename(e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={(e) => void commitRename(e.currentTarget.value)}
                  />
                ) : (
                  <span className="nm">{entry.name}</span>
                );
              return (
                <div
                  key={renderKey.current.get(entry.id) ?? entry.id}
                  className={cls}
                  role="option"
                  aria-selected={isSel}
                  tabIndex={-1}
                  data-id={entry.id}
                  draggable={!coarse && !isRenaming && !entry.id.startsWith("tmp:")}
                  onPointerDown={(e) => onItemPointerDown(e, entry)}
                  onPointerMove={onItemPointerMove}
                  onPointerUp={clearLongPress}
                  onPointerCancel={clearLongPress}
                  onClick={(e) => onItemClick(e, entry)}
                  onDoubleClick={(e) => !isRenaming && !e.shiftKey && !e.ctrlKey && !e.metaKey && open(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (pointerType.current === "touch") return; // 터치는 길게 누르기 타이머가 연다
                    itemMenu(entry, e.clientX, e.clientY);
                  }}
                  onDragStart={(e) => {
                    setMenu(null);
                    const cur = selRef.current;
                    if (cur.includes(entry.id)) setDragIds(cur.filter((x) => !x.startsWith("tmp:")));
                    else {
                      selectOnly(entry.id);
                      setDragIds([entry.id]);
                    }
                    e.dataTransfer.effectAllowed = "move";
                    try {
                      e.dataTransfer.setData("text/plain", entry.name);
                    } catch {
                      /* 일부 브라우저 */
                    }
                  }}
                  onDragEnd={() => {
                    setDragIds(null);
                    setDropOver(null);
                  }}
                  {...(entry.kind === "folder" ? folderDrop(entry) : {})}
                >
                  {isList ? (
                    <>
                      <span className="c-name">
                        {icon}
                        {nameEl}
                        {dot}
                      </span>
                      <span className="c-kind">{kindLabel(entry)}</span>
                      <span className="c-when">{relativeDay(freshAt(entry))}</span>
                    </>
                  ) : (
                    <>
                      {icon}
                      {dot}
                      {nameEl}
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} />}
    </>
  );
}
