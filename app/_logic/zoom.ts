// 화면이 커지면 같이 커진다 (docs/공통.md 3장). 창 폭이 1,920 보다 넓으면 루트(html)에 CSS zoom 을 건다 — QHD(2,560) 1.333배 · 4K 2배(상한).
// 값은 <head> 의 인라인 스크립트(ZOOM_SCRIPT)가 첫 그림 전에 넣고 resize 때 고친다: html 의 style.zoom 과 --zoom.
//
// zoom 아래에서 값마다 좌표계가 다르다. 크롬 154(headless) · html{zoom:1.3333} · 창 2560×1440 에서 잰 것:
//   화면 px (zoom 이 곱해진 값 — 100px 상자가 133.33)
//     getBoundingClientRect · getClientRects · Range 의 rect · IntersectionObserver 의 rect
//     포인터 · 터치의 clientX/Y · pageX/Y · offsetX/Y, elementFromPoint(x, y) 가 받는 좌표
//     innerWidth/Height(2560 × 1440) · documentElement.clientWidth/Height · visualViewport
//     문서(창) 스크롤: scrollY · scrollBy · documentElement.scrollTop/scrollHeight
//     vh · vw · dvh 단위의 바탕(100vh = CSS 1440px → 화면 1920px 로 넘친다. % 와 inset:0 은 안 넘친다)
//     @media 의 폭(창 폭 2560 을 본다) · matchMedia
//   CSS px (zoom 전 — 100px 상자가 100)
//     style 에 쓰는 길이(left · top · width · transform — fixed left:300px 은 화면 400 에 선다) · getComputedStyle
//     offsetLeft/Top/Width/Height · clientWidth/Height · clientLeft/Top (루트 말고)
//     안쪽 스크롤 상자의 scrollTop · scrollHeight · scrollBy, ResizeObserver 의 contentRect
//     @container 의 폭(확대 전 폭을 본다 — 창 2560 이면 1920 일 때와 같은 분기)
// 그래서 화면 px 를 길이로 쓰거나(스타일에 넣기) CSS px 값(offset* · scrollTop · 상수)과 섞을 때는 toCss 로 나눈다.
// 화면 px 끼리 견주는 것(포인터가 rect 안인가 · elementFromPoint · 비율)은 그대로 둔다.

export const BASE_WIDTH = 1920;
export const ZOOM_MAX = 2;

/** 창 폭 → 배율. 1,920 이하는 1, 그 위로는 폭에 비례, 상한 2 */
export function zoomFor(width: number): number {
  if (!(width > BASE_WIDTH)) return 1;
  return Math.min(ZOOM_MAX, width / BASE_WIDTH);
}

/** <head> 에 그대로 넣는 스크립트. zoomFor 와 같은 식 — 1 이면 아무것도 남기지 않는다(1,920 이하는 전과 같은 문서) */
export const ZOOM_SCRIPT = `(function(){var d=document.documentElement;function f(){var w=window.innerWidth,z=w>${BASE_WIDTH}?Math.min(${ZOOM_MAX},w/${BASE_WIDTH}):1;if(z===1){d.style.removeProperty('zoom');d.style.removeProperty('--zoom')}else{d.style.setProperty('zoom',String(z));d.style.setProperty('--zoom',String(z))}}f();window.addEventListener('resize',f)})()`;

/** 지금 배율. --zoom(스크립트가 넣은 값), 없으면 루트의 계산값, 그것도 없으면 1 */
export function zoom(): number {
  if (typeof document === "undefined") return 1;
  const root = document.documentElement;
  const v = Number.parseFloat(root.style.getPropertyValue("--zoom"));
  if (v > 0) return v;
  const c = Number.parseFloat(String((getComputedStyle(root) as CSSStyleDeclaration & { zoom?: string }).zoom ?? ""));
  return c > 0 ? c : 1;
}

/** 화면 px → CSS px */
export function toCss(px: number, z: number = zoom()): number {
  return z === 1 ? px : px / z;
}

/** CSS px → 화면 px */
export function toScreen(px: number, z: number = zoom()): number {
  return z === 1 ? px : px * z;
}

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** 화면 px 로 잰 rect → CSS px */
export function rectToCss(r: Rect, z: number = zoom()): Rect {
  return { left: toCss(r.left, z), top: toCss(r.top, z), right: toCss(r.right, z), bottom: toCss(r.bottom, z), width: toCss(r.width, z), height: toCss(r.height, z) };
}

/** 요소의 자리 · 크기를 CSS px 로 (getBoundingClientRect ÷ zoom) */
export function rectCss(el: Element): Rect {
  return rectToCss(el.getBoundingClientRect());
}

/** 창 크기를 CSS px 로 — 폭은 스크롤바를 뺀 값. 반응형 분기(폰 · 넓은 화면)와 화면 안에 가두기에 쓴다 */
export function viewCss(): { w: number; h: number } {
  const z = zoom();
  return { w: toCss(document.documentElement.clientWidth, z), h: toCss(window.innerHeight, z) };
}
