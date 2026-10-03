import { describe, expect, it } from "vitest";
import { sampleBlocks, sampleSrc } from "../../lib/fixtures";
import type { NoteRow, ViewRow } from "../_data/types";
import {
  ANCHOR_CHARS,
  anchorOf,
  anchorsOf,
  findBlock,
  hasNew,
  isCurrentVisit,
  lostLabel,
  markSeen,
  newSince,
  noteCounts,
  noteLabel,
  noteWaitMs,
  placeNotes,
  seenAt,
  SIDE,
  SIDE_CARD,
  sidePlace,
  sortNotes,
  versionLabel,
} from "./notes";

const NOW = new Date("2026-10-03T12:00:00+09:00");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
const note = (id: string, extra: Partial<NoteRow> = {}): NoteRow => ({
  id,
  guest_no: 1,
  label: "게스트 1",
  by_owner: false,
  body: `글 ${id}`,
  version: 1,
  block: null,
  anchor: null,
  created_at: ago(60),
  updated_at: ago(60),
  ...extra,
});
const view = (n: number, firstSec: number): ViewRow => ({
  id: `v${n}`,
  device: `device-${String(n).padStart(15, "0")}`,
  guest_no: n,
  name: null,
  first_at: ago(firstSec),
  last_at: ago(firstSec),
  hits: 1,
  seconds: 0,
  ua: null,
});

describe("anchor", () => {
  it("소제목이 있으면 소제목, 없으면 첫 글의 앞 60자. 강조 표시 · 겹친 공백은 뺀다", () => {
    expect(anchorsOf(sampleBlocks())).toEqual(["PGlite 로 DB 시험을 돌린다", "배경", "제목 없는 문단.", "후보", "비교", "근거", "출처"]);
    expect(anchorOf({ type: "text", body: "  ==강조==  된\n\n  글  " })).toBe("강조 된 글");
    const long = "가".repeat(100);
    expect(anchorOf({ type: "text", body: long })).toBe("가".repeat(ANCHOR_CHARS));
    expect(anchorOf({ type: "list", h: "", items: ["", "둘째"] })).toBe("둘째");
    expect(anchorOf({ type: "table", h: "", cols: ["도구", "속도"], rows: [["a", "b"]] })).toBe("도구 · 속도");
    expect(anchorOf({ type: "image", src: sampleSrc(), w: 10, h: 10, alt: "대체 글", place: "full", size: "1/2" })).toBe("대체 글");
    expect(anchorOf({ type: "image", src: sampleSrc(), w: 10, h: 10, alt: "대체 글", caption: "설명", place: "full", size: "1/2" })).toBe("설명");
    // 사진의 h 는 높이 — 소제목이 아니다
    expect(anchorOf({ type: "image", src: sampleSrc(), w: 10, h: 300, alt: "a", place: "full", size: "1/2" })).toBe("a");
  });

  it("모르는 블록은 h 가 있으면 그것, 아니면 null. 다 비운 블록도 null", () => {
    expect(anchorOf({ type: "timeline", h: "다음 버전 블록" })).toBe("다음 버전 블록");
    expect(anchorOf({ type: "timeline" })).toBeNull();
    expect(anchorOf(null)).toBeNull();
    expect(anchorOf({ type: "text", body: "" })).toBeNull();
    expect(anchorOf({ type: "list", h: "", items: ["", ""] })).toBeNull();
  });
});

describe("블록 다시 찾기", () => {
  const anchors = ["판정", "배경", "후보", "비교"];
  it("같은 버전이면 그 번호 그대로 (범위 밖이면 못 찾음)", () => {
    expect(findBlock(anchors, { block: 2, anchor: "엉뚱", version: 3 }, 3)).toBe(2);
    expect(findBlock(anchors, { block: 9, anchor: "배경", version: 3 }, 3)).toBeNull();
    expect(findBlock(anchors, { block: null, anchor: null, version: 3 }, 3)).toBeNull();
  });

  it("버전이 다르면 anchor 일치(원래 자리 먼저) → 같은 번호 → 못 찾음", () => {
    // 앞에 블록 하나가 끼어 배경이 1 → 2 로 밀렸다
    expect(findBlock(["판정", "새 글", "배경", "후보"], { block: 1, anchor: "배경", version: 1 }, 2)).toBe(2);
    // 같은 anchor 가 둘이면 원래 자리를 먼저
    expect(findBlock(["배경", "x", "배경"], { block: 2, anchor: "배경", version: 1 }, 2)).toBe(2);
    expect(findBlock(["배경", "x", "배경"], { block: 1, anchor: "배경", version: 1 }, 2)).toBe(0);
    // anchor 를 못 찾으면 같은 번호
    expect(findBlock(anchors, { block: 1, anchor: "없어진 소제목", version: 1 }, 2)).toBe(1);
    expect(findBlock(anchors, { block: 1, anchor: null, version: 1 }, 2)).toBe(1);
    // 같은 번호도 범위 밖이면 못 찾음
    expect(findBlock(anchors, { block: 7, anchor: "없어진 소제목", version: 1 }, 2)).toBeNull();
    expect(findBlock(anchors, { block: 7, anchor: "비교", version: 1 }, 2)).toBe(3);
  });
});

describe("라벨", () => {
  it("버전 라벨은 다를 때만 v12", () => {
    expect(versionLabel(12, 13)).toBe("v12");
    expect(versionLabel(13, 13)).toBe("");
  });

  it("쓴 사람: 이름 · 게스트 n · 주인(화면이 정한 말) · 기기 줄이 지워진 글은 게스트", () => {
    expect(noteLabel({ by_owner: false, label: "민서" }, "주인")).toBe("민서");
    expect(noteLabel({ by_owner: false, label: "게스트 3" }, "주인")).toBe("게스트 3");
    expect(noteLabel({ by_owner: true, label: null }, "주인")).toBe("주인");
    expect(noteLabel({ by_owner: true, label: null }, "나")).toBe("나");
    expect(noteLabel({ by_owner: false, label: null }, "주인")).toBe("게스트");
  });

  it("못 찾은 댓글: 원래 n번째 블록 (1부터)", () => {
    expect(lostLabel({ block: 2 })).toBe("원래 3번째 블록");
    expect(lostLabel({ block: null })).toBe("");
  });
});

describe("글 나누기", () => {
  it("방명록 · 블록별 댓글(다시 찾은 자리) · 못 찾은 댓글. 오래된 것부터", () => {
    const anchors = ["판정", "새 글", "배경", "후보"];
    const notes = [
      note("c", { created_at: ago(10), block: 1, anchor: "배경", version: 1 }), // 밀려서 2
      note("a", { created_at: ago(30) }),
      note("d", { created_at: ago(5), block: 3, anchor: "후보", version: 2 }),
      note("b", { created_at: ago(20), block: 8, anchor: "출처", version: 1 }), // 못 찾음
      note("e", { created_at: ago(5), block: 3, anchor: "후보", version: 2, by_owner: true, guest_no: null, label: null }),
    ];
    expect(sortNotes(notes).map((n) => n.id)).toEqual(["a", "b", "c", "d", "e"]);
    const p = placeNotes(notes, anchors, 2);
    expect(p.guestbook.map((n) => n.id)).toEqual(["a"]);
    expect([...p.byBlock].map(([i, l]) => [i, l.map((n) => n.id)])).toEqual([
      [2, ["c"]],
      [3, ["d", "e"]],
    ]);
    expect(p.lost.map((n) => n.id)).toEqual(["b"]);
    expect([...noteCounts(p)]).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });
});

describe("새 것 · 본 때", () => {
  it("마지막으로 창을 연 때 이후의 처음 온 사람 · 방명록 · 댓글. 주인 글은 안 센다. 한 번도 안 열었으면 전부", () => {
    const views = [view(1, 3600), view(2, 30)];
    const notes = [
      note("a", { created_at: ago(3000) }),
      note("b", { created_at: ago(20) }),
      note("c", { created_at: ago(10), block: 1 }),
      note("d", { created_at: ago(5), block: 1, by_owner: true }),
    ];
    expect(newSince(views, notes, ago(60))).toEqual({ viewers: 1, guestbook: 1, comments: 1 });
    expect(newSince(views, notes, ago(1))).toEqual({ viewers: 0, guestbook: 0, comments: 0 });
    expect(newSince(views, notes, null)).toEqual({ viewers: 2, guestbook: 2, comments: 1 });
    expect(hasNew({ viewers: 0, guestbook: 0, comments: 0 })).toBe(false);
    expect(hasNew({ viewers: 0, guestbook: 0, comments: 1 })).toBe(true);
  });

  it("본 때는 기기에 보고서마다 기억한다. 깨진 값 · 없는 저장소는 null", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(seenAt(store, "r1")).toBeNull();
    markSeen(store, "r1", NOW);
    expect(seenAt(store, "r1")).toBe(NOW.toISOString());
    expect(seenAt(store, "r2")).toBeNull();
    mem.set("ezwork.seen:r2", "깨짐");
    expect(seenAt(store, "r2")).toBeNull();
    expect(seenAt(null, "r1")).toBeNull();
    markSeen(null, "r1", NOW);
    const bad = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(seenAt(bad, "r1")).toBeNull();
    markSeen(bad, "r1", NOW);
  });
});

describe("방문 · 10초", () => {
  it("마지막 방문이 30분 안이면 같은 방문", () => {
    expect(isCurrentVisit(ago(60 * 29), NOW)).toBe(true);
    expect(isCurrentVisit(ago(60 * 30), NOW)).toBe(true);
    expect(isCurrentVisit(ago(60 * 30 + 1), NOW)).toBe(false);
    expect(isCurrentVisit("깨짐", NOW)).toBe(false);
  });

  it("다음 글까지 남은 시간", () => {
    expect(noteWaitMs(null, 1000)).toBe(0);
    expect(noteWaitMs(1000, 4000)).toBe(7000);
    expect(noteWaitMs(1000, 11000)).toBe(0);
    expect(noteWaitMs(1000, 20000)).toBe(0);
  });
});

describe("블록 옆 패널 자리 (설계서 7-6장)", () => {
  it("종이가 760 보다 좁으면 옆 패널 없음 (블록 아래)", () => {
    expect(sidePlace({ body: 900, left: 70, page: 759, top: 100 })).toBeNull();
    // 760 이어도 옆에 패널 자리(340 + 가장자리)가 안 나오면 블록 아래
    expect(sidePlace({ body: 900, left: 70, page: 760, top: 100 })).toBeNull();
    expect(sidePlace({ body: 1200, left: 20, page: 760, top: 100 })).not.toBeNull();
  });

  it("자리가 넉넉하면 종이를 170(패널 칸의 절반) 밀고 패널은 종이 오른쪽 16 옆 — 종이 + 패널이 가운데", () => {
    // 공개 페이지 1440: doc-body 1440, 종이 1032 가 왼쪽 204 에
    const p = sidePlace({ body: 1440, left: 204, page: 1032, top: 412.4 })!;
    expect(p).toEqual({ shift: -170, x: 1048, y: 412 });
    expect(SIDE.slot / 2).toBe(170);
    const pageLeft = 204 + p.shift;
    const panelRight = pageLeft + p.x + SIDE_CARD;
    expect(pageLeft).toBe(1440 - panelRight); // 양쪽 여백이 같다
  });

  it("왼쪽 자리가 모자라면 덜 민다(가장자리 16 까지). 오른쪽도 모자라면 종이를 좁혀 나란히 — 패널이 종이를 덮지 않는다", () => {
    // 주인 화면 1440(사이드바 220): doc-body 1219, 종이 1032 가 왼쪽 93.6 에
    const p = sidePlace({ body: 1219, left: 93.6, page: 1032, top: 0 })!;
    expect(p.shift).toBe(-77); // 종이가 가장자리 16 에 붙는다
    expect(p.width).toBe(Math.floor(1219 - 16 - 340 - (93.6 - 77))); // 846 — 가장자리 · 종이 · 틈 · 패널 · 가장자리
    expect(p.x).toBe(p.width! + SIDE.gap);
    expect(93.6 + p.shift + p.x + SIDE_CARD).toBeLessThanOrEqual(1219 - SIDE.edge);
    // 좁혀도 760 이 안 되면 블록 아래 방식
    expect(sidePlace({ body: 1100, left: 20, page: 1060, top: 0 })).toBeNull();
    // 이미 가장자리에 붙어 있으면 밀지 않는다 (-0 이 아니라 0)
    expect(sidePlace({ body: 1300, left: 10, page: 900, top: 0 })!.shift).toBe(0);
  });

  it("딱 맞는 폭: 종이 + 패널 칸 + 양쪽 16", () => {
    expect(sidePlace({ body: 1032 + 340 + 32, left: 186, page: 1032, top: 0 })).toEqual({ shift: -170, x: 1048, y: 0 });
  });

  it("블록이 종이 위로 올라가 있어도(음수) 패널은 종이 안에서 시작", () => {
    expect(sidePlace({ body: 1440, left: 204, page: 1032, top: -30 })!.y).toBe(0);
  });
});
