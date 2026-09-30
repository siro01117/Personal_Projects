import { describe, expect, it } from "vitest";
import type { Folder } from "../_data/types";
import {
  canDrop,
  collapseTrail,
  domainOf,
  folderTrail,
  formatDay,
  formatToday,
  formatWhen,
  freshAt,
  imageCredit,
  kindLabel,
  relativeDay,
  gridMove,
  groupTrash,
  httpUrl,
  isInside,
  isUnread,
  moveTargets,
  moveTargetsAll,
  restoreNote,
  safeNext,
  selectRange,
  sortEntries,
  textAt,
  toggleId,
  trashLabel,
  withTextAt,
} from "./drawer";

const F = (id: string, parent_id: string | null, name: string): Folder => ({ id, parent_id, name });
// a ─ b ─ c,  d
const folders = [F("a", null, "가"), F("b", "a", "나"), F("c", "b", "다"), F("d", null, "Delta")];

describe("정렬", () => {
  it("폴더 먼저, 각각 한국어 이름순 — 한글이 영문보다 앞", () => {
    const list = [
      { kind: "report" as const, name: "Zeta" },
      { kind: "report" as const, name: "가나" },
      { kind: "folder" as const, name: "apple" },
      { kind: "folder" as const, name: "사과" },
      { kind: "report" as const, name: "alpha" },
    ];
    expect(sortEntries(list).map((x) => x.name)).toEqual(["사과", "apple", "가나", "alpha", "Zeta"]);
  });

  it("날짜순: 폴더 먼저, 폴더끼리는 이름순, 보고서끼리 최근 고친 것 먼저", () => {
    const list = [
      { kind: "report" as const, name: "옛 보고서", updated_at: "2026-09-01T00:00:00Z" },
      { kind: "report" as const, name: "새 보고서", updated_at: "2026-09-30T00:00:00Z" },
      { kind: "folder" as const, name: "하 폴더", updated_at: "2026-09-20T00:00:00Z" },
      { kind: "folder" as const, name: "나 폴더", updated_at: "2026-09-10T00:00:00Z" },
      { kind: "folder" as const, name: "가 폴더", updated_at: "2026-09-10T00:00:00Z" },
    ];
    expect(sortEntries(list, "date").map((x) => x.name)).toEqual(["가 폴더", "나 폴더", "하 폴더", "새 보고서", "옛 보고서"]);
    // 보고서끼리는 이름과 반대여도 날짜
    const reps = [
      { kind: "report" as const, name: "가 옛것", updated_at: "2026-09-01T00:00:00Z" },
      { kind: "report" as const, name: "하 새것", updated_at: "2026-09-30T00:00:00Z" },
    ];
    expect(sortEntries(reps, "date").map((x) => x.name)).toEqual(["하 새것", "가 옛것"]);
    expect(sortEntries(reps, "name").map((x) => x.name)).toEqual(["가 옛것", "하 새것"]);
    expect(sortEntries(list, "name").map((x) => x.name)).toEqual(["가 폴더", "나 폴더", "하 폴더", "새 보고서", "옛 보고서"]);
  });

  it("원본은 그대로", () => {
    const list = [{ kind: "report" as const, name: "b" }, { kind: "folder" as const, name: "a" }];
    sortEntries(list);
    expect(list[0]!.name).toBe("b");
  });
});

describe("안 읽음", () => {
  it("에이전트가 쓴 뒤 안 열었으면", () => {
    expect(isUnread({ agent_updated_at: null, read_at: null })).toBe(false);
    expect(isUnread({ agent_updated_at: "2026-09-30T10:00:00Z", read_at: null })).toBe(true);
    expect(isUnread({ agent_updated_at: "2026-09-30T10:00:00Z", read_at: "2026-09-30T09:00:00Z" })).toBe(true);
    expect(isUnread({ agent_updated_at: "2026-09-30T10:00:00Z", read_at: "2026-09-30T10:00:00Z" })).toBe(false);
    expect(isUnread({ agent_updated_at: "2026-09-30T10:00:00Z", read_at: "2026-09-30T11:00:00Z" })).toBe(false);
  });
});

describe("경로", () => {
  it("맨 위 → 폴더 줄", () => {
    expect(folderTrail(folders, null)).toEqual([]);
    expect(folderTrail(folders, "c")!.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(folderTrail(folders, "zz")).toBeNull();
    // 중간 폴더가 그 사이 지워짐
    expect(folderTrail([F("c", "b", "다")], "c")).toBeNull();
  });

  it("가운데를 … 로 접는다", () => {
    const t = ["서랍", "1", "2", "3", "4", "5"];
    expect(collapseTrail(t, 4)).toEqual([
      { kind: "item", item: "서랍" },
      { kind: "more", hidden: ["1", "2", "3"] },
      { kind: "item", item: "4" },
      { kind: "item", item: "5" },
    ]);
    expect(collapseTrail(["서랍", "1", "2", "3"], 4).every((c) => c.kind === "item")).toBe(true);
    expect(collapseTrail(["서랍", "1", "2", "3", "4"], 4)[1]).toEqual({ kind: "more", hidden: ["1", "2"] });
  });

  it("안에 있는지", () => {
    expect(isInside(folders, "c", "a")).toBe(true);
    expect(isInside(folders, "a", "a")).toBe(true);
    expect(isInside(folders, "d", "a")).toBe(false);
    expect(isInside(folders, null, "a")).toBe(false);
  });
});

describe("키보드 격자 이동", () => {
  it("좌우 한 칸, 위아래 한 줄, 끝에서 멈춤", () => {
    expect(gridMove(-1, "ArrowRight", 5, 3)).toBe(0);
    expect(gridMove(0, "ArrowRight", 5, 3)).toBe(1);
    expect(gridMove(4, "ArrowRight", 5, 3)).toBe(4);
    expect(gridMove(0, "ArrowLeft", 5, 3)).toBe(0);
    expect(gridMove(1, "ArrowDown", 5, 3)).toBe(4);
    expect(gridMove(2, "ArrowDown", 5, 3)).toBe(2);
    expect(gridMove(4, "ArrowUp", 5, 3)).toBe(1);
    expect(gridMove(0, "ArrowUp", 5, 3)).toBe(0);
    expect(gridMove(0, "ArrowDown", 0, 3)).toBe(-1);
  });
});

describe("옮기기", () => {
  it("옮길 곳: 지금 폴더·자기·자기 안 폴더 빼고 이름순, 맨 위는 맨 위에 있지 않을 때만", () => {
    const folderA = { id: "a", kind: "folder" as const, parent_id: null };
    expect(moveTargets(folders, folderA).map((f) => f?.id ?? null)).toEqual(["d"]);
    const report = { id: "r", kind: "report" as const, parent_id: "b" };
    expect(moveTargets(folders, report).map((f) => f?.id ?? null)).toEqual([null, "a", "c", "d"]);
  });

  it("여러 개 옮길 곳: 모두에게 뜻이 있는 곳만", () => {
    const a = { id: "a", kind: "folder" as const, parent_id: null };
    const r = { id: "r", kind: "report" as const, parent_id: null };
    expect(moveTargetsAll(folders, [a, r]).map((f) => f?.id ?? null)).toEqual(["d"]);
    expect(moveTargetsAll(folders, [r]).map((f) => f?.id ?? null)).toEqual(["a", "b", "c", "d"]);
    expect(moveTargetsAll(folders, [])).toEqual([]);
  });

  it("놓기: 자기 위·지금 폴더 위·자기 안은 무동작", () => {
    const b = { id: "b", kind: "folder" as const, parent_id: "a" };
    expect(canDrop(folders, b, "b")).toBe(false);
    expect(canDrop(folders, b, "a")).toBe(false);
    expect(canDrop(folders, b, "c")).toBe(false);
    expect(canDrop(folders, b, "d")).toBe(true);
    expect(canDrop(folders, b, null)).toBe(true);
    const r = { id: "r", kind: "report" as const, parent_id: null };
    expect(canDrop(folders, r, null)).toBe(false);
    expect(canDrop(folders, r, "c")).toBe(true);
  });
});

describe("여러 개 선택", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("Shift: 기준부터 누른 것까지 (앞뒤 어느 쪽이든)", () => {
    expect(selectRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(selectRange(ids, "c", "c")).toEqual(["c"]);
    expect(selectRange(ids, null, "c")).toEqual(["c"]);
    expect(selectRange(ids, "없음", "c")).toEqual(["c"]);
    expect(selectRange(ids, "a", "없음")).toEqual([]);
  });
  it("Ctrl: 넣거나 빼기", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("휴지통", () => {
  it("묶음마다 한 줄, 첫 맨 위 항목 이름 + 외 (나머지 맨 위 항목 수)개. 하나면 이름만", () => {
    const rows = [
      { batch: "2", deleted_at: "2026-09-30T10:00:00Z", name: "둘", count: 2 },
      { batch: "2", deleted_at: "2026-09-30T10:00:00Z", name: "하나", count: 2 },
      { batch: "1", deleted_at: "2026-09-30T09:00:00Z", name: "폴더", count: 4 },
      { batch: "0", deleted_at: "2026-09-29T09:00:00Z", name: "혼자", count: 1 },
    ];
    const g = groupTrash(rows);
    expect(g.map((x) => [x.batch, trashLabel(x.first.name, x.tops)])).toEqual([
      ["2", "둘 외 1개"],
      ["1", "폴더"], // 자손 3개는 세지 않는다
      ["0", "혼자"],
    ]);
  });
});

describe("복원 알림", () => {
  const r = (id: string, name: string, to_root = false, renamed = false) => ({ id, name, to_root, renamed });
  it("하나: 맨 위로 · 이름 바꿈 · 둘 다 · 그대로", () => {
    expect(restoreNote([r("a", "가", true), r("b", "안")], ["a"])).toBe("맨 위로 복원했습니다");
    expect(restoreNote([r("a", "가 (2)", false, true)], ["a"])).toBe("이름이 겹쳐 ‘가 (2)’ 이름으로 복원했습니다");
    expect(restoreNote([r("a", "가 (2)", true, true)], ["a"])).toBe("이름이 겹쳐 ‘가 (2)’ 이름으로 맨 위에 복원했습니다");
    expect(restoreNote([r("a", "가")], ["a"])).toBeNull();
  });
  it("여럿: 맨 위 항목만 본다", () => {
    expect(restoreNote([r("a", "가"), r("b", "나", true)], ["a", "b"])).toBe("일부는 맨 위로 복원했습니다");
    expect(restoreNote([r("a", "가", false, true), r("b", "나", true)], ["a", "b"])).toBe("일부는 맨 위로, 일부는 이름을 바꿔 복원했습니다");
    expect(restoreNote([r("a", "가"), r("c", "안", true, true)], ["a", "b"])).toBeNull();
  });
});

describe("그 밖", () => {
  it("날짜", () => {
    const now = new Date(2026, 8, 30, 12);
    expect(formatDay(new Date(2026, 8, 27, 9).toISOString(), now)).toBe("9월 27일");
    expect(formatDay(new Date(2025, 0, 2, 9).toISOString(), now)).toBe("2025년 1월 2일");
    expect(formatDay(null, now)).toBe("");
    expect(formatToday(now)).toBe("9월 30일 수요일");
    expect(formatWhen(new Date(2026, 8, 27, 9, 5).toISOString(), now)).toBe("9월 27일 09:05");
    expect(formatWhen(new Date(2025, 0, 2, 23, 59).toISOString(), now)).toBe("2025년 1월 2일 23:59");
    expect(formatWhen(null, now)).toBe("");
  });

  it("돌아갈 곳은 같은 사이트 경로만", () => {
    expect(safeNext("/drawer/f/1?demo=1")).toBe("/drawer/f/1?demo=1");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });

  it("링크는 http/https 만", () => {
    expect(httpUrl("https://a.com/x")).toBe("https://a.com/x");
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl("data:text/html,x")).toBeNull();
    expect(httpUrl("not a url")).toBeNull();
    expect(domainOf("https://www.xda-developers.com/a?b")).toBe("xda-developers.com");
    expect(domainOf("http://pglite.dev/docs/")).toBe("pglite.dev");
    expect(domainOf("없음")).toBeNull();
  });

  it("블록 안 글자 읽기·바꾸기 (원본은 그대로)", () => {
    const blocks = [{ type: "table", rows: [["a", "b"]] }];
    expect(textAt(blocks, [0, "rows", 0, 1])).toBe("b");
    expect(textAt(blocks, [0, "type", "x"])).toBeNull();
    const next = withTextAt(blocks, [0, "rows", 0, 1], "B");
    expect(textAt(next, [0, "rows", 0, 1])).toBe("B");
    expect(textAt(blocks, [0, "rows", 0, 1])).toBe("b");
    expect(withTextAt(blocks, [0, "rows"], "x")).toBe(blocks);
  });
});

describe("신선도 · 목록 보기", () => {
  const now = new Date(2026, 8, 30, 9, 0);
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

  it("오늘 · 어제 · n일 전 · n주 전 · 날짜 — 시각이 아니라 달력 날짜로 센다", () => {
    expect(relativeDay(at(2026, 9, 30, 0), now)).toBe("오늘");
    expect(relativeDay(at(2026, 9, 30, 23), now)).toBe("오늘"); // 미래(시계 차이)도 오늘
    expect(relativeDay(at(2026, 9, 29, 23), now)).toBe("어제"); // 10시간 전이어도 날짜가 바뀌었으면 어제
    expect(relativeDay(at(2026, 9, 28), now)).toBe("2일 전");
    expect(relativeDay(at(2026, 9, 24), now)).toBe("6일 전");
    expect(relativeDay(at(2026, 9, 23), now)).toBe("1주 전");
    expect(relativeDay(at(2026, 9, 3), now)).toBe("3주 전");
    expect(relativeDay(at(2026, 9, 2), now)).toBe("9월 2일");
    expect(relativeDay(at(2025, 12, 31), now)).toBe("2025년 12월 31일");
    expect(relativeDay(null, now)).toBe("");
    expect(relativeDay("엉뚱", now)).toBe("");
  });

  it("기준 시각: 보고서는 에이전트가 쓴 때 → 없으면 만든 때, 폴더는 고친 때", () => {
    const base = { agent_updated_at: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" };
    expect(freshAt({ ...base, kind: "report", agent_updated_at: "2026-09-10T00:00:00Z" })).toBe("2026-09-10T00:00:00Z");
    expect(freshAt({ ...base, kind: "report" })).toBe("2026-09-01T00:00:00Z");
    expect(freshAt({ ...base, kind: "folder" })).toBe("2026-09-20T00:00:00Z");
  });

  it("종류 열", () => {
    expect(kindLabel({ kind: "folder" })).toBe("폴더");
    expect(kindLabel({ kind: "report", report_kind: "method" })).toBe("작업 방식 조사");
    expect(kindLabel({ kind: "report", report_kind: "reference" })).toBe("레퍼런스 조사");
    expect(kindLabel({ kind: "report", report_kind: null })).toBe("보고서");
  });

  it("날짜순은 '고친 때' 열과 같은 값: 에이전트가 쓴 때 → 없으면 만든 때 (사람이 글자만 고친 updated_at 은 안 봄)", () => {
    const R = (name: string, agent_updated_at: string | null, created_at: string, updated_at: string) => ({ kind: "report" as const, name, agent_updated_at, created_at, updated_at });
    const list = [
      R("사람이 방금 고침", "2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z", "2026-09-30T00:00:00Z"),
      R("에이전트가 최근", "2026-09-20T00:00:00Z", "2026-08-01T00:00:00Z", "2026-09-20T00:00:00Z"),
      R("에이전트 없음", null, "2026-09-10T00:00:00Z", "2026-09-29T00:00:00Z"),
      { kind: "folder" as const, name: "폴더", agent_updated_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-30T00:00:00Z" },
    ];
    expect(sortEntries(list, "date").map((e) => e.name)).toEqual(["폴더", "에이전트가 최근", "에이전트 없음", "사람이 방금 고침"]);
    // 정렬 값과 열에 보이는 값이 같다
    const shown = sortEntries(list, "date").filter((e) => e.kind === "report").map((e) => Date.parse(freshAt(e)!));
    expect([...shown].sort((x, y) => y - x)).toEqual(shown);
  });
});

describe("사진 출처 한 줄", () => {
  const sources = [{ title: "PGlite 문서", url: "https://www.pglite.dev/docs/" }, { title: "나쁜 주소", url: "javascript:alert(1)" }];
  it("ref → credit → local_path 순으로 하나", () => {
    expect(imageCredit({ ref: 1, credit: "c", local_path: "C:/a.png" }, sources)).toEqual({
      kind: "ref",
      n: 1,
      title: "PGlite 문서",
      domain: "pglite.dev",
      url: "https://www.pglite.dev/docs/",
    });
    expect(imageCredit({ ref: 2 }, sources)).toMatchObject({ kind: "ref", url: null });
    expect(imageCredit({ ref: 9, credit: "직접 캡처" }, sources)).toEqual({ kind: "credit", text: "직접 캡처" });
    expect(imageCredit({ local_path: "C:/Users/PC/a.png" }, undefined)).toEqual({ kind: "local", path: "C:/Users/PC/a.png" });
    // 공유 페이지: local_path 가 빠져 오면 한 줄 없음
    expect(imageCredit({}, sources)).toBeNull();
  });
});
