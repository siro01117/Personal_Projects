"use client";

// 탐색기 (설계서 5장). 큰 아이콘 격자 · 선택/열기 · 메뉴 · 끌어 놓기 · 새 폴더 · 이름 바꾸기 · 삭제/되돌리기 · 키보드.
// 저장은 화면을 먼저 바꾸고(낙관적) 실패하면 되돌린 뒤 알린다. 규칙의 최종 판정은 DB.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import { toKorean } from "../../lib/errors";
import { sameName, uniqueName, validateName } from "../../lib/names";
import type { Entry } from "../_data/types";
import { canDrop, folderTrail, gridMove, isUnread, moveTargets, sortEntries } from "../_logic/drawer";
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

type Renaming = { id: string; value: string; session: number; invalid?: boolean };
type MenuState = { x: number; y: number; entries: MenuEntry[] };

export function Explorer({ folderId }: { folderId: string | null }) {
  const { data, href, folders, foldersLoaded, refreshFolders, setFolders, tick, fail } = useDrawer();
  const toast = useToast();
  const router = useRouter();

  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const exRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef(0); // 진행 중인 저장 수 — 그동안은 다시 불러오기를 미룬다
  const loadSeq = useRef(0);
  const sessionSeq = useRef(0);
  const closedSession = useRef(-1);
  const creating = useRef(new Map<string, Promise<string | null>>());
  // 새 폴더의 임시 id 가 진짜 id 로 바뀌어도 같은 칸으로 남게 (입력 중인 이름·포커스 유지)
  const renderKey = useRef(new Map<string, string>());
  const pointerType = useRef<string>("mouse");
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });
  const entriesRef = useRef<Entry[] | null>(null);
  entriesRef.current = entries;
  const renamingRef = useRef<Renaming | null>(null);
  renamingRef.current = renaming;

  const trail = folderTrail(folders, folderId);
  const missing = folderId !== null && foldersLoaded && trail === null;
  const list = entries ? sortEntries(entries) : [];

  // ------------------------------------------------------------ 불러오기

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const rows = await data.list(folderId);
      if (seq === loadSeq.current) setEntries(rows);
    } catch (e) {
      if (seq === loadSeq.current) fail(e);
    }
  }, [data, folderId, fail]);

  // 폴더가 바뀌면 처음부터
  useEffect(() => {
    setEntries(null);
    setSel(null);
    setRenaming(null);
    setMenu(null);
    exRef.current?.focus({ preventScroll: true });
  }, [folderId]);

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
  const dropEntry = (id: string) => setEntries((prev) => prev && prev.filter((e) => e.id !== id));
  const putBack = (entry: Entry) => setEntries((prev) => (prev && !prev.some((e) => e.id === entry.id) ? [...prev, entry] : prev));

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    pending.current++;
    try {
      return await fn();
    } finally {
      pending.current--;
    }
  }

  const open = useCallback(
    (e: Entry) => {
      if (e.id.startsWith("tmp:")) return;
      router.push(href(e.kind === "folder" ? `/drawer/f/${e.id}` : `/drawer/r/${e.id}`));
    },
    [router, href],
  );

  const goFolder = useCallback((id: string | null) => router.push(href(id === null ? "/drawer" : `/drawer/f/${id}`)), [router, href]);

  const startRename = (id: string, value?: string, invalid?: boolean) => {
    const e = entriesRef.current?.find((x) => x.id === id);
    if (!e) return;
    setSel(id);
    setMenu(null);
    setRenaming({ id, value: value ?? e.name, session: ++sessionSeq.current, invalid });
  };

  function newFolder() {
    const cur = entriesRef.current;
    if (!cur || missing) return;
    const name = uniqueName(NEW_FOLDER, cur.map((e) => e.name));
    const tempId = `tmp:${++sessionSeq.current}`;
    const now = new Date().toISOString();
    const temp: Entry = { id: tempId, parent_id: folderId, kind: "folder", name, agent_updated_at: null, read_at: null, updated_at: now };
    setEntries((prev) => (prev ? [...prev, temp] : [temp]));
    setSel(tempId);
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
        setSel((s) => (s === tempId ? created.id : s));
        setRenaming((r) => (r && r.id === tempId ? { ...r, id: created.id } : r));
        setFolders((prev) => [...prev, { id: created.id, parent_id: created.parent_id, name: created.name }]);
        return created.id;
      },
      (e) => {
        dropEntry(tempId);
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

  async function move(entry: Entry, target: string | null) {
    if (!canDrop(folders, entry, target)) return;
    const targetName = target === null ? ROOT_NAME : (folders.find((f) => f.id === target)?.name ?? "");
    dropEntry(entry.id);
    setSel((s) => (s === entry.id ? null : s));
    try {
      const res = await run(() => data.move(entry.id, target));
      if (entry.kind === "folder") void refreshFolders();
      const undo = { label: "되돌리기", run: () => void moveBack(entry) };
      toast(
        res.renamed ? `같은 이름이 있어 ‘${res.name}’ 이름으로 옮겼습니다` : `‘${entry.name}’ → ${targetName}`,
        undo,
      );
    } catch (e) {
      putBack(entry);
      fail(e);
    }
  }

  async function moveBack(entry: Entry) {
    try {
      const res = await run(() => data.move(entry.id, entry.parent_id));
      if (entry.kind === "folder") void refreshFolders();
      await load();
      if (res.renamed) toast(`이름이 겹쳐 ‘${res.name}’ 이름으로 되돌렸습니다`);
    } catch (e) {
      fail(e);
    }
  }

  async function remove(entry: Entry) {
    if (entry.id.startsWith("tmp:")) return;
    dropEntry(entry.id);
    setSel(null);
    try {
      const batch = await run(() => data.remove(entry.id));
      if (entry.kind === "folder") void refreshFolders();
      toast(`‘${entry.name}’ 삭제`, { label: "되돌리기", run: () => void restore(entry, batch) });
    } catch (e) {
      putBack(entry);
      fail(e);
    }
  }

  async function restore(entry: Entry, batch: string) {
    try {
      const rows = await run(() => data.restore(batch));
      void refreshFolders();
      await load();
      const top = rows.find((r) => r.id === entry.id);
      if (top?.to_root && top.renamed) toast(`이름이 겹쳐 ‘${top.name}’ 이름으로 맨 위에 복원했습니다`);
      else if (top?.to_root) toast("맨 위로 복원했습니다");
      else if (top?.renamed) toast(`이름이 겹쳐 ‘${top.name}’ 이름으로 복원했습니다`);
    } catch (e) {
      fail(e);
    }
  }

  // ------------------------------------------------------------ 메뉴

  const closeMenu = useCallback(() => setMenu(null), []);

  function itemMenu(entry: Entry, x: number, y: number) {
    setSel(entry.id);
    const items: MenuEntry[] = [
      { kind: "item", icon: "open", label: "열기", run: () => open(entry) },
      { kind: "item", icon: "pen", label: "이름 바꾸기", run: () => startRename(entry.id) },
      { kind: "item", icon: "move", label: "옮기기", keep: true, run: () => showMoveMenu(entry, x, y) },
    ];
    if (entry.kind === "report") {
      items.push({ kind: "item", icon: "link", label: "공유", run: () => router.push(href(`/drawer/r/${entry.id}?share=1`)) });
    }
    items.push({ kind: "sep" }, { kind: "item", icon: "trash", label: "삭제", danger: true, run: () => void remove(entry) });
    setMenu({ x, y, entries: items });
  }

  function showMoveMenu(entry: Entry, x: number, y: number) {
    const targets = moveTargets(folders, entry);
    const items: MenuEntry[] = [{ kind: "head", label: "옮길 곳" }];
    for (const f of targets) {
      items.push({ kind: "item", icon: "folder", label: f === null ? ROOT_NAME : f.name, run: () => void move(entry, f === null ? null : f.id) });
    }
    if (targets.length === 0) items.push({ kind: "head", label: "옮길 폴더가 없습니다" });
    setMenu({ x, y, entries: items });
  }

  function blankMenu(x: number, y: number) {
    setSel(null);
    setMenu({ x, y, entries: [{ kind: "item", icon: "folder-plus", label: NEW_FOLDER, run: newFolder }] });
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
      itemMenu(entry, lp.x, lp.y);
    }, LONG_PRESS_MS);
  };

  const onItemPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const lp = longPress.current;
    if (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10) clearLongPress();
  };

  const onItemClick = (entry: Entry) => {
    if (longPress.current.fired) {
      longPress.current.fired = false;
      return;
    }
    if (renaming?.id === entry.id) return;
    if (pointerType.current === "touch") return open(entry);
    setSel(entry.id);
    focusExplorer();
  };

  // ------------------------------------------------------------ 끌어 놓기

  const dragEntry = dragId ? (entries?.find((e) => e.id === dragId) ?? null) : null;
  const canDropOn = (target: string | null) => dragEntry !== null && canDrop(folders, dragEntry, target);

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
      const d = dragEntry;
      setDragId(null);
      if (d && canDrop(folders, d, f.id)) void move(d, f.id);
    },
  });

  // ------------------------------------------------------------ 키보드

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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const i = list.findIndex((x) => x.id === sel);
    const cur = i >= 0 ? list[i]! : null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft":
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const j = gridMove(i, e.key, list.length, columns());
        const next = j >= 0 ? list[j] : undefined;
        if (next) {
          setSel(next.id);
          exRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
        }
        break;
      }
      case "Enter":
        if (cur) {
          e.preventDefault();
          open(cur);
        }
        break;
      case "F2":
        if (cur) {
          e.preventDefault();
          startRename(cur.id);
        }
        break;
      case "Delete":
        if (cur) {
          e.preventDefault();
          void remove(cur);
        }
        break;
      case "Backspace":
        if (folderId !== null) {
          e.preventDefault();
          goFolder(folders.find((f) => f.id === folderId)?.parent_id ?? null);
        }
        break;
      case "Escape":
        if (menu) setMenu(null);
        else setSel(null);
        break;
    }
  };

  // ------------------------------------------------------------ 그리기

  const crumbs: Crumb[] = [
    { id: null, name: ROOT_NAME },
    ...(trail ?? []).map((f) => ({ id: f.id, name: f.name })),
  ];
  // 없는 폴더면 서랍(맨 위)으로 돌아갈 수 있게 아무것도 현재로 두지 않는다
  if (!missing) crumbs[crumbs.length - 1]!.current = true;

  return (
    <>
      <div className="bar-top">
        <HomeButton />
        <Crumbs
          trail={crumbs}
          onGo={goFolder}
          dnd={{
            can: canDropOn,
            drop: (target) => {
              const d = dragEntry;
              setDragId(null);
              if (d) void move(d, target);
            },
          }}
        />
        <span className="grow" />
        <div className="tools">
          <button type="button" className="iconbtn" aria-label={NEW_FOLDER} title={NEW_FOLDER} onClick={newFolder} disabled={missing}>
            <Icon name="folder-plus" />
          </button>
        </div>
      </div>
      <div
        className="explorer"
        ref={exRef}
        role="listbox"
        aria-label="보고서와 폴더"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (!(e.target as Element).closest(".ex")) setSel(null);
        }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest(".ex")) return;
          e.preventDefault();
          if (!missing && entries) blankMenu(e.clientX, e.clientY);
        }}
      >
        {missing ? (
          <div className="empty">없는 폴더입니다</div>
        ) : entries === null ? null : list.length === 0 ? (
          <div className="empty">빈 폴더</div>
        ) : (
          list.map((entry) => {
            const isRenaming = renaming?.id === entry.id;
            const cls = [
              "ex",
              entry.kind,
              sel === entry.id ? "sel" : "",
              dropOver === entry.id ? "drop-over" : "",
              dragId === entry.id ? "dragging" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={renderKey.current.get(entry.id) ?? entry.id}
                className={cls}
                role="option"
                aria-selected={sel === entry.id}
                tabIndex={-1}
                data-id={entry.id}
                draggable={!coarse && !isRenaming && !entry.id.startsWith("tmp:")}
                onPointerDown={(e) => onItemPointerDown(e, entry)}
                onPointerMove={onItemPointerMove}
                onPointerUp={clearLongPress}
                onPointerCancel={clearLongPress}
                onClick={() => onItemClick(entry)}
                onDoubleClick={() => !isRenaming && open(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (pointerType.current === "touch") return; // 터치는 길게 누르기 타이머가 연다
                  itemMenu(entry, e.clientX, e.clientY);
                }}
                onDragStart={(e) => {
                  setMenu(null);
                  setDragId(entry.id);
                  e.dataTransfer.effectAllowed = "move";
                  try {
                    e.dataTransfer.setData("text/plain", entry.name);
                  } catch {
                    /* 일부 브라우저 */
                  }
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropOver(null);
                }}
                {...(entry.kind === "folder" ? folderDrop(entry) : {})}
              >
                <Icon name={entry.kind === "folder" ? "folder" : "rep"} className="ico" />
                {entry.kind === "report" && isUnread(entry) && <span className="dot" aria-label="안 읽음" />}
                {isRenaming ? (
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
                )}
              </div>
            );
          })
        )}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} />}
    </>
  );
}
