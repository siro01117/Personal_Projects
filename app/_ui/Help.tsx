"use client";

// 모듈마다 오른쪽 아래에 떠 있는 도움말 (docs/에이전트-연결.md 4장). Shell 한 곳에서 주소로 모듈을 정해 그린다 — 모듈 화면은 건드리지 않는다.
// ? 단추 → 팝업(종이색 라운드, 폭 360 — 폰은 아래 시트). 바깥 누르기 · Esc 로 닫힘. 내용은 그 모듈 것만(lib/help.ts), 세 묶음:
// 이 화면(조작) · 에이전트에게(누르면 복사 + 쓰는 도구 이름) · 연결(토큰이 없으면 설정으로 가는 단추, 있으면 마지막 사용).
// 자리는 CSS 가 정한다(좌표 계산 없음) — 다른 플로팅과 겹치지 않게 옮기는 것도 CSS(globals.css 의 도움말 절).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { askText, HELP, helpKeyOf, opsFor, type HelpKey, type HelpTopic } from "../../lib/help";
import { AGENT_PATH, type TokenRow } from "../../lib/tokens";
import { seenAgo } from "../_logic/views";
import { viewCss } from "../_logic/zoom";
import { useApp } from "./AppContext";
import { Presence } from "./motion/Presence";
import { useToast } from "./Toast";

/** 이 폭 이하면 아래 시트 (앱의 폰 폭과 같다) */
const PHONE_MAX = 760;

/** 연결 한 줄: 토큰이 없으면 null (단추를 그린다) */
export function connectionLine(tokens: readonly TokenRow[], now: Date): string | null {
  if (tokens.length === 0) return null;
  const last = tokens.reduce<string | null>((a, t) => (t.last_used_at && (!a || t.last_used_at > a) ? t.last_used_at : a), null);
  return last ? `연결됨 · 마지막 사용 ${seenAgo(last, now)}` : `토큰 ${tokens.length}개 · 아직 쓰지 않음`;
}

export function HelpButton() {
  const pathname = usePathname();
  const key = helpKeyOf(pathname);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);

  // 다른 화면으로 가면 닫는다
  useEffect(() => setOpen(false), [pathname]);

  if (!key) return null;
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className="help-fab"
        data-help-open=""
        aria-label="도움말"
        title="도움말"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSheet(viewCss().w <= PHONE_MAX);
          setOpen(!open);
        }}
      >
        ?
      </button>
      <Presence>{open && sheet && <div className="scrim" onClick={close} />}</Presence>
      <Presence>{open && <HelpPop key={key} id={key} sheet={sheet} onClose={close} />}</Presence>
    </>
  );
}

/** rest: Presence 가 나가는 동안 붙이는 data-leaving · inert */
function HelpPop({ id, sheet, onClose, ...rest }: { id: HelpKey; sheet: boolean; onClose: () => void }) {
  const { src, href } = useApp();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  /** undefined = 읽는 중 · null = 못 읽음(연결 줄을 비운다) */
  const [tokens, setTokens] = useState<TokenRow[] | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    src.tokens.list().then(
      (t) => alive && setTokens(t),
      () => alive && setTokens(null),
    );
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!ref.current || ref.current.contains(t)) return;
      // 여는 단추를 다시 누르면 그 단추가 닫는다
      if (t?.closest?.("[data-help-open]")) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const topic = HELP[id];
  const copy = (ask: string) => {
    const text = askText(topic, ask, window.location.href);
    const no = () => toast("복사하지 못했습니다. 직접 옮겨 적으세요");
    if (!navigator.clipboard) return void no();
    navigator.clipboard.writeText(text).then(() => toast("복사했습니다"), no);
  };

  return (
    <div ref={ref} className={sheet ? "sheet help-sheet" : "help-pop"} role="dialog" aria-label={`${topic.title} 도움말`} {...rest}>
      {sheet && <span className="grab" />}
      <HelpBody topic={topic} phone={sheet} onCopy={copy}>
        {tokens === undefined || tokens === null ? null : (
          <Connection line={connectionLine(tokens, new Date())} settingsHref={id === "settings" ? null : href(AGENT_PATH)} onGo={onClose} />
        )}
      </HelpBody>
    </div>
  );
}

/** 팝업 안: 이름 · 이 화면 · 에이전트에게 · (연결 — children). phone 이면 키보드 · 마우스로만 되는 조작 줄을 뺀다 */
export function HelpBody({ topic, phone = false, onCopy, children }: { topic: HelpTopic; phone?: boolean; onCopy: (ask: string) => void; children?: React.ReactNode }) {
  return (
    <div className="help-in">
      <h2>{topic.title}</h2>
      <section>
        <h3>이 화면</h3>
        <ul className="help-ops">
          {opsFor(topic, phone).map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      </section>
      {topic.asks.length > 0 && (
        <section>
          <h3>에이전트에게</h3>
          <ul className="help-asks">
            {topic.asks.map((a) => (
              <li key={a}>
                <button type="button" title="복사" onClick={() => onCopy(a)}>
                  {a}
                </button>
              </li>
            ))}
          </ul>
          <p className="help-tools num">{topic.tools.join(" · ")}</p>
        </section>
      )}
      {children}
    </div>
  );
}

/** 연결: 토큰이 없으면 설정으로 가는 단추(설정 화면에서는 생략), 있으면 한 줄 */
export function Connection({ line, settingsHref, onGo }: { line: string | null; settingsHref: string | null; onGo?: () => void }) {
  if (line === null && settingsHref === null) return null;
  return (
    <section className="help-conn">
      <h3>연결</h3>
      {line === null ? (
        <Link className="btn" href={settingsHref!} onClick={onGo}>
          에이전트 연결
        </Link>
      ) : settingsHref === null ? (
        <p>{line}</p>
      ) : (
        <Link className="help-line" href={settingsHref} onClick={onGo}>
          {line}
        </Link>
      )}
    </section>
  );
}
