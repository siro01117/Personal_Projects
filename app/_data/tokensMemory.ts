// 에이전트 연결 — 개인 토큰 — 메모리 구현 (확인 모드 `?demo=1` · 시험). 진짜 쪽 DB(0019)와 같은 규칙을 흉내 낸다:
// 원문은 만들 때 한 번만, 이름 1~30자, 살아 있는 것 10개까지, 폐기한 것은 목록에서 빠지고 되살릴 수 없다.

import { DbError } from "../../lib/errors";
import { tokenNameError, TOKENS_MAX, type MadeToken, type TokenRow, type TokenScope } from "../../lib/tokens";
import type { TokenData } from "./types";

type Stored = TokenRow & { owner: string; revoked: boolean };

export type TokensSeed = {
  /** 나 */
  me: string;
  /** 관리자인가 (남의 것을 세고 폐기할 수 있다) */
  admin?: boolean;
  tokens?: (Partial<TokenRow> & { name: string; owner?: string })[];
};

const ABC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const fail = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");

/** base62 무작위 글자 (0019 ez_token_random 과 같은 방식 — 248 이상인 바이트는 버린다) */
function random(len: number): string {
  let out = "";
  while (out.length < len) {
    const b = new Uint8Array(len);
    crypto.getRandomValues(b);
    for (const x of b) {
      if (x >= 248) continue;
      out += ABC[x % 62];
      if (out.length === len) break;
    }
  }
  return out;
}

const pub = ({ owner: _owner, revoked: _revoked, ...row }: Stored): TokenRow => row;

export class MemoryTokens implements TokenData {
  private rows: Stored[];
  private readonly me: string;
  private readonly admin: boolean;
  private readonly latency: number;
  private readonly now: () => Date;
  private n = 0;

  constructor(seed: TokensSeed, opts: { latency?: number; now?: () => Date } = {}) {
    this.me = seed.me;
    this.admin = seed.admin ?? false;
    this.latency = opts.latency ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.rows = (seed.tokens ?? []).map((t) => ({
      id: t.id ?? this.newId(),
      owner: t.owner ?? seed.me,
      name: t.name,
      tail: t.tail ?? random(4),
      scope: t.scope ?? "rw",
      last_used_at: t.last_used_at ?? null,
      created_at: t.created_at ?? this.now().toISOString(),
      revoked: false,
    }));
  }

  private newId(): string {
    return `70000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
  }

  private async wait(): Promise<void> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
  }

  private live(owner: string): Stored[] {
    return this.rows.filter((r) => r.owner === owner && !r.revoked);
  }

  async list(): Promise<TokenRow[]> {
    await this.wait();
    return this.live(this.me).map(pub);
  }

  async create(name: string, scope: TokenScope): Promise<MadeToken> {
    await this.wait();
    const v = name.trim();
    if (tokenNameError(v)) throw fail("EZ_VALUE", "이름은 1~30자입니다");
    if (scope !== "rw" && scope !== "ro") throw fail("EZ_VALUE", "범위는 rw(읽고 쓰기) · ro(읽기만) 중 하나입니다");
    if (this.live(this.me).length >= TOKENS_MAX) throw fail("EZ_LIMIT", "토큰은 10개까지입니다. 안 쓰는 것을 폐기한 뒤 만드세요");
    const token = `ezt_${random(40)}`;
    const row: Stored = { id: this.newId(), owner: this.me, name: v, tail: token.slice(-4), scope, last_used_at: null, created_at: this.now().toISOString(), revoked: false };
    this.rows.push(row);
    return { ...pub(row), token };
  }

  async revoke(id: string): Promise<void> {
    await this.wait();
    const row = this.live(this.me).find((r) => r.id === id);
    if (!row) throw fail("EZ_NOT_FOUND", "이미 폐기했거나 없는 토큰입니다");
    row.revoked = true;
  }

  async countOf(userId: string): Promise<number> {
    await this.wait();
    return this.admin || userId === this.me ? this.live(userId).length : 0;
  }

  async revokeAllOf(userId: string): Promise<number> {
    await this.wait();
    if (!this.admin && userId !== this.me) return 0;
    const rows = this.live(userId);
    for (const r of rows) r.revoked = true;
    return rows.length;
  }
}

/** 확인 모드의 나 (관리자) */
export const DEMO_ME = "d0000000-0000-4000-8000-100000000001";

/** 확인 모드 표본: 내 토큰 2개(읽고 쓰기 · 12분 전에 씀, 읽기만 · 아직 안 씀) + 회원(김민서)의 것 2개 */
export function tokensSeed(now: Date): TokensSeed {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const minseo = "d0000000-0000-4000-8000-100000000101";
  return {
    me: DEMO_ME,
    admin: true,
    tokens: [
      { name: "집 노트북", tail: "a1b2", scope: "rw", last_used_at: ago(12), created_at: ago(60 * 24 * 3) },
      { name: "회사 PC", tail: "Zx9Q", scope: "ro", last_used_at: null, created_at: ago(60 * 5) },
      { name: "민서 노트북", tail: "k3Lm", owner: minseo, last_used_at: ago(60 * 26), created_at: ago(60 * 24 * 6) },
      { name: "민서 데스크톱", tail: "77pd", owner: minseo, scope: "ro", created_at: ago(60 * 24 * 2) },
    ],
  };
}
