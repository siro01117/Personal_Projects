// 방명록 · 댓글 조각 (설계서 7-5장): 글 목록(라벨 · 상대 시간 · 다른 버전만 v12 · 글은 텍스트로만) · 적는 칸 · 블록 옆 댓글 수 · 세 칸 창. 모양은 globals.css 를 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sampleBlocks } from "../../lib/fixtures";
import type { NoteRow } from "../_data/types";
import { Blocks } from "./Blocks";
import { NoteInput, NoteList, Thread } from "./Notes";
import { ViewersButton, ViewsPop } from "./Viewers";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const NOW = new Date("2026-10-03T12:00:00+09:00");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const note = (id: string, extra: Partial<NoteRow> = {}): NoteRow => ({
  id,
  guest_no: 1,
  label: "게스트 1",
  by_owner: false,
  body: `글 ${id}`,
  version: 3,
  block: null,
  anchor: null,
  created_at: ago(60 * 5),
  updated_at: ago(60 * 5),
  ...extra,
});

describe("글 목록", () => {
  it("라벨 · 상대 시간 · 글. 지금과 다른 버전만 v12. 주인 글은 화면이 정한 이름. 글은 텍스트로만 (HTML 해석 없음)", () => {
    const notes = [
      note("a", { label: "민서", body: "잘 읽었습니다", version: 3 }),
      note("b", { label: null, guest_no: null, by_owner: true, body: "고맙습니다 <b>굵게</b>", version: 2, created_at: ago(3600 * 20) }),
      note("c", { label: null, guest_no: null, body: "기기 줄이 지워진 글" }),
    ];
    const html = renderToStaticMarkup(<NoteList notes={notes} current={3} ownerLabel="주인" now={NOW} />);
    const items = [...html.matchAll(/<li class="([^"]*)">(.*?)<\/li>/g)].map((m) => [m[1], text(m[2]!)]);
    expect(items).toEqual([
      ["note", "민서 5분 전 잘 읽었습니다"],
      ["note owner", "주인 어제 v2 고맙습니다 &lt;b&gt;굵게&lt;/b&gt;"],
      ["note", "게스트 5분 전 기기 줄이 지워진 글"],
    ]);
    expect(html).toContain("&lt;b&gt;굵게&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html.match(/class="ver num"/g)).toHaveLength(1);
    // 고치기 · 지우기는 권한을 준 글에만
    expect(html).not.toContain("고치기");
    expect(html).not.toContain("지우기");
  });

  it("자기 글에만 고치기 · 지우기, 주인은 아무 글이나 지우기. 비어 있으면 아무것도 안 그린다", () => {
    const notes = [note("a", { guest_no: 1 }), note("b", { guest_no: 2, label: "게스트 2" })];
    const mine = (n: NoteRow) => n.guest_no === 1;
    const html = renderToStaticMarkup(
      <NoteList notes={notes} current={3} ownerLabel="주인" now={NOW} canEdit={mine} canDelete={mine} onEdit={async () => {}} onDelete={async () => {}} />,
    );
    expect(html.match(/고치기/g)).toHaveLength(1);
    expect(html.match(/지우기/g)).toHaveLength(1);
    const owner = renderToStaticMarkup(<NoteList notes={notes} current={3} ownerLabel="나" now={NOW} canDelete={() => true} onDelete={async () => {}} />);
    expect(owner.match(/지우기/g)).toHaveLength(2);
    expect(owner).not.toContain("고치기");
    expect(renderToStaticMarkup(<NoteList notes={[]} current={3} ownerLabel="나" now={NOW} />)).toBe("");
  });

  it("자리 글자(place): 창의 댓글 칸에 블록 이름 · 원래 n번째 블록", () => {
    const notes = [note("a", { block: 1, anchor: "배경" }), note("b", { block: 7, anchor: "없어진 절", version: 1 })];
    const html = renderToStaticMarkup(
      <NoteList notes={notes} current={3} ownerLabel="나" now={NOW} place={(n) => <span className="plc">{n.id === "a" ? "배경" : "원래 8번째 블록"}</span>} small />,
    );
    expect(text(html)).toBe("배경 게스트 1 5분 전 글 a 원래 8번째 블록 게스트 1 5분 전 v1 글 b");
    expect(html).toContain('class="notes sm"');
  });
});

describe("적는 칸", () => {
  it("새 글: 비어 있으면 남기기가 꺼져 있다. 설명 문구 없이 자리표시만. 옆에 이름 적기를 둘 수 있다", () => {
    const html = renderToStaticMarkup(<NoteInput placeholder="남길 말" ariaLabel="방명록" onSave={async () => {}} aside={<button className="lnk">이름 적기</button>} />);
    expect(html).toContain('placeholder="남길 말"');
    expect(html).toContain('aria-label="방명록"');
    expect(html).toMatch(/<button type="submit" class="btn" disabled="">남기기<\/button>/);
    expect(text(html)).toBe("남기기 이름 적기");
  });

  it("고치기: 원래 글로 시작, 저장 · 취소", () => {
    const html = renderToStaticMarkup(<NoteInput initial="원래 글" placeholder="" ariaLabel="글 고치기" onSave={async () => {}} onCancel={() => {}} />);
    expect(html).toContain(">원래 글</textarea>");
    expect(text(html)).toBe("원래 글 저장 취소");
  });

  it("댓글 줄: 목록 + 적는 칸. 적기가 없으면(주인 본인 · 꺼진 링크) 칸도 없다", () => {
    const withWrite = renderToStaticMarkup(<Thread notes={[note("a")]} current={3} ownerLabel="주인" now={NOW} onWrite={async () => {}} />);
    expect(withWrite).toContain('class="cmt"');
    expect(withWrite).toContain('placeholder="댓글"');
    const readOnly = renderToStaticMarkup(<Thread notes={[note("a")]} current={3} ownerLabel="주인" now={NOW} />);
    expect(readOnly).not.toContain("<textarea");
  });
});

describe("블록 옆 댓글 수", () => {
  const blocks = sampleBlocks();
  const ctx = (open: number | null) => ({
    counts: new Map([
      [1, 2],
      [3, 1],
    ]),
    open,
    onToggle: () => {},
    thread: (i: number) => <div className="cmt">댓글 줄 {i}</div>,
  });

  it("댓글이 있는 블록에 수, 없는 블록은 zero(올렸을 때만 +). 펼친 블록 아래에 댓글 줄", () => {
    const html = renderToStaticMarkup(<Blocks blocks={blocks} notes={ctx(1)} />);
    const badges = [...html.matchAll(/<button type="button" class="(cmt-n[^"]*)" aria-label="([^"]*)" aria-expanded="(\w+)">([^<]*)<\/button>/g)].map((m) => [m[1], m[2], m[3], m[4]]);
    expect(badges).toHaveLength(blocks.length);
    expect(badges[1]).toEqual(["cmt-n num", "댓글 2개", "true", "2"]);
    expect(badges[3]).toEqual(["cmt-n num", "댓글 1개", "false", "1"]);
    expect(badges[0]).toEqual(["cmt-n num zero", "댓글 적기", "false", "+"]);
    expect(html.match(/댓글 줄 \d/g)).toEqual(["댓글 줄 1"]);
    expect(html.match(/data-cmt=""/g)).toHaveLength(blocks.length);
  });

  it("고치기 모드에서는 댓글 표시가 없다 (손잡이 · 도구 줄과 겹치지 않게)", () => {
    const editing = { raw: blocks, editing: true, commit: async () => {} };
    const html = renderToStaticMarkup(<Blocks blocks={blocks} ctx={editing} notes={ctx(1)} />);
    expect(html).not.toContain("cmt-n");
    expect(html).not.toContain("댓글 줄");
    expect(html).not.toContain("data-cmt");
  });

  it("모양: 데스크톱은 오른쪽 여백(absolute), 폰 · 2칸 행은 블록 아래(static). 댓글 줄은 가는 왼쬽 선. 점은 키위", () => {
    expect(/\.cmt-n\{([^}]*)\}/.exec(css)![1]).toContain("position:absolute");
    expect(css).toContain(".row.pair .cmt-n,.row.solo .cmt-n{position:static");
    expect(css).toMatch(/\.cmt-n\{position:static;display:inline-grid;margin-top:10px\}/);
    expect(/\.cmt\{([^}]*)\}/.exec(css)![1]).toContain("border-left:2px solid var(--border)");
    expect(/\.ndot\{([^}]*)\}/.exec(css)![1]).toContain("background:var(--point)");
    expect(/\.note \.nb\{([^}]*)\}/.exec(css)![1]).toContain("white-space:pre-wrap");
  });
});

describe("주인의 세 칸 창", () => {
  it("단추에 새 것이 있으면 키위 점", () => {
    expect(renderToStaticMarkup(<ViewersButton live={[]} open={false} onClick={() => {}} dot />)).toContain('class="ndot"');
    expect(renderToStaticMarkup(<ViewersButton live={[]} open={false} onClick={() => {}} />)).not.toContain("ndot");
  });

  it("tab 을 주면 세 칸 — 고른 칸의 내용만, 새 것이 있는 칸에 점", () => {
    const base = { live: [], rows: [], toc: [] as [number, string][], now: NOW, expanded: false, onMore: () => {}, onTab: () => {} };
    const dots = { viewers: 0, guestbook: 2, comments: 0 };
    const g = renderToStaticMarkup(<ViewsPop {...base} tab="guestbook" dots={dots} guestbook={<p>방명록 내용</p>} comments={<p>댓글 내용</p>} />);
    expect(g).toContain('role="tablist"');
    expect(text(g)).toBe("보는 사람 방명록 댓글 방명록 내용");
    expect([...g.matchAll(/<button type="button" role="tab" aria-selected="(\w+)"/g)].map((m) => m[1])).toEqual(["false", "true", "false"]);
    expect(g.match(/class="ndot"/g)).toHaveLength(1);
    const c = renderToStaticMarkup(<ViewsPop {...base} tab="comments" dots={dots} guestbook={<p>방명록 내용</p>} comments={<p>댓글 내용</p>} />);
    expect(text(c)).toBe("보는 사람 방명록 댓글 댓글 내용");
    const v = renderToStaticMarkup(<ViewsPop {...base} tab="viewers" dots={dots} guestbook={<p>방명록 내용</p>} comments={<p>댓글 내용</p>} />);
    expect(text(v)).toBe("보는 사람 방명록 댓글 아직 아무도 안 봤습니다");
    // tab 이 없으면 전처럼 보는 사람만
    expect(renderToStaticMarkup(<ViewsPop {...base} />)).not.toContain("tablist");
  });

  it("본 사람을 누르면(onPick) 방문 목록 — 날짜 · 읽은 시간 · 지금과 다른 버전만 v12", () => {
    const rows = [
      { id: "v1", device: "device-000000000000001", guest_no: 1, name: "민서", first_at: ago(3600), last_at: ago(20), hits: 2, seconds: 600, ua: null },
      { id: "v2", device: "device-000000000000002", guest_no: 2, name: null, first_at: ago(3600), last_at: ago(30), hits: 1, seconds: 10, ua: null },
    ];
    const visits = [
      { id: "x1", version: 3, started_at: ago(200), last_at: ago(20), seconds: 180 },
      { id: "x2", version: 1, started_at: ago(3600 * 24 * 3), last_at: ago(3600 * 24 * 3 - 420), seconds: 420 },
    ];
    const base = { live: [], rows, toc: [] as [number, string][], now: NOW, expanded: false, onMore: () => {}, version: 3, onPick: () => {} };
    const html = renderToStaticMarkup(<ViewsPop {...base} picked="v1" visits={visits} />);
    expect(html.match(/class="vrow"/g)).toHaveLength(2);
    expect(html).toContain('aria-expanded="true"');
    const list = /<ul class="vp-visits">(.*?)<\/ul>/.exec(html)![1]!;
    expect([...list.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1]!))).toEqual(["10월 3일 11:56 3분", "9월 30일 12:00 7분 v1"]);
    // 아직 읽는 중이면 목록 없음, 안 고른 사람도
    expect(renderToStaticMarkup(<ViewsPop {...base} picked="v1" visits={null} />)).not.toContain("vp-visits");
    expect(renderToStaticMarkup(<ViewsPop {...base} picked={null} visits={visits} />)).not.toContain("vp-visits");
  });
});
