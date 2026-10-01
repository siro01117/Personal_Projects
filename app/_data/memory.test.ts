// 메모리 구현(확인 모드)이 DB 와 같은 규칙·같은 오류 모양을 내는지. 진짜 규칙 시험은 db/*.test.ts (PGlite).

import { describe, expect, it } from "vitest";
import { sampleBlocks } from "../../lib/fixtures";
import { toKorean } from "../../lib/errors";
import { MemoryDrawer, type Seed } from "./memory";

const ROOT_REPORT = "r0000000-0000-4000-8000-000000000001";

let clock = Date.parse("2026-09-30T12:00:00Z");
const now = () => new Date((clock += 1000));

function drawer(extra: Seed[] = []) {
  return new MemoryDrawer([
    { id: "A", kind: "folder", name: "가" },
    { id: "B", kind: "folder", name: "나", parent_id: "A" },
    { id: ROOT_REPORT, kind: "report", name: "보고서", report_kind: "method", blocks: sampleBlocks(), agent: "Claude Code", agent_updated_at: "2026-09-01T10:00:00Z" },
    ...extra,
  ], { now });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return toKorean(e).code;
  }
  throw new Error("실패해야 하는데 성공했습니다");
}

describe("MemoryDrawer — 이름", () => {
  it("같은 폴더 같은 이름(대소문자 무시)은 거절", async () => {
    const d = drawer();
    await d.createFolder(null, "Apple");
    expect(await code(d.createFolder(null, "apple"))).toBe("NAME_TAKEN");
    await d.rename("B", "가"); // B 는 A 안 — 맨 위 '가' 와 안 겹친다
    expect(await code(d.rename(ROOT_REPORT, "가"))).toBe("NAME_TAKEN");
  });

  it("이름 규칙 (lib validateName) 은 BAD_NAME", async () => {
    const d = drawer();
    expect(await code(d.createFolder(null, "a/b"))).toBe("BAD_NAME");
    expect(await code(d.createFolder(null, ".."))).toBe("BAD_NAME");
    expect(await code(d.createFolder(null, " 앞뒤 공백 "))).toBe("BAD_NAME");
  });

  it("옮기면 겹치는 이름에 (2) 를 붙이고 알려준다", async () => {
    const d = drawer([{ id: "X", kind: "folder", name: "나" }]);
    const r = await d.move("X", "A");
    expect(r).toEqual({ name: "나 (2)", renamed: true });
    expect((await d.list("A")).map((e) => e.name).sort()).toEqual(["나", "나 (2)"]);
  });
});

describe("MemoryDrawer — 순환·깊이·부모", () => {
  it("자기 자신·자기 안으로 옮기기는 EZ_CYCLE", async () => {
    const d = drawer();
    expect(await code(d.move("A", "A"))).toBe("EZ_CYCLE");
    expect(await code(d.move("A", "B"))).toBe("EZ_CYCLE");
  });

  it("폴더는 8단까지", async () => {
    const d = drawer();
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) parent = (await d.createFolder(parent, `f${i}`)).id;
    expect(await code(d.createFolder(parent, "9단"))).toBe("EZ_DEPTH");
    // 2단짜리(A-B)를 7단 아래로 옮기면 9단
    const deep7 = (await d.folders()).find((f) => f.name === "f6")!.id;
    expect(await code(d.move("A", deep7))).toBe("EZ_DEPTH");
    // 보고서는 폴더 깊이에 안 친다
    await d.move(ROOT_REPORT, parent);
  });

  it("지운 폴더·보고서 안에는 못 넣는다", async () => {
    const d = drawer();
    await d.remove("B");
    expect(await code(d.createFolder("B", "x"))).toBe("EZ_PARENT");
    expect(await code(d.createFolder(ROOT_REPORT, "x"))).toBe("EZ_PARENT");
  });
});

describe("MemoryDrawer — 삭제·복원", () => {
  it("폴더를 지우면 안의 것도 같은 묶음, 되돌리면 그대로", async () => {
    const d = drawer();
    const batch = await d.remove("A");
    expect(await d.list(null)).toHaveLength(1);
    expect(await d.folders()).toHaveLength(0);
    const rows = await d.restore(batch);
    expect(rows.map((r) => r.id)).toEqual(["A", "B"]); // 얕은 것부터
    expect(rows.every((r) => !r.to_root && !r.renamed)).toBe(true);
    expect((await d.list("A")).map((e) => e.id)).toEqual(["B"]);
  });

  it("복원할 자리의 폴더가 그 사이 지워졌으면 맨 위로, 이름이 겹치면 (2)", async () => {
    const d = drawer();
    const b1 = await d.remove("B");
    await d.remove("A");
    await d.createFolder(null, "나");
    const [row] = await d.restore(b1);
    expect(row).toEqual({ id: "B", name: "나 (2)", to_root: true, renamed: true });
  });

  it("없는 묶음은 EZ_NOT_FOUND", async () => {
    expect(await code(drawer().restore("nope"))).toBe("EZ_NOT_FOUND");
  });
});

describe("MemoryDrawer — 복사 (ez_copy 흉내)", () => {
  it("같은 폴더면 - 복사본 → (2), 다른 폴더에 안 겹치면 원래 이름. 폴더는 통째로", async () => {
    const d = drawer([{ id: "R", kind: "report", name: "안쪽", parent_id: "B", blocks: sampleBlocks(), report_kind: "data" }]);
    expect((await d.copy(["A"], null)).map((c) => c.name)).toEqual(["가 - 복사본"]);
    expect((await d.copy(["A"], null)).map((c) => c.name)).toEqual(["가 - 복사본 (2)"]);
    const [c] = await d.copy([ROOT_REPORT], "A");
    expect(c).toMatchObject({ src: ROOT_REPORT, name: "보고서" });
    const copyA = (await d.list(null)).find((e) => e.name === "가 - 복사본")!;
    const inner = await d.list(copyA.id);
    expect(inner.map((e) => e.name)).toEqual(["나"]);
    expect((await d.list(inner[0]!.id)).map((e) => e.name)).toEqual(["안쪽"]);
    // 원본은 그대로
    expect((await d.list("B")).map((e) => e.id)).toEqual(["R"]);
  });

  it("복사본: 공유 끔 · 안 읽음 아님 · version 1 · agent 그대로", async () => {
    const d = drawer();
    await d.share(ROOT_REPORT);
    await d.editText(ROOT_REPORT, 1, ["title"], "고친 보고서");
    const [c] = await d.copy([ROOT_REPORT], null);
    const r = (await d.report(c!.id))!;
    expect(r).toMatchObject({ share_token: null, agent_updated_at: null, version: 1, agent: "Claude Code", name: "고친 보고서 - 복사본", shared: false });
    expect(r.read_at).not.toBeNull();
    expect((await d.list(null)).find((e) => e.id === ROOT_REPORT)!.shared).toBe(true);
  });

  it("순환 · 깊이 초과 · 없는 것 — 거절하고 아무것도 안 생긴다", async () => {
    const d = drawer();
    const count = () => [...d.rows.values()].filter((r) => r.deleted_at === null).length;
    const before = count();
    expect(await code(d.copy(["A"], "B"))).toBe("EZ_CYCLE");
    expect(await code(d.copy(["A"], "A"))).toBe("EZ_CYCLE");
    let parent: string | null = null;
    for (let i = 0; i < 7; i++) parent = (await d.createFolder(parent, `f${i}`)).id;
    const mid = count();
    // 보고서는 먼저 복사되지만 A-B(2단)가 9단이 되어 전부 취소
    expect(await code(d.copy([ROOT_REPORT, "A"], parent))).toBe("EZ_DEPTH");
    expect(count()).toBe(mid);
    expect(await code(d.copy(["없음"], null))).toBe("EZ_NOT_FOUND");
    await d.remove(ROOT_REPORT);
    expect(await code(d.copy([ROOT_REPORT], null))).toBe("EZ_NOT_FOUND");
    expect(before).toBe(3);
  });
});

describe("MemoryDrawer — 여러 개 지우기 · 휴지통 · 폴더 안 읽음 · 찾기", () => {
  it("여러 개를 한 묶음으로, 자손은 한 번만. 한 번에 복원", async () => {
    const d = drawer();
    const batch = await d.removeMany(["A", "B", ROOT_REPORT]);
    expect(await d.list(null)).toEqual([]);
    const trash = await d.trash();
    expect(trash.map((t) => [t.batch, t.name, t.count])).toEqual([
      [batch, "가", 3],
      [batch, "보고서", 3],
    ]);
    const rows = await d.restore(batch);
    expect(rows.map((r) => r.id).sort()).toEqual(["A", "B", ROOT_REPORT].sort());
    expect(await d.trash()).toEqual([]);
    expect(await code(d.removeMany(["A", "없음"]))).toBe("EZ_NOT_FOUND");
    expect((await d.list(null)).length).toBe(2);
  });

  it("휴지통은 최근 지운 묶음 먼저", async () => {
    const d = drawer();
    const b1 = await d.remove("B");
    const b2 = await d.remove(ROOT_REPORT);
    expect((await d.trash()).map((t) => t.batch)).toEqual([b2, b1]);
  });

  it("안 읽은 보고서가 깊이 있으면 조상 폴더 전부, 읽으면 사라짐, 지운 건 제외", async () => {
    const d = drawer([{ id: "R", kind: "report", name: "깊은", parent_id: "B", blocks: [], agent_updated_at: "2026-09-02T00:00:00Z" }]);
    expect((await d.unreadFolders()).sort()).toEqual(["A", "B"]);
    await d.markRead("R");
    expect(await d.unreadFolders()).toEqual([]);
    d.agentTouch("R");
    expect((await d.unreadFolders()).sort()).toEqual(["A", "B"]);
    await d.remove("R");
    expect(await d.unreadFolders()).toEqual([]);
  });

  it("찾기: 이름 먼저, 본문 글자(type·tag·url 빼고), 빈 글자는 EZ_EMPTY", async () => {
    const d = drawer();
    expect((await d.search("pglite")).map((h) => [h.name, h.match])).toEqual([["보고서", "body"]]);
    expect((await d.search("가")).map((h) => [h.name, h.match])).toEqual([
      ["가", "name"],
      ["보고서", "body"],
    ]);
    expect(await d.search("verdict")).toEqual([]);
    expect(await d.search("pglite.dev")).toEqual([]);
    expect(await code(d.search("  "))).toBe("EZ_EMPTY");
  });
});

describe("MemoryDrawer — 글자 고치기", () => {
  it("허용된 칸만, 버전이 맞을 때만, 새 버전을 돌려준다", async () => {
    const d = drawer();
    const r = (await d.report(ROOT_REPORT))!;
    expect(r.version).toBe(1);
    const v2 = await d.editText(ROOT_REPORT, 1, [4, "rows", 1, 0], "  도커  ");
    expect(v2).toBe(2);
    expect(((await d.report(ROOT_REPORT))!.blocks[4] as { rows: string[][] }).rows[1]![0]).toBe("도커");
    expect(await code(d.editText(ROOT_REPORT, 1, [0, "v"], "x"))).toBe("EZ_VERSION");
    expect(await code(d.editText(ROOT_REPORT, 2, [0, "type"], "x"))).toBe("EZ_PATH");
    expect(await code(d.editText(ROOT_REPORT, 2, [6, "items", 0, "url"], "https://x"))).toBe("EZ_PATH");
    expect(await code(d.editText(ROOT_REPORT, 2, [0, "v"], "두\n줄"))).toBe("EZ_VALUE");
    expect(await code(d.editText(ROOT_REPORT, 2, [3, "items", 0], "가".repeat(601)))).toBe("EZ_VALUE");
  });

  it("블록 칸은 비울 수 있고 다시 채울 수 있다 (공백만이면 빈 값)", async () => {
    const d = drawer();
    const at = async () => (await d.report(ROOT_REPORT))!.blocks as any[];
    expect(await d.editText(ROOT_REPORT, 1, [1, "h"], "  \n ")).toBe(2);
    expect((await at())[1].h).toBe("");
    expect(await d.editText(ROOT_REPORT, 2, [4, "rows", 0, 1], "")).toBe(3);
    expect((await at())[4].rows[0][1]).toBe("");
    // 이미 빈 칸에 빈 값 — 바뀐 것이 없어 버전 그대로
    expect(await d.editText(ROOT_REPORT, 3, [1, "h"], "")).toBe(3);
    // 비운 칸은 여전히 고칠 수 있는 칸 (구조는 그대로)
    expect(await d.editText(ROOT_REPORT, 3, [1, "h"], "다시 채움")).toBe(4);
    expect((await at())[1].h).toBe("다시 채움");
    // 키가 없는 선택 칸은 새로 만들 수 없다
    expect(await code(d.editText(ROOT_REPORT, 4, [2, "h"], "x"))).toBe("EZ_PATH");
  });

  it("줄바꿈: 되는 칸은 가운데 줄바꿈을 지키고 다듬는다, 한 줄 칸은 거절", async () => {
    const d = drawer();
    const at = async () => (await d.report(ROOT_REPORT))!.blocks as any[];
    let v = await d.editText(ROOT_REPORT, 1, [3, "items", 0], "  첫 줄  \r\n둘째 줄 \n\n\n\n넷째\n  ");
    expect((await at())[3].items[0]).toBe("첫 줄\n둘째 줄\n\n넷째");
    v = await d.editText(ROOT_REPORT, v, [4, "rows", 0, 0], "칸\n둘");
    v = await d.editText(ROOT_REPORT, v, [5, "items", 0, "text"], "근거\n둘");
    v = await d.editText(ROOT_REPORT, v, [0, "w"], "풀이\n둘");
    for (const p of [[1, "h"], [3, "h"], [0, "v"], [4, "cols", 0], [6, "items", 0, "title"]]) {
      expect(await code(d.editText(ROOT_REPORT, v, p, "두\n줄")), JSON.stringify(p)).toBe("EZ_VALUE");
    }
  });

  it("작성자: 고치고 비운다. 버전은 오르고 agent_updated_at 은 그대로. 폴더는 거절", async () => {
    const d = drawer();
    expect(await d.editText(ROOT_REPORT, 1, ["agent"], "  김조사  ")).toBe(2);
    let r = (await d.report(ROOT_REPORT))!;
    expect(r.agent).toBe("김조사");
    expect(r.agent_updated_at).toBe("2026-09-01T10:00:00Z");
    expect(await code(d.editText(ROOT_REPORT, 2, ["agent"], "가".repeat(101)))).toBe("EZ_VALUE");
    expect(await code(d.editText(ROOT_REPORT, 2, ["agent"], "두\n줄"))).toBe("EZ_VALUE");
    expect(await code(d.editText(ROOT_REPORT, 1, ["agent"], "x"))).toBe("EZ_VERSION");
    expect(await d.editText(ROOT_REPORT, 2, ["agent"], "   ")).toBe(3);
    r = (await d.report(ROOT_REPORT))!;
    expect(r.agent).toBeNull();
    expect(r.agent_updated_at).toBe("2026-09-01T10:00:00Z");
    expect(await code(d.editText("A", 1, ["agent"], "x"))).toBe("EZ_PATH");
  });

  it("제목은 이름 규칙 + 겹침", async () => {
    const d = drawer();
    expect(await d.editText(ROOT_REPORT, 1, ["title"], "새 제목")).toBe(2);
    expect(await code(d.editText(ROOT_REPORT, 2, ["title"], "가"))).toBe("NAME_TAKEN");
    expect(await code(d.editText(ROOT_REPORT, 2, ["title"], "a/b"))).toBe("BAD_NAME");
    expect(await code(d.editText(ROOT_REPORT, 2, ["title"], ""))).toBe("EZ_EMPTY");
  });

  it("읽기·옮기기·공유는 버전을 안 올린다 (DB 와 같음)", async () => {
    const d = drawer();
    await d.markRead(ROOT_REPORT);
    await d.move(ROOT_REPORT, "A");
    await d.share(ROOT_REPORT);
    expect((await d.report(ROOT_REPORT))!.version).toBe(1);
  });
});

describe("MemoryDrawer — 읽음·공유", () => {
  it("열면 안 읽음이 빠진다", async () => {
    const d = drawer();
    expect(await d.unreadCount()).toBe(1);
    await d.markRead(ROOT_REPORT);
    expect(await d.unreadCount()).toBe(0);
    d.agentTouch(ROOT_REPORT);
    expect(await d.unreadCount()).toBe(1);
  });

  it("공유 켜기는 22자 새 열쇠, 끄거나 다시 켜면 옛 열쇠는 무효", async () => {
    const d = drawer();
    const t1 = await d.share(ROOT_REPORT);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await d.shared(t1))!.name).toBe("보고서");
    const t2 = await d.share(ROOT_REPORT);
    expect(t2).not.toBe(t1);
    expect(await d.shared(t1)).toBeNull();
    await d.unshare(ROOT_REPORT);
    expect(await d.shared(t2)).toBeNull();
    expect(await d.shared("짧음")).toBeNull();
  });

  it("지운 보고서의 링크는 없는 링크", async () => {
    const d = drawer();
    const t = await d.share(ROOT_REPORT);
    await d.remove(ROOT_REPORT);
    expect(await d.shared(t)).toBeNull();
    expect(await code(d.share("A"))).toBe("EZ_NOT_FOUND");
  });
});

describe("사진 (확인 모드 흉내)", () => {
  const img = { type: "image", src: `a0000000-0000-4000-8000-000000000001/${"a".repeat(64)}.webp`, w: 10, h: 10, alt: "a", place: "full", local_path: "C:/Users/PC/a.png" };
  const make = () =>
    new MemoryDrawer(
      [{ id: ROOT_REPORT, kind: "report", name: "사진", report_kind: "data", blocks: [img], agent: "Claude Code" }],
      { now, images: { [img.src]: "/demo/a.webp", other: "/demo/b.webp" } },
    );

  it("공유 페이지에는 local_path 가 빠지고, 사진 주소는 공유 켜진 보고서가 쓰는 것만", async () => {
    const d = make();
    expect(await d.imageUrls([img.src, "other", "없음"])).toEqual({ [img.src]: "/demo/a.webp", other: "/demo/b.webp" });
    expect(await d.imageUrls([img.src], true)).toEqual({});
    const t = await d.share(ROOT_REPORT);
    const doc = await d.shared(t);
    expect(doc!.blocks[0]).not.toHaveProperty("local_path");
    expect((await d.report(ROOT_REPORT))!.blocks[0]).toHaveProperty("local_path");
    expect(await d.imageUrls([img.src, "other"], true)).toEqual({ [img.src]: "/demo/a.webp" });
  });

  it("사람은 설명·캡션만 고친다, 목록에 종류·만든 때가 실린다", async () => {
    const d = make();
    expect(await d.editText(ROOT_REPORT, 1, [0, "alt"], "새 설명")).toBe(2);
    expect(await code(d.editText(ROOT_REPORT, 2, [0, "src"], "x"))).toBe("EZ_PATH");
    const [e] = await d.list(null);
    expect(e).toMatchObject({ report_kind: "data", created_at: expect.any(String) });
  });
});

describe("블록 지우기 · 옮기기 (ez_blocks_arrange 흉내)", () => {
  const types = async (d: MemoryDrawer) => ((await d.report(ROOT_REPORT))!.blocks as { type: string }[]).map((b) => b.type);

  it("옮기고 지운다 — 버전이 오르고 agent_updated_at 은 그대로", async () => {
    const d = drawer();
    expect(await d.arrangeBlocks(ROOT_REPORT, 1, [0, 3, 1, 2, 4, 5, 6])).toBe(2);
    expect(await types(d)).toEqual(["verdict", "list", "text", "text", "table", "claims", "sources"]);
    expect(await d.arrangeBlocks(ROOT_REPORT, 2, [0, 1, 4])).toBe(3);
    expect(await types(d)).toEqual(["verdict", "list", "table"]);
    expect((await d.report(ROOT_REPORT))!.agent_updated_at).toBe("2026-09-01T10:00:00Z");
  });

  it("그대로면 버전도 그대로, 출처가 안 남으면 근거의 refs 가 비워진다", async () => {
    const d = drawer();
    expect(await d.arrangeBlocks(ROOT_REPORT, 1, [0, 1, 2, 3, 4, 5, 6])).toBe(1);
    expect(await d.arrangeBlocks(ROOT_REPORT, 1, [5, 0])).toBe(2);
    const claims = (await d.report(ROOT_REPORT))!.blocks[0] as { items: { refs: number[] }[] };
    expect(claims.items.map((c) => c.refs)).toEqual([[], [], []]);
  });

  it("DB 와 같은 오류: EZ_VALUE · EZ_VERSION · EZ_NOT_FOUND", async () => {
    const d = drawer();
    expect(await code(d.arrangeBlocks(ROOT_REPORT, 1, []))).toBe("EZ_VALUE");
    expect(await code(d.arrangeBlocks(ROOT_REPORT, 1, [0, 0]))).toBe("EZ_VALUE");
    expect(await code(d.arrangeBlocks(ROOT_REPORT, 1, [7]))).toBe("EZ_VALUE");
    expect(await code(d.arrangeBlocks(ROOT_REPORT, 9, [1, 0]))).toBe("EZ_VERSION");
    expect(await code(d.arrangeBlocks("A", 1, [0]))).toBe("EZ_NOT_FOUND");
    expect(await code(d.arrangeBlocks("없음", 1, [0]))).toBe("EZ_NOT_FOUND");
    expect((await d.report(ROOT_REPORT))!.version).toBe(1);
    // 지운 뒤 글자 고치기는 새 번호 · 새 버전으로
    const v = await d.arrangeBlocks(ROOT_REPORT, 1, [1, 2]);
    expect(await code(d.editText(ROOT_REPORT, 1, [0, "body"], "낡은 버전"))).toBe("EZ_VERSION");
    expect(await d.editText(ROOT_REPORT, v, [0, "body"], "새 번호")).toBe(v + 1);
    expect(((await d.report(ROOT_REPORT))!.blocks[0] as { body: string }).body).toBe("새 번호");
  });
});
