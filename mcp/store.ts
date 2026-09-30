// 서랍 데이터 접근. 구현: store-supabase(실제), store-pglite(시험).
// 모든 구현은 자기 owner 의 살아 있는(deleted_at is null) 항목만 보고 고친다.
// 규칙(이름 겹침·순환·깊이·부모·크기)은 DB 가 막는다. 실패하면 DbError 를 던진다.

import type { ReportKind } from "../lib/blocks";

export type Kind = "folder" | "report";

export type Item = {
  id: string;
  parent_id: string | null;
  kind: Kind;
  name: string;
  report_kind: ReportKind | null;
  version: number;
  agent_updated_at: string | null;
  read_at: string | null;
  updated_at: string;
};

export type Report = Item & { blocks: unknown[] };

export type FolderNode = { id: string; parent_id: string | null; name: string };

export type NewItem =
  | { kind: "folder"; parent_id: string | null; name: string }
  | {
      kind: "report";
      parent_id: string | null;
      name: string;
      report_kind: ReportKind;
      blocks: unknown[];
      schema_version: number;
      agent: string;
      agent_updated_at: string;
    };

export type ItemPatch = Partial<{
  parent_id: string | null;
  name: string;
  blocks: unknown[];
  agent: string;
  agent_updated_at: string;
}>;

export interface Store {
  /** 살아 있는 폴더 전부 (경로 계산용) */
  folders(): Promise<FolderNode[]>;
  /** 폴더 안 (parentId = null 이면 맨 위) */
  children(parentId: string | null): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  /** 보고서면 blocks 까지, 아니면 null */
  getReport(id: string): Promise<Report | null>;
  insert(item: NewItem): Promise<Item>;
  /** baseVersion 을 주면 version 이 같을 때만. 고친 행이 없으면 null */
  update(id: string, patch: ItemPatch, baseVersion?: number): Promise<Item | null>;
  /** ez_delete — 자손까지 같은 묶음으로 휴지통에. 묶음 id */
  remove(id: string): Promise<string>;
  /** 이름에 q 가 든 항목 (대소문자 무시, 글자 그대로) */
  searchNames(q: string, limit: number): Promise<Item[]>;
  /** 보고서를 최근 고친 순으로 한 쪽씩 (본문 찾기용) */
  scanReports(offset: number, limit: number): Promise<Report[]>;
}

export const ITEM_COLS = "id, parent_id, kind, name, report_kind, version, agent_updated_at, read_at, updated_at";

/** LIKE 패턴 안의 %, _, \ 를 글자 그대로 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
