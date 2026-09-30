import { describe, expect, it } from "vitest";
import type { Folder } from "../_data/types";
import {
  canDrop,
  collapseTrail,
  folderTrail,
  formatDay,
  formatToday,
  gridMove,
  httpUrl,
  isInside,
  isUnread,
  moveTargets,
  safeNext,
  sortEntries,
  textAt,
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

describe("그 밖", () => {
  it("날짜", () => {
    const now = new Date(2026, 8, 30, 12);
    expect(formatDay(new Date(2026, 8, 27, 9).toISOString(), now)).toBe("9월 27일");
    expect(formatDay(new Date(2025, 0, 2, 9).toISOString(), now)).toBe("2025년 1월 2일");
    expect(formatDay(null, now)).toBe("");
    expect(formatToday(now)).toBe("9월 30일 수요일");
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
