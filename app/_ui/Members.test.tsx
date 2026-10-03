// 회원 · 추가 모듈 화면 조각 (docs/회원.md 4 · 5장): 선택창(켠 것 표시 · 토글 · 빈 문구) · 관리 표 · 만든 뒤 보여 주기 · 확인 모드 표본.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me, MemberRow, ModuleRow } from "../../lib/members";
import { MemoryMembers, membersSeed } from "../_data/membersMemory";
import { lastSeen, Made, MemberTable, ModuleTable } from "./AdminView";
import { ModuleList, NO_MODULES } from "./ModulePicker";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const mod = (key: string, name: string, sort: number): ModuleRow => ({ key, name, kind: "link", href: `https://${key}.example.com`, sort });
const MODS = [mod("study", "학습 페이지", 10), mod("wiki", "팀 위키", 20)];
const me = (extra: Partial<Me> = {}): Me => ({ role: "member", name: "회원", active: true, allowed: ["study", "wiki"], picked: ["wiki"], modules: MODS, ...extra });
const noop = () => {};

describe("선택창", () => {
  it("허용된 모듈마다 이름 + 스위치, 켠 것만 aria-checked", () => {
    const html = renderToStaticMarkup(<ModuleList me={me()} onToggle={noop} />);
    expect(text(html)).toBe("추가 모듈 학습 페이지 팀 위키");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="false"[^>]*>.*?학습 페이지/);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?팀 위키/);
  });

  it("허용된 것이 없으면 한 줄", () => {
    expect(text(renderToStaticMarkup(<ModuleList me={me({ allowed: [] })} onToggle={noop} />))).toBe(`추가 모듈 ${NO_MODULES}`);
    expect(text(renderToStaticMarkup(<ModuleList me={null} onToggle={noop} />))).toBe(`추가 모듈 ${NO_MODULES}`);
  });
});

describe("관리 표", () => {
  const members: MemberRow[] = [
    { user_id: "u1", login_id: "minseo", name: "김민서", active: true, allowed: ["study"], created_at: "2026-10-01T00:00:00Z", last_sign_in_at: "2026-10-04T04:20:00Z" },
    { user_id: "u2", login_id: "jiwoo", name: "박지우", active: false, allowed: [], created_at: "2026-10-02T00:00:00Z", last_sign_in_at: null },
  ];

  it("회원: 아이디 · 이름 · 마지막 로그인(서울) · 활성화 글자 하나 · 허용 모듈 칩", () => {
    const html = renderToStaticMarkup(<MemberTable members={members} mods={MODS} selected="u2" onOpen={noop} onActive={noop} onAllowed={noop} />);
    const t = text(html);
    expect(t).toContain("minseo 김민서 10.04 13:20 켬 학습 페이지 팀 위키");
    expect(t).toContain("jiwoo 박지우 — 끔");
    expect(html.match(/class="onoff" aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/class="chip" aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-selected="true"');
  });

  it("모듈: 키 · 이름 · 주소(새 탭) · 지우기, 아래에 추가 칸", () => {
    const html = renderToStaticMarkup(<ModuleTable mods={MODS} onAdd={async () => true} onDelete={noop} />);
    expect(text(html)).toContain("study 학습 페이지 https://study.example.com");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('aria-label="학습 페이지 지우기"');
    expect(html).toContain('placeholder="https://"');
  });

  it("만든 뒤: 아이디 · 비밀번호를 그대로 + 복사", () => {
    const t = text(renderToStaticMarkup(<Made login_id="minseo" password="pass1234" onDone={noop} />));
    expect(t).toBe("만들었습니다 아이디 minseo 비밀번호 pass1234 복사 닫기");
  });

  it("마지막 로그인 글자", () => {
    expect(lastSeen(null)).toBe("—");
    expect(lastSeen("2026-10-03T15:05:00Z")).toBe("10.04 00:05");
  });
});

describe("확인 모드 표본 (메모리)", () => {
  it("나는 관리자, 회원 2명 · 모듈 2개. 켜기는 저장되고 모듈을 지우면 허용 · 켠 것에서 빠진다", async () => {
    const m = new MemoryMembers(membersSeed(new Date("2026-10-04T00:00:00Z")));
    const first = await m.me();
    expect(first.role).toBe("admin");
    expect(first.allowed).toEqual(["study", "wiki"]);
    expect(await m.members()).toHaveLength(2);
    expect(await m.setPicked(["wiki"])).toEqual(["wiki"]);
    expect((await m.me()).picked).toEqual(["wiki"]);
    await m.deleteModule("wiki");
    expect((await m.me()).picked).toEqual([]);
    const row = await m.createModule({ name: "Team Docs", href: "https://docs.example.com" });
    expect(row).toMatchObject({ key: "team-docs", kind: "link", sort: 20 });
  });

  it("회원 추가 · 겹침 · 고치기 · 지우기", async () => {
    const m = new MemoryMembers(membersSeed(new Date()));
    const made = await m.createMember({ login_id: "newbie", password: "12345678", name: "새 회원", allowed: ["study"] });
    expect(made).toMatchObject({ login_id: "newbie", active: true, last_sign_in_at: null });
    await expect(m.createMember({ login_id: "newbie", password: "12345678", name: "또", allowed: [] })).rejects.toThrow("[EZ_TAKEN]");
    await expect(m.createMember({ login_id: "xyz1", password: "12345678", name: "가", allowed: ["ghost"] })).rejects.toThrow("없는 모듈");
    expect(await m.updateMember(made.user_id, { active: false })).toMatchObject({ active: false });
    await m.deleteMember(made.user_id);
    expect((await m.members()).map((r) => r.login_id)).toEqual(["minseo", "jiwoo.p"]);
  });

  it("회원은 관리 쪽을 못 부른다", async () => {
    const m = new MemoryMembers({ role: "member", allowed: [], modules: MODS });
    await expect(m.members()).rejects.toThrow("[EZ_FORBIDDEN]");
  });
});
