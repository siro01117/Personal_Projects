// 라이브 — Supabase Realtime presence 채널 report:<열쇠> (설계서 7-4장). DB 를 거치지 않고 남지도 않는다.
// 공개 페이지(join)는 자기 상태 {device, label, block} 만 올리고 남의 상태는 받지 않는다(presence.enabled = false).
// 주인 화면(watch)은 듣기만 한다 — 자기 상태는 올리지 않는다. 연결이 안 되거나 끊기면 null 을 알린다.
// 채널은 공개라 아무 클라이언트가 올린 것이 올 수 있다 — 들어온 상태는 모양을 검사하고 글자 길이를 자른다(데이터일 뿐, 화면은 글자로만 그린다).

import type { RealtimeChannel } from "@supabase/supabase-js";
import { DEVICE_RE } from "../_logic/views";
import { sb } from "./supabase";
import type { LiveData, LiveSession, Presence } from "./types";

/** presence 라벨 글자 수 상한 (이름 20자 · "게스트 n") */
const LABEL_MAX = 24;

const channelName = (token: string) => `report:${token}`;

/** 남이 올린 상태 → 우리 모양. 모양이 다르면 null */
export function readPresence(x: unknown): Presence | null {
  if (typeof x !== "object" || x === null) return null;
  const { device, label, block } = x as Record<string, unknown>;
  if (typeof device !== "string" || !DEVICE_RE.test(device)) return null;
  if (typeof label !== "string" || label.trim() === "") return null;
  const b = typeof block === "number" && Number.isInteger(block) && block >= 0 && block < 10_000 ? block : null;
  return { device, label: [...label.trim()].slice(0, LABEL_MAX).join(""), block: b };
}

/** presenceState() → 사람 목록 (기기마다 하나 — 같은 기기가 두 탭이면 마지막 것) */
export function flattenPresence(state: Record<string, unknown[]>): Presence[] {
  const out = new Map<string, Presence>();
  for (const entries of Object.values(state)) {
    for (const e of entries) {
      const p = readPresence(e);
      if (p) out.set(p.device, p);
    }
  }
  return [...out.values()];
}

export class SupabaseLive implements LiveData {
  join(token: string, state: Presence): LiveSession {
    const client = sb();
    const ch: RealtimeChannel = client.channel(channelName(token), { config: { presence: { key: state.device, enabled: false } } });
    let cur = state;
    let ready = false;
    let gone = false;
    ch.subscribe((status) => {
      if (gone) return;
      if (status === "SUBSCRIBED") {
        ready = true;
        void ch.track(cur).catch(() => {});
      } else ready = false;
    });
    return {
      track(s) {
        cur = s;
        if (ready && !gone) void ch.track(cur).catch(() => {});
      },
      leave() {
        if (gone) return;
        gone = true;
        void ch
          .untrack()
          .catch(() => {})
          .finally(() => void client.removeChannel(ch).catch(() => {}));
      },
    };
  }

  watch(token: string, onChange: (people: Presence[] | null) => void): () => void {
    const client = sb();
    const ch = client.channel(channelName(token), { config: { presence: { enabled: true } } });
    let off = false;
    ch.on("presence", { event: "sync" }, () => {
      if (!off) onChange(flattenPresence(ch.presenceState()));
    });
    ch.subscribe((status) => {
      if (off) return;
      if (status !== "SUBSCRIBED") onChange(null);
    });
    return () => {
      off = true;
      void client.removeChannel(ch).catch(() => {});
    };
  }
}
