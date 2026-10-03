import { describe, expect, it } from "vitest";
import type { Presence, ViewRow } from "../_data/types";
import {
  avatarRow,
  avatarText,
  avatarTone,
  byBlock,
  centerBlock,
  deviceKey,
  deviceOf,
  DEVICE_RE,
  isLive,
  LIVE_MS,
  liveNow,
  readTime,
  sectionTitle,
  seenAgo,
  sortViews,
  uaHint,
  viewerLabel,
} from "./views";

const NOW = new Date("2026-10-03T12:00:00+09:00");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
const row = (n: number, lastSec: number, name: string | null = null, extra: Partial<ViewRow> = {}): ViewRow => ({
  id: `v${n}`,
  device: `device-${String(n).padStart(15, "0")}`,
  guest_no: n,
  name,
  first_at: ago(lastSec + 600),
  last_at: ago(lastSec),
  hits: 1,
  seconds: 0,
  ua: null,
  ...extra,
});

describe("라벨 · 70초 판정", () => {
  it("이름이 없으면 게스트 n", () => {
    expect(viewerLabel({ name: null, guest_no: 3 })).toBe("게스트 3");
    expect(viewerLabel({ name: "민서", guest_no: 3 })).toBe("민서");
  });

  it("last_at 이 70초 안이면 지금 보는 중. 미래(시계 차이)도 보는 중, 깨진 값은 아님", () => {
    expect(LIVE_MS).toBe(70_000);
    expect(isLive(ago(0), NOW)).toBe(true);
    expect(isLive(ago(70), NOW)).toBe(true);
    expect(isLive(ago(71), NOW)).toBe(false);
    expect(isLive(ago(-30), NOW)).toBe(true);
    expect(isLive("깨짐", NOW)).toBe(false);
  });

  it("최근 것부터, 같으면 게스트 번호 순", () => {
    const rows = [row(3, 60), row(1, 10), row(2, 10)];
    expect(sortViews(rows).map((r) => r.guest_no)).toEqual([1, 2, 3]);
  });
});

describe("시간 글자", () => {
  it("읽은 시간: 1분 미만 · n분 · n시간 m분", () => {
    expect(readTime(0)).toBe("1분 미만");
    expect(readTime(59)).toBe("1분 미만");
    expect(readTime(60)).toBe("1분");
    expect(readTime(1260)).toBe("21분");
    expect(readTime(3600)).toBe("1시간");
    expect(readTime(3600 + 60 * 5 + 30)).toBe("1시간 5분");
    expect(readTime(-5)).toBe("1분 미만");
  });

  it("마지막으로 본 때: 방금 · n분 전 · n시간 전 · 어제 · 날짜", () => {
    expect(seenAgo(ago(20), NOW)).toBe("방금");
    expect(seenAgo(ago(70), NOW)).toBe("방금");
    expect(seenAgo(ago(71), NOW)).toBe("1분 전");
    expect(seenAgo(ago(60 * 45), NOW)).toBe("45분 전");
    expect(seenAgo(ago(60 * 60 * 3), NOW)).toBe("3시간 전");
    expect(seenAgo(ago(60 * 60 * 20), NOW)).toBe("어제");
    expect(seenAgo(ago(60 * 60 * 24 * 3), NOW)).toBe("3일 전");
    expect(seenAgo("깨짐", NOW)).toBe("");
  });
});

describe("기기", () => {
  it("힌트: 폰/태블릿/PC · 브라우저", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const android = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const samsung = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36";
    const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    const edge = `${win} Edg/128.0.0.0`;
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    const ff = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0";
    const ipad = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(uaHint(iphone)).toBe("폰 · Safari");
    expect(uaHint(android)).toBe("폰 · Chrome");
    expect(uaHint(samsung)).toBe("폰 · 삼성 브라우저");
    expect(uaHint(win)).toBe("PC · Chrome");
    expect(uaHint(edge)).toBe("PC · Edge");
    expect(uaHint(mac)).toBe("PC · Safari");
    expect(uaHint(ff)).toBe("PC · Firefox");
    expect(uaHint(ipad)).toBe("태블릿 · Safari");
    expect(uaHint("")).toBe("PC · 브라우저");
    expect(uaHint(win).length).toBeLessThanOrEqual(80);
  });

  it("열쇠: 16바이트 → 22자 base64url. 저장소에 있으면 그것, 없으면 만들어 둔다", () => {
    const bytes = new Uint8Array(16).map((_, i) => i * 17);
    const k = deviceKey(bytes);
    expect(k).toMatch(DEVICE_RE);
    expect(deviceKey(new Uint8Array(16).fill(255))).toMatch(DEVICE_RE); // + / 가 - _ 로
    const mem = new Map<string, string>();
    const store = { getItem: (x: string) => mem.get(x) ?? null, setItem: (x: string, v: string) => void mem.set(x, v) };
    const a = deviceOf(store, (n) => new Uint8Array(n).fill(7));
    expect(a).toMatch(DEVICE_RE);
    expect(deviceOf(store, (n) => new Uint8Array(n).fill(9))).toBe(a);
    mem.set("ezwork.device", "깨진 값");
    expect(deviceOf(store, (n) => new Uint8Array(n).fill(9))).not.toBe("깨진 값");
    expect(deviceOf(null, (n) => new Uint8Array(n).fill(1))).toMatch(DEVICE_RE);
  });
});

describe("화면 가운데 블록", () => {
  const rects = [
    { top: -400, bottom: -100 },
    { top: -60, bottom: 300 },
    { top: 340, bottom: 500 },
    { top: 560, bottom: 900 },
  ];
  it("가운데에 걸린 블록", () => {
    expect(centerBlock(rects, 100)).toBe(1);
    expect(centerBlock(rects, 400)).toBe(2);
    expect(centerBlock(rects, 340)).toBe(2);
    expect(centerBlock(rects, 300)).toBe(1); // 경계: bottom 은 밖이지만 거리 0 이라 그 블록
  });
  it("여백에 걸리면 가장 가까운 블록, 블록이 없으면 null", () => {
    expect(centerBlock(rects, 310)).toBe(1);
    expect(centerBlock(rects, 330)).toBe(2);
    expect(centerBlock(rects, 2000)).toBe(3);
    expect(centerBlock(rects, -1000)).toBe(0);
    expect(centerBlock([], 100)).toBeNull();
  });
});

describe("절 제목 · 아바타", () => {
  const toc: [number, string][] = [
    [0, "판정"],
    [2, "배경"],
    [5, "출처"],
  ];
  it("블록 번호 → 그 번호 이하 가장 가까운 차례 항목. 앞에 없으면 맨 위", () => {
    expect(sectionTitle(toc, 0)).toBe("판정");
    expect(sectionTitle(toc, 1)).toBe("판정");
    expect(sectionTitle(toc, 4)).toBe("배경");
    expect(sectionTitle(toc, 9)).toBe("출처");
    expect(sectionTitle([[3, "뒤"]], 1)).toBe("맨 위");
    expect(sectionTitle(toc, null)).toBe("");
  });

  it("아바타 줄: 4명까지, 넘으면 +n", () => {
    const five = ["a", "b", "c", "d", "e"];
    expect(avatarRow(five)).toEqual({ shown: ["a", "b", "c", "d"], more: 1 });
    expect(avatarRow(five.slice(0, 4))).toEqual({ shown: ["a", "b", "c", "d"], more: 0 });
    expect(avatarRow([])).toEqual({ shown: [], more: 0 });
    expect(avatarRow([...five, ...five, "k"])).toEqual({ shown: ["a", "b", "c", "d"], more: 7 });
  });

  it("아바타 글자: 첫 글자(대문자), 게스트는 번호", () => {
    expect(avatarText("민서")).toBe("민");
    expect(avatarText("jae kim")).toBe("J");
    expect(avatarText("게스트 12")).toBe("12");
    expect(avatarText("  ")).toBe("?");
  });

  it("농담은 기기마다 정해지고 0~5", () => {
    const a = avatarTone("device-000000000000001");
    expect(a).toBe(avatarTone("device-000000000000001"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(6);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => avatarTone(`d${i}`)));
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe("지금 보는 중 합치기", () => {
  const rows = [row(1, 20, "민서"), row(2, 50), row(3, 60 * 60), row(4, 69)];
  it("presence 가 없으면(Realtime 안 됨) 기록의 70초 안인 사람만, 위치 없음", () => {
    expect(liveNow(null, rows, NOW)).toEqual([
      { device: rows[1]!.device, label: "게스트 2", block: null },
      { device: rows[3]!.device, label: "게스트 4", block: null },
      { device: rows[0]!.device, label: "민서", block: null },
    ]);
  });

  it("presence 에 있는 사람은 위치 · 라벨을 presence 것으로, 기록에만 있는 사람은 덧붙인다", () => {
    const presence: Presence[] = [
      { device: rows[1]!.device, label: "도윤", block: 3 },
      { device: "device-000000000000099", label: "게스트 9", block: 0 },
    ];
    const out = liveNow(presence, rows, NOW);
    expect(out).toEqual([
      { device: rows[3]!.device, label: "게스트 4", block: null },
      { device: "device-000000000000099", label: "게스트 9", block: 0 },
      { device: rows[1]!.device, label: "도윤", block: 3 },
      { device: rows[0]!.device, label: "민서", block: null },
    ]);
    expect(byBlock(out)).toEqual(new Map([[0, [out[1]]], [3, [out[2]]]]));
    // 라벨순은 수를 수로 본다
    const many = liveNow([{ device: "device-000000000000010", label: "게스트 10", block: null }, { device: "device-000000000000002", label: "게스트 2", block: null }], [], NOW);
    expect(many.map((p) => p.label)).toEqual(["게스트 2", "게스트 10"]);
  });
});
