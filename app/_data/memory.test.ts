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
    expect(await code(d.editText(ROOT_REPORT, 2, [0, "v"], "   "))).toBe("EZ_EMPTY");
    expect(await code(d.editText(ROOT_REPORT, 2, [0, "v"], "두\n줄"))).toBe("EZ_VALUE");
    expect(await code(d.editText(ROOT_REPORT, 2, [3, "items", 0], "가".repeat(601)))).toBe("EZ_VALUE");
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
