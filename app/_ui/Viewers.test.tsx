// 읽은 사람의 주인 화면 조각 (설계서 7-4장): 아바타 줄(+n · 없으면 눈) · 작은 창(빈 문구 · 지금 보는 중 · 본 사람 · 더 보기). 모양은 globals.css 를 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewRow } from "../_data/types";
import type { LivePerson } from "../_logic/views";
import { ViewersButton, ViewsPop } from "./Viewers";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const NOW = new Date("2026-10-03T12:00:00+09:00");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
const person = (n: number, label: string, block: number | null = null): LivePerson => ({ device: `device-${String(n).padStart(15, "0")}`, label, block });
const row = (n: number, lastSec: number, name: string | null, seconds = 0, hits = 1): ViewRow => ({
  id: `v${n}`,
  device: `device-${String(n).padStart(15, "0")}`,
  guest_no: n,
  name,
  first_at: ago(lastSec + 60),
  last_at: ago(lastSec),
  hits,
  seconds,
  ua: null,
});
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const TOC: [number, string][] = [
  [0, "판정"],
  [2, "배경"],
];

describe("아바타 줄", () => {
  it("아무도 없으면 눈 아이콘 하나 (글자 없음)", () => {
    const html = renderToStaticMarkup(<ViewersButton live={[]} open={false} onClick={() => {}} />);
    expect(html).toContain('aria-label="읽은 사람"');
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(text(html)).toBe("");
    expect(html).not.toContain("av");
  });

  it("있으면 첫 글자 아바타, 4명까지, 넘으면 +n. 게스트는 번호", () => {
    const three = [person(1, "민서", 0), person(2, "게스트 2", 1), person(3, "jae")];
    const html = renderToStaticMarkup(<ViewersButton live={three} open={false} onClick={() => {}} />);
    expect(html).toContain('aria-label="지금 보는 중 3명"');
    expect(html.match(/class="av /g)).toHaveLength(3);
    expect(text(html)).toBe("민 2 J");
    expect(html).not.toContain("<svg");

    const six = [...three, person(4, "도윤"), person(5, "하늘"), person(6, "게스트 6")];
    const more = renderToStaticMarkup(<ViewersButton live={six} open={true} onClick={() => {}} />);
    expect(more.match(/class="av /g)).toHaveLength(5);
    expect(text(more)).toBe("민 2 J 도 +2");
    expect(more).toContain('aria-pressed="true"');
  });

  it("같은 사람은 늘 같은 농담, 사람마다 t0~t5", () => {
    const html = renderToStaticMarkup(<ViewersButton live={[person(1, "민서"), person(1, "민서")]} open={false} onClick={() => {}} />);
    const tones = [...html.matchAll(/class="av (t\d)"/g)].map((m) => m[1]);
    expect(tones).toHaveLength(2);
    expect(tones[0]).toBe(tones[1]);
    expect(tones[0]).toMatch(/^t[0-5]$/);
  });
});

describe("작은 창", () => {
  it("아무도 안 봤으면 한 줄", () => {
    const html = renderToStaticMarkup(<ViewsPop live={[]} rows={[]} toc={TOC} now={NOW} expanded={false} onMore={() => {}} />);
    expect(text(html)).toBe("아직 아무도 안 봤습니다");
    expect(html).toContain('class="share-pop views-pop"');
  });

  it("위: 지금 보는 중 — 라벨 · 보고 있는 절. 아래: 본 사람 — 라벨 · 마지막 · 읽은 시간 · 횟수", () => {
    const live = [person(1, "민서", 3), person(2, "게스트 2", null)];
    const rows = [row(1, 20, "민서", 1260, 4), row(2, 45, null, 95), row(3, 60 * 60 * 5, "도윤", 40, 2)];
    const html = renderToStaticMarkup(<ViewsPop live={live} rows={rows} toc={TOC} now={NOW} expanded={false} onMore={() => {}} />);
    const liveHtml = /<ul class="vp-live">(.*?)<\/ul>/.exec(html)![1]!;
    expect(text(liveHtml)).toBe("민 민서 배경 2 게스트 2");
    const hist = /<ul class="vp-hist">(.*?)<\/ul>/.exec(html)![1]!;
    expect([...hist.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1]!))).toEqual(["민서 방금 21분 4회", "게스트 2 방금 1분 1회", "도윤 5시간 전 1분 미만 2회"]);
    expect(html).toContain("<hr/>");
    expect(html).not.toContain("더 보기");
    // 설명 문구 · 라벨 없음
    expect(text(html)).not.toMatch(/지금 보는 중|본 사람/);
  });

  it("20줄 넘으면 더 보기, 펼치면 전부", () => {
    const rows = Array.from({ length: 23 }, (_, i) => row(i + 1, i * 100, null));
    const folded = renderToStaticMarkup(<ViewsPop live={[]} rows={rows} toc={TOC} now={NOW} expanded={false} onMore={() => {}} />);
    expect(folded.match(/<li>/g)).toHaveLength(20);
    expect(folded).toContain("더 보기");
    expect(folded).not.toContain("<hr");
    const all = renderToStaticMarkup(<ViewsPop live={[]} rows={rows} toc={TOC} now={NOW} expanded={true} onMore={() => {}} />);
    expect(all.match(/<li>/g)).toHaveLength(23);
    expect(all).not.toContain("더 보기");
  });

  it("모양: 아바타는 키위 바탕 · 글자는 --on-point · 농담 6개. 블록 옆 아바타는 transform 으로만 움직인다. 검은 카드 없음", () => {
    const av = /\.av\{([^}]*)\}/.exec(css)![1]!;
    expect(av).toContain("background:var(--point)");
    expect(av).toContain("color:var(--on-point)");
    expect(av).toContain("border-radius:50%");
    for (const t of [1, 2, 3, 4, 5]) expect(css).toMatch(new RegExp(`\\.av\\.t${t}\\{background:color-mix\\(in srgb,var\\(--point\\) \\d+%,var\\(--(bg|ink)\\)\\)\\}`));
    const peer = /\.peer\{([^}]*)\}/.exec(css)![1]!;
    expect(peer).toContain("position:absolute");
    expect(peer).toMatch(/transition:transform var\(--m-slow\)/);
    expect(peer).toMatch(/transform:translate\(calc\(var\(--k\) \* 12px\),var\(--y\)\)/);
    // 폰: 왼쪽 여백이 좁아 같은 블록의 사람들은 아래로 쌓는다
    expect(css).toMatch(/\.peer\{transform:translate\(0,calc\(var\(--y\) \+ var\(--k\) \* 14px\)\)\}/);
    expect(/\.page > \.peers\{([^}]*)\}/.exec(css)![1]).toContain("pointer-events:none");
    const pop = /\.share-pop\{([^}]*)\}/.exec(css)![1]!;
    expect(pop).toContain("background:var(--surface)");
    expect(pop).not.toContain("--ink");
  });
});
