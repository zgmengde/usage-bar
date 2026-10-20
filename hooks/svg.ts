// 桌面版的画法：一行画成一张 SVG。文字和底色用 prefers-color-scheme 跟随深浅主题。
import { colorFor, GAP, ICON_W, noise, textWidth } from './model'
import type { Config, IconName, Item, Row } from './model'

export const ROW_H = 26
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif"
const BAR_H = 10
const CELL = 3

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 图标都是 14×14 的线条图，用 currentColor 描边，颜色由外层 <g> 给
const ICON_PATHS: Record<IconName, string> = {
  clock: '<circle cx="7" cy="7" r="6"/><path d="M7 3.5V7l2.5 1.5"/>',
  calendar: '<rect x="1" y="2.5" width="12" height="10.5" rx="2"/><path d="M1 6h12M4.5 1v3M9.5 1v3"/>',
  flame: '<path d="M7 1c1 2.5 4 4 4 7.5A4 4 0 0 1 3 8.5c0-1.5.8-2.6 1.6-3.3.2 1.3.9 2 1.6 2.3C6.4 5 6.4 3 7 1z"/>',
  flake: '<path d="M7 1v12M1.8 4l10.4 6M1.8 10l10.4-6"/>',
  layers: '<path d="M7 1.5l5.5 2.8L7 7.1 1.5 4.3z"/><path d="M1.5 7l5.5 2.8L12.5 7"/><path d="M1.5 9.7l5.5 2.8 5.5-2.8"/>',
  coin: '<circle cx="7" cy="7" r="6"/><path d="M8.8 4.8C8.4 4.2 7.7 4 7 4c-1.1 0-2 .6-2 1.5S5.9 6.8 7 7s2 .6 2 1.5S8.1 10 7 10c-.8 0-1.5-.3-1.9-.9M7 3v1M7 10v1"/>',
  limit: '<path d="M7 1.5l5.5 10h-11z"/><path d="M7 5.5v3M7 10.2v.1"/>',
  bolt: '<path d="M8 1L3 8h4l-1 5 5-7H7z"/>',
  hourglass: '<path d="M3 1.5h8M3 12.5h8M4 1.5c0 3 3 3.5 3 5.5s-3 2.5-3 5.5M10 1.5c0 3-3 3.5-3 5.5s3 2.5 3 5.5"/>',
  target: '<circle cx="7" cy="7" r="6"/><circle cx="7" cy="7" r="3"/><circle cx="7" cy="7" r=".6"/>',
  cross: '<circle cx="7" cy="7" r="6"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8L4.8 9.2"/>',
}

function icon(name: IconName, x: number, color: string | undefined): string {
  const stroke = color ? ` stroke="${color}"` : ' class="mute-s"'
  return `<g transform="translate(${x},6)" fill="none"${stroke} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</g>`
}

function bar(x: number, w: number, percent: number, color: string, style: Config['bar']): string {
  const y = (ROW_H - BAR_H) / 2
  const fill = Math.round((w * Math.max(0, Math.min(100, percent))) / 100)
  const parts = [`<rect class="track" x="${x}" y="${y}" width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/>`]
  if (style === 'solid') {
    if (fill > 0) parts.push(`<rect x="${x}" y="${y}" width="${Math.max(fill, BAR_H)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>`)
    return parts.join('')
  }
  // 像素点阵：越靠右越密
  // 有用量就至少画一列点
  const cols = percent > 0 ? Math.max(1, Math.floor(fill / CELL)) : 0
  const rows = Math.floor(BAR_H / CELL)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.75 + 0.25 * Math.pow(c / Math.max(1, cols), 0.8)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect x="${x + c * CELL + 0.5}" y="${y + r * CELL + 0.5}" width="2" height="2"/>`)
    }
  }
  parts.push(`<g fill="${color}">${dots.join('')}</g>`)
  return parts.join('')
}

// width 是整行可用宽度：画布铺满整行，内容靠左，这样外层怎么排都不会被居中
// width 是画布宽度；content 是几行里最宽的内容宽度，内容按它在画布里居中，
// 几行用同一个值，列才不会错开。不传时按这一行自己的内容算
export function rowSvg(row: Row, cfg: Config, width = 0, content?: number): { source: string; width: number } {
  const out: string[] = []
  let x = 2
  row.items.forEach((it, i) => {
    if (i > 0) x += GAP
    const start = x
    const tone = it.color ?? (it.percent !== null ? colorFor(cfg, it.percent) : undefined)
    if (cfg.icons) {
      out.push(icon(it.icon, x, it.color))
      x += ICON_W
    }
    out.push(`<text class="mute" x="${x}" y="17.5" font-size="13">${xml(it.label)}</text>`)
    x += textWidth(it.label) + 6
    if (cfg.bar !== 'none' && it.percent !== null && tone) {
      out.push(bar(x, row.barW, it.percent, tone, cfg.bar))
      x += row.barW + 8
    }
    // 数值和进度条同色；第二行按阈值另给 valueColor
    const valueTone = it.color ?? it.valueColor ?? tone
    const valueFill = valueTone ? ` fill="${valueTone}"` : ' class="main"'
    out.push(`<text x="${x}" y="17.5" font-size="13" font-weight="600"${valueFill}>${xml(it.value)}</text>`)
    x += textWidth(it.value, 13, 600)
    if (it.detail) {
      x += 8
      out.push(`<text class="mute" x="${x}" y="17.5" font-size="12">${xml(it.detail)}</text>`)
      x += textWidth(it.detail, 12)
    }
    // 两行对齐时，这一项至少占到这一列的宽度
    const slot = row.slots?.[i]
    if (slot !== undefined) x = Math.max(x, start + slot)
  })
  const inner = Math.max(content ?? 0, Math.ceil(x) + 2)
  const w = Math.max(inner, Math.floor(width))
  // 估算的画布宽度通常比内容宽；多出来的平分到两边，左右留白才一样
  const dx = Math.floor((w - inner) / 2)
  const body = dx > 0 ? `<g transform="translate(${dx},0)">${out.join('')}</g>` : out.join('')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}" font-family="${FONT}">` +
    '<style>.main{fill:#1f1f1f}.mute{fill:#6f6f6f}.mute-s{stroke:#6f6f6f}.track{fill:rgba(0,0,0,.06)}' +
    '@media (prefers-color-scheme: dark){.main{fill:#ececec}.mute{fill:#8a8a8a}.mute-s{stroke:#8a8a8a}.track{fill:rgba(255,255,255,.07)}}</style>' +
    body +
    '</svg>'
  return { source, width: w }
}

// 读屏用的一句话
export function rowAlt(row: Row): string {
  return row.items.map(it => [it.label, it.value, it.detail].filter(Boolean).join(' ')).join(', ')
}
