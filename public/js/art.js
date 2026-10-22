// 空状态插画：与 logo 同风格的渐变线条，圆形底 + 图标 + 点缀
import { ICON_PATHS } from "./icons.js";

const GRAD = `<defs><linearGradient id="artg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6157ff"/><stop offset=".5" stop-color="#2f7bff"/><stop offset="1" stop-color="#14c8ff"/></linearGradient></defs>`;
const SPARKS = `<path d="M122 20c1 5 4 8 9 9-5 1-8 4-9 9-1-5-4-8-9-9 5-1 8-4 9-9Z" fill="#7fe3ff"/><circle cx="36" cy="32" r="3" fill="#9db4ff"/><circle cx="132" cy="88" r="2.5" fill="#6157ff" opacity=".5"/>`;

export function emptyArt(glyph) {
  return `<svg class="zero-art" viewBox="0 0 160 120" aria-hidden="true">${GRAD}
    <circle cx="80" cy="62" r="46" fill="url(#artg)" opacity=".09"/>
    <circle cx="80" cy="62" r="31" style="fill:var(--panel)" stroke="url(#artg)" stroke-opacity=".28" stroke-width="1.5"/>
    <g transform="translate(62 44) scale(1.5)" fill="none" stroke="url(#artg)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[glyph] ?? ICON_PATHS.inbox}</g>
    ${SPARKS}</svg>`;
}

// 收件箱清空：信封 + 勾
export const inboxZero = `<svg class="zero-art" viewBox="0 0 160 120" aria-hidden="true">${GRAD}
<circle cx="80" cy="62" r="46" fill="url(#artg)" opacity=".1"/><rect x="42" y="38" width="76" height="52" rx="12" fill="none" stroke="url(#artg)" stroke-width="5"/>
<path d="m54 52 12 16 14-12 14 12 12-16" fill="none" stroke="url(#artg)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${SPARKS}</svg>`;
