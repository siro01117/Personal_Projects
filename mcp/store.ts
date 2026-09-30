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

export type SearchHit = {
  id: string;
  kind: Kind;
  name: string;
  parent_id: string | null;
  report_kind: ReportKind | null;
  match: "name" | "body";
  snippet: string | null;
  updated_at: string;
};

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

/** 사진 저장소에 있는 파일 하나 (주인 폴더 안) */
export type StoredImage = { path: string; created_at: string };

/** 사진 파일: 버킷 ez-images, 경로 <주인 uuid>/<sha256>.webp. 주인 폴더 밖은 다루지 않는다 */
export interface ImageStore {
  imageExists(path: string): Promise<boolean>;
  /** WebP 한 장 올리기. 같은 경로가 이미 있으면 그대로 성공 (같은 내용 = 같은 경로) */
  uploadImage(path: string, bytes: Uint8Array): Promise<void>;
  /** 주인 폴더의 사진 전부 */
  listImages(): Promise<StoredImage[]>;
  deleteImages(paths: string[]): Promise<void>;
  /** ez_image_srcs — 주인의 보고서(살아 있든 휴지통이든)가 쓰는 사진 경로 */
  imageSrcs(): Promise<Set<string>>;
}

export const IMAGE_BUCKET = "ez-images";

export interface Store extends ImageStore {
  /** 이 서랍의 주인 (사진 경로의 첫 폴더) */
  readonly owner: string;
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
  /** ez_search — 이름 또는 보고서 본문 글자에서 찾기. under 가 있으면 그 폴더 아래만 */
  search(q: string, under: string | null, limit: number): Promise<SearchHit[]>;
}

export const ITEM_COLS = "id, parent_id, kind, name, report_kind, version, agent_updated_at, read_at, updated_at";
