// 웹이 서랍 데이터를 읽고 쓰는 창구. 구현 2개: Supabase(진짜, 로그인한 사람 세션 + RLS) / 메모리(개발 확인용).
// 실패는 DbError 모양({ code, message })으로 던지고, 화면은 lib/errors 의 toKorean 으로 한국어로 바꾼다.

import type { ReportKind } from "../../lib/blocks";

export type Kind = "folder" | "report";

/** 탐색기에 보이는 한 칸 */
export type Entry = {
  id: string;
  parent_id: string | null;
  kind: Kind;
  name: string;
  agent_updated_at: string | null;
  read_at: string | null;
  updated_at: string;
};

export type Folder = { id: string; parent_id: string | null; name: string };

export type ReportDoc = Entry & {
  kind: "report";
  report_kind: ReportKind | null;
  blocks: unknown[];
  version: number;
  agent: string | null;
  share_token: string | null;
};

export type SharedDoc = { name: string; report_kind: string | null; blocks: unknown[]; updated_at: string };

/** ez_restore 한 줄 */
export type Restored = { id: string; name: string; to_root: boolean; renamed: boolean };

export type Path = readonly (string | number)[];

export interface DrawerData {
  /** 폴더 안 (null = 맨 위). 순서는 화면이 정한다 */
  list(parentId: string | null): Promise<Entry[]>;
  /** 살아 있는 폴더 전부 — 위쪽 경로·옮길 곳 목록용 */
  folders(): Promise<Folder[]>;
  /** 없거나 지웠으면 null */
  report(id: string): Promise<ReportDoc | null>;
  /** 안 읽은 보고서 수 (홈 배지) */
  unreadCount(): Promise<number>;

  createFolder(parentId: string | null, name: string): Promise<Entry>;
  /** 이름 바꾸기. 겹치면 거절(23505) — 사람이 정한 이름이라 자동으로 바꾸지 않는다 */
  rename(id: string, name: string): Promise<void>;
  /** 옮기기. 옮길 곳에 같은 이름이 있으면 ' (2)' 류를 붙여 옮기고 최종 이름을 돌려준다 */
  move(id: string, parentId: string | null): Promise<{ name: string; renamed: boolean }>;
  /** ez_delete — 자손까지 한 묶음으로 휴지통에. 묶음 id */
  remove(id: string): Promise<string>;
  /** ez_restore — 묶음째 복원 */
  restore(batch: string): Promise<Restored[]>;

  markRead(id: string): Promise<void>;
  /** ez_edit_text — path 는 blocks 기준([2,'body']) 또는 ['title']. 새 version */
  editText(id: string, baseVersion: number, path: Path, value: string): Promise<number>;
  /** ez_share — 새 열쇠(이전 열쇠는 무효) */
  share(id: string): Promise<string>;
  unshare(id: string): Promise<void>;
  /** ez_shared — 로그인 없이. 없거나 꺼졌으면 null */
  shared(token: string): Promise<SharedDoc | null>;
}

export interface Auth {
  /** 로그인해 있으면 true */
  signedIn(): Promise<boolean>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** 로그인 풀림 알림. 구독 해제 함수를 돌려준다 */
  onSignedOut(cb: () => void): () => void;
}

export type Source = { data: DrawerData; auth: Auth; demo: boolean };
