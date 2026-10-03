// 에이전트 연결 화면 조각 · 도움말 팝업 조각 · 확인 모드 표본 (docs/에이전트-연결.md 3 · 4 · 5장).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HELP, opsFor, opText, type HelpKey } from "../../lib/help";
import { TOKEN_SHAPE, type MadeToken, type TokenRow } from "../../lib/tokens";
import { DEMO_ME, MemoryTokens, tokensSeed } from "../_data/tokensMemory";
import { MadeBox, TokenList } from "./AgentSettings";
import { Connection, connectionLine, HelpBody } from "./Help";
import { MemberTokensRow } from "./MemberTokens";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};
const NOW = new Date("2026-10-04T03:00:00Z");
const row = (extra: Partial<TokenRow> = {}): TokenRow => ({ id: "t1", name: "집 노트북", tail: "a1b2", scope: "rw", last_used_at: null, created_at: "2026-10-01T00:00:00Z", ...extra });

describe("설정 — 에이전트 연결", () => {
  it("목록: 이름 · 끝 4자 · 범위 · 마지막 사용 · 폐기", () => {
    const rows = [row({ last_used_at: "2026-10-04T02:48:00Z" }), row({ id: "t2", name: "회사 PC", tail: "Zx9Q", scope: "ro" })];
    const html = renderToStaticMarkup(<TokenList rows={rows} now={NOW} onRevoke={noop} />);
    expect(text(html)).toBe("집 노트북 …a1b2 읽고 쓰기 12분 전 폐기 회사 PC …Zx9Q 읽기만 — 폐기");
    expect(html).toContain('aria-label="집 노트북 폐기"');
  });

  it("토큰이 없으면 목록을 그리지 않는다", () => {
    expect(renderToStaticMarkup(<TokenList rows={[]} now={NOW} onRevoke={noop} />)).toBe("");
  });

  it("만든 직후 상자: 명령 한 줄 + 복사, 두 줄 안내, 주소 · 토큰 따로 복사", () => {
    const made: MadeToken = { ...row(), token: `ezt_${"aB3x".repeat(10)}` };
    const html = renderToStaticMarkup(<MadeBox t={made} origin="https://ra-kan.cloud" onCopy={noop} onClose={noop} />);
    const t = text(html);
    expect(t).toContain(`claude mcp add --transport http ezwork https://ra-kan.cloud/api/mcp --header "Authorization: Bearer ${made.token}"`);
    expect(t).toMatch(/복사 터미널에 붙여 넣으세요 이 창을 닫으면 다시 볼 수 없습니다 주소 복사 토큰 복사$/);
    expect(html).toContain('aria-label="닫기"');
  });

  it("관리 화면 회원 시트: 토큰 n개 · 전부 폐기 (없으면 단추 없음, 한 번 더 눌러 확인)", () => {
    const base = { busy: false, onAsk: noop, onCancel: noop, onRevoke: noop };
    expect(text(renderToStaticMarkup(<MemberTokensRow {...base} count={2} confirm={false} />))).toBe("토큰 2개 전부 폐기");
    expect(text(renderToStaticMarkup(<MemberTokensRow {...base} count={2} confirm />))).toBe("토큰 2개 전부 폐기 확인");
    expect(text(renderToStaticMarkup(<MemberTokensRow {...base} count={0} confirm={false} />))).toBe("토큰 0개");
    expect(text(renderToStaticMarkup(<MemberTokensRow {...base} count={null} confirm={false} />))).toBe("토큰");
  });
});

describe("도움말 팝업", () => {
  it.each(Object.keys(HELP) as HelpKey[])("%s: 그 모듈의 조작 · 예시 · 도구 이름만", (k) => {
    const t = HELP[k];
    const html = renderToStaticMarkup(<HelpBody topic={t} onCopy={noop} />);
    const body = text(html);
    const ops = t.ops.map(opText);
    expect(body.startsWith(`${t.title} 이 화면 ${ops[0]}`)).toBe(true);
    for (const o of ops) expect(body).toContain(o);
    for (const a of t.asks) expect(body).toContain(a);
    expect(html.match(/<button/g)?.length ?? 0).toBe(t.asks.length);
    if (t.asks.length > 0) {
      expect(body).toContain("에이전트에게");
      expect(body).toContain(t.tools.join(" · "));
    } else expect(body).not.toContain("에이전트에게");
    // 다른 모듈의 내용이 섞이지 않는다
    for (const other of (Object.keys(HELP) as HelpKey[]).filter((x) => x !== k)) {
      for (const o of HELP[other].ops.map(opText)) if (!ops.includes(o)) expect(body, `${other}: ${o}`).not.toContain(o);
      for (const a of HELP[other].asks) if (!t.asks.includes(a)) expect(body, `${other}: ${a}`).not.toContain(a);
    }
  });

  it("폰(아래 시트)에서는 키보드 · 마우스로만 되는 줄이 빠진다", () => {
    const body = text(renderToStaticMarkup(<HelpBody topic={HELP.planner} phone onCopy={noop} />));
    expect(body).not.toContain("N = 새 할 일");
    expect(body).not.toContain("끌어서");
    for (const o of opsFor(HELP.planner, true)) expect(body).toContain(o);
    expect(body).toContain("우클릭(길게 누르기)");
    // 에이전트 예시는 그대로
    for (const a of HELP.planner.asks) expect(body).toContain(a);
  });

  it("연결: 토큰이 없으면 설정으로 가는 단추, 있으면 한 줄", () => {
    expect(connectionLine([], NOW)).toBeNull();
    expect(connectionLine([row(), row({ id: "t2" })], NOW)).toBe("토큰 2개 · 아직 쓰지 않음");
    // 가장 최근에 쓴 것을 본다
    const used = [row({ last_used_at: "2026-10-03T01:00:00Z" }), row({ id: "t2", last_used_at: "2026-10-04T02:48:00Z" }), row({ id: "t3" })];
    expect(connectionLine(used, NOW)).toBe("연결됨 · 마지막 사용 12분 전");

    const none = renderToStaticMarkup(<Connection line={null} settingsHref="/settings/agent" />);
    expect(text(none)).toBe("연결 에이전트 연결");
    expect(none).toContain('href="/settings/agent"');
    const some = renderToStaticMarkup(<Connection line="연결됨 · 마지막 사용 12분 전" settingsHref="/settings/agent?demo=1" />);
    expect(text(some)).toBe("연결 연결됨 · 마지막 사용 12분 전");
    expect(some).toContain('href="/settings/agent?demo=1"');
    // 설정 화면에서는 단추를 또 그리지 않는다
    expect(renderToStaticMarkup(<Connection line={null} settingsHref={null} />)).toBe("");
    expect(text(renderToStaticMarkup(<Connection line="토큰 1개 · 아직 쓰지 않음" settingsHref={null} />))).toBe("연결 토큰 1개 · 아직 쓰지 않음");
  });
});

describe("확인 모드 표본 (메모리)", () => {
  const make = () => new MemoryTokens(tokensSeed(NOW), { now: () => NOW });

  it("내 토큰 2개 — 읽고 쓰기(12분 전에 씀) · 읽기만(안 씀). 원문 · 남의 것은 목록에 없다", async () => {
    const list = await make().list();
    expect(list.map((t) => [t.name, t.tail, t.scope, t.last_used_at === null])).toEqual([
      ["집 노트북", "a1b2", "rw", false],
      ["회사 PC", "Zx9Q", "ro", true],
    ]);
    expect(connectionLine(list, NOW)).toBe("연결됨 · 마지막 사용 12분 전");
    expect(JSON.stringify(list)).not.toContain("ezt_");
    expect(Object.keys(list[0]!).sort()).toEqual(["created_at", "id", "last_used_at", "name", "scope", "tail"]);
  });

  it("만들기: 원문은 그때 한 번, 목록에는 끝 4자만. 폐기하면 빠지고 다시 폐기할 수 없다", async () => {
    const m = make();
    const made = await m.create("  새 노트북  ", "ro");
    expect(made.token).toMatch(TOKEN_SHAPE);
    expect(made).toMatchObject({ name: "새 노트북", scope: "ro", tail: made.token.slice(-4), last_used_at: null });
    const list = await m.list();
    expect(list.map((t) => t.name)).toEqual(["집 노트북", "회사 PC", "새 노트북"]);
    expect(JSON.stringify(list)).not.toContain(made.token);
    await m.revoke(made.id);
    expect((await m.list()).map((t) => t.name)).toEqual(["집 노트북", "회사 PC"]);
    await expect(m.revoke(made.id)).rejects.toThrow("[EZ_NOT_FOUND]");
  });

  it("이름 · 10개 상한은 DB 와 같은 문구로 거절", async () => {
    const m = make();
    await expect(m.create("   ", "rw")).rejects.toThrow("[EZ_VALUE]");
    await expect(m.create("가".repeat(31), "rw")).rejects.toThrow("[EZ_VALUE]");
    for (let i = 0; i < 8; i++) await m.create(`PC ${i}`, "rw");
    await expect(m.create("열한 번째", "rw")).rejects.toThrow("[EZ_LIMIT]");
  });

  it("관리자: 회원의 토큰을 세고 전부 폐기한다 (내 것은 그대로)", async () => {
    const m = make();
    const minseo = "d0000000-0000-4000-8000-100000000101";
    expect(await m.countOf(minseo)).toBe(2);
    expect(await m.countOf("d0000000-0000-4000-8000-100000000102")).toBe(0);
    expect(await m.revokeAllOf(minseo)).toBe(2);
    expect(await m.countOf(minseo)).toBe(0);
    expect(await m.list()).toHaveLength(2);
  });

  it("회원은 남의 것을 못 세고 못 폐기한다", async () => {
    const m = new MemoryTokens({ ...tokensSeed(NOW), me: "d0000000-0000-4000-8000-100000000102", admin: false });
    expect(await m.countOf(DEMO_ME)).toBe(0);
    expect(await m.revokeAllOf(DEMO_ME)).toBe(0);
    expect(await new MemoryTokens(tokensSeed(NOW)).list()).toHaveLength(2);
  });
});
