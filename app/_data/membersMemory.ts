// 회원 · 추가 모듈 — 메모리 구현 (확인 모드 `?demo=1` · 시험). 진짜 쪽 DB(0015) · 라우트와 같은 규칙을 흉내 낸다.
// 확인 모드의 나는 관리자다(관리 화면 · 선택창을 다 볼 수 있게). 시험은 role 을 바꿔 넣는다.

import { DbError } from "../../lib/errors";
import {
  keysError,
  linkError,
  moduleKeyFrom,
  moduleNameError,
  nameError,
  newMemberError,
  passwordError,
  type Me,
  type MemberPatch,
  type MemberRow,
  type MeRole,
  type ModuleRow,
  type NewMember,
  type NewModule,
} from "../../lib/members";
import type { AdminData, MeData } from "./types";

export type MembersSeed = {
  role: MeRole;
  name?: string | null;
  active?: boolean;
  /** 회원일 때 허용된 키 (관리자는 모든 모듈) */
  allowed?: string[];
  picked?: string[];
  members?: MemberRow[];
  modules?: ModuleRow[];
};

const fail = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");

export class MemoryMembers implements MeData, AdminData {
  private role: MeRole;
  private name: string | null;
  private active: boolean;
  private allowed: string[];
  private picked: string[];
  private rows: MemberRow[];
  private mods: ModuleRow[];
  private readonly latency: number;
  private n = 0;

  constructor(seed: MembersSeed, opts: { latency?: number } = {}) {
    this.role = seed.role;
    this.name = seed.name ?? null;
    this.active = seed.active ?? seed.role !== "none";
    this.allowed = [...(seed.allowed ?? [])];
    this.picked = [...(seed.picked ?? [])];
    this.rows = structuredClone(seed.members ?? []);
    this.mods = structuredClone(seed.modules ?? []);
    this.latency = opts.latency ?? 0;
  }

  private async wait(): Promise<void> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
  }

  private sorted(): ModuleRow[] {
    return [...this.mods].sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : 1));
  }

  private admin(): void {
    if (this.role !== "admin") throw fail("EZ_FORBIDDEN", "권한이 없습니다");
  }

  async me(): Promise<Me> {
    await this.wait();
    const mods = this.sorted();
    if (this.role === "admin") {
      return { role: "admin", name: null, active: true, allowed: mods.map((m) => m.key), picked: [...this.picked], modules: structuredClone(mods) };
    }
    if (this.role === "member") {
      const shown = this.active ? mods.filter((m) => this.allowed.includes(m.key)) : [];
      return { role: "member", name: this.name, active: this.active, allowed: [...this.allowed], picked: [...this.picked], modules: structuredClone(shown) };
    }
    return { role: "none", name: null, active: false, allowed: [], picked: [], modules: [] };
  }

  async setPicked(keys: string[]): Promise<string[]> {
    await this.wait();
    if (this.role === "none") throw fail("EZ_NOT_FOUND", "이 계정은 쓸 수 없습니다");
    if (keysError(keys)) throw fail("EZ_VALUE", "모듈 키가 맞지 않습니다");
    this.picked = [...keys];
    return [...this.picked];
  }

  async members(): Promise<MemberRow[]> {
    await this.wait();
    this.admin();
    return structuredClone(this.rows);
  }

  private unknownKeys(keys: readonly string[]): boolean {
    return keys.some((k) => !this.mods.some((m) => m.key === k));
  }

  async createMember(input: NewMember): Promise<MemberRow> {
    await this.wait();
    this.admin();
    const err = newMemberError(input);
    if (err) throw fail("EZ_VALUE", err);
    if (this.unknownKeys(input.allowed)) throw fail("EZ_VALUE", "없는 모듈입니다");
    if (this.rows.some((r) => r.login_id === input.login_id)) throw fail("EZ_TAKEN", "이미 있는 아이디입니다");
    const row: MemberRow = {
      user_id: `d0000000-0000-4000-8000-1${String(++this.n).padStart(11, "0")}`,
      login_id: input.login_id,
      name: input.name,
      active: true,
      allowed: [...input.allowed],
      created_at: new Date().toISOString(),
      last_sign_in_at: null,
    };
    this.rows.push(row);
    return structuredClone(row);
  }

  async updateMember(id: string, patch: MemberPatch): Promise<MemberRow> {
    await this.wait();
    this.admin();
    const row = this.rows.find((r) => r.user_id === id);
    if (!row) throw fail("EZ_NOT_FOUND", "없는 회원입니다");
    const err =
      (patch.password !== undefined ? passwordError(patch.password) : null) ??
      (patch.name !== undefined ? nameError(patch.name) : null) ??
      (patch.allowed !== undefined ? keysError(patch.allowed) : null);
    if (err) throw fail("EZ_VALUE", err);
    if (patch.allowed && this.unknownKeys(patch.allowed)) throw fail("EZ_VALUE", "없는 모듈입니다");
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.active !== undefined) row.active = patch.active;
    if (patch.allowed !== undefined) row.allowed = [...patch.allowed];
    return structuredClone(row);
  }

  async deleteMember(id: string): Promise<void> {
    await this.wait();
    this.admin();
    if (!this.rows.some((r) => r.user_id === id)) throw fail("EZ_NOT_FOUND", "없는 회원입니다");
    this.rows = this.rows.filter((r) => r.user_id !== id);
  }

  async modules(): Promise<ModuleRow[]> {
    await this.wait();
    return structuredClone(this.sorted());
  }

  async createModule(input: NewModule): Promise<ModuleRow> {
    await this.wait();
    this.admin();
    const err = moduleNameError(input.name) ?? linkError(input.href);
    if (err) throw fail("EZ_VALUE", err);
    const row: ModuleRow = {
      key: moduleKeyFrom(input.name, this.mods.map((m) => m.key)),
      name: input.name,
      kind: "link",
      href: input.href,
      sort: this.mods.reduce((a, m) => Math.max(a, m.sort), 0) + 10,
    };
    this.mods.push(row);
    return structuredClone(row);
  }

  async deleteModule(key: string): Promise<void> {
    await this.wait();
    this.admin();
    this.mods = this.mods.filter((m) => m.key !== key);
    // DB 의 ez_modules_after 처럼 허용 · 켠 것에서도 뺀다
    for (const r of this.rows) r.allowed = r.allowed.filter((k) => k !== key);
    this.allowed = this.allowed.filter((k) => k !== key);
    this.picked = this.picked.filter((k) => k !== key);
  }
}

/** 확인 모드 표본: 회원 2명 · 모듈 2개, 나는 관리자 (켠 것 없음 — 선택창에서 켜 본다) */
export function membersSeed(now: Date): MembersSeed {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  return {
    role: "admin",
    picked: [],
    modules: [
      { key: "study", name: "학습 페이지", kind: "link", href: "https://example.com/study", sort: 10 },
      { key: "wiki", name: "팀 위키", kind: "link", href: "https://example.com/wiki", sort: 20 },
    ],
    members: [
      { user_id: "d0000000-0000-4000-8000-100000000101", login_id: "minseo", name: "김민서", active: true, allowed: ["study"], created_at: ago(24 * 9), last_sign_in_at: ago(3) },
      { user_id: "d0000000-0000-4000-8000-100000000102", login_id: "jiwoo.p", name: "박지우", active: false, allowed: [], created_at: ago(24 * 4), last_sign_in_at: null },
    ],
  };
}
