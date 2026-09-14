import { HEADER_HEIGHT, NODE_PADDING, NODE_WIDTH, ROW_HEIGHT, nodeHeight } from '~/utils/erd-graph'
import type { ErdEdge, ErdNodeData } from '~/utils/erd-graph'

/**
 * The ER diagram as a picture that leaves the app.
 *
 * Vue Flow draws the diagram out of DOM nodes and one SVG for the edges, and
 * nothing of that survives being copied out of the window. So the export draws
 * the same boxes again, by hand, into one self-contained SVG: the same widths
 * and row heights as `ErdTableNode.vue` uses, the positions the tables were
 * at — dagre's or the user's — and a line per key from column row to column
 * row. No stylesheet, no font file, no reference to anything outside the file,
 * so the result opens the same in a browser, an image viewer or a wiki.
 */

/** The colours the picture is drawn in: the app's tokens, read at export time. */
export interface ErdTheme {
  bg: string
  surface: string
  raised: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  accent: string
  accentBright: string
  warning: string
  fontSans: string
  fontMono: string
}

/*
 * The dark theme's values, for the case where the tokens cannot be read: an
 * export from a context with no stylesheet still comes out looking like the
 * app rather than in black and white.
 */
export const FALLBACK_THEME: ErdTheme = {
  bg: '#0d1120',
  surface: '#141a2c',
  raised: '#1d2540',
  border: '#222b45',
  borderStrong: '#33406a',
  text: '#e8ecf6',
  textMuted: '#98a2c0',
  textFaint: '#66708e',
  accent: '#8b5cf6',
  accentBright: '#a78bfa',
  warning: '#f5b14c',
  fontSans: '"Inter", ui-sans-serif, system-ui, "Segoe UI", sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
}

/** Which custom property each colour comes from; see `main.css`. */
const TOKENS: Record<keyof ErdTheme, string> = {
  bg: '--app-bg',
  surface: '--app-surface',
  raised: '--app-surface-raised',
  border: '--app-border',
  borderStrong: '--app-border-strong',
  text: '--app-text',
  textMuted: '--app-text-muted',
  textFaint: '--app-text-faint',
  accent: '--app-accent',
  accentBright: '--app-accent-bright',
  warning: '--app-warning',
  fontSans: '--font-sans',
  fontMono: '--font-mono',
}

/**
 * The current theme's colours, so a picture exported from the light theme is
 * light. Anything the stylesheet does not define falls back to the dark set.
 */
export function readErdTheme(): ErdTheme {
  if (typeof document === 'undefined') return FALLBACK_THEME

  const style = getComputedStyle(document.documentElement)
  const theme = { ...FALLBACK_THEME }

  for (const key of Object.keys(TOKENS) as (keyof ErdTheme)[]) {
    const value = style.getPropertyValue(TOKENS[key]).trim()
    if (value) theme[key] = value
  }

  return theme
}

/**
 * A box as the export needs it: where it is and what it lists. Both the built
 * `ErdNode` and Vue Flow's live `GraphNode` fit, so the picture can be drawn
 * from whichever the caller has — the live one carries the dragged positions.
 */
export interface DrawnNode {
  id: string
  position: { x: number, y: number }
  data: ErdNodeData
  /** Measured on screen, when the box has been; the stated size otherwise. */
  dimensions?: { width: number, height: number }
}

/** Room around the picture, so the outermost boxes do not touch the edge. */
const MARGIN = 24

/** The largest bitmap side Chromium will still rasterise. */
const MAX_CANVAS_SIDE = 16384

/*
 * Text is not measured — there is no canvas to measure it on in a unit test,
 * and a browser's answer would name a font the file's reader may not have —
 * so names are trimmed to a width estimated per character, and the box clips
 * whatever the estimate lets through.
 */
const SANS_CHAR = 6.6
const MONO_CHAR = 6.1
const ROW_INSET = 8
const MARKER_WIDTH = 20

function escape(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fit(text: string, maxWidth: number, charWidth: number) {
  const room = Math.max(1, Math.floor(maxWidth / charWidth))
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function widthOf(node: DrawnNode) {
  return node.dimensions?.width || NODE_WIDTH
}

function heightOf(node: DrawnNode) {
  return node.dimensions?.height || nodeHeight(node.data.columns.length)
}

/** The vertical centre of a column's row, which is where its key lines meet it. */
function rowCentre(node: DrawnNode, column: string, top: number) {
  const index = node.data.columns.findIndex((candidate) => candidate.name === column)
  // A column the snapshot does not list — a key into a truncated table — meets
  // the box at its title bar rather than nowhere.
  if (index < 0) return top + HEADER_HEIGHT / 2

  return top + HEADER_HEIGHT + NODE_PADDING / 2 + index * ROW_HEIGHT + ROW_HEIGHT / 2
}

/**
 * The whole picture as an SVG document. Pure: what comes out depends only on
 * the boxes, the keys and the colours handed in.
 */
export function toSvg(nodes: DrawnNode[], edges: ErdEdge[], theme: ErdTheme = FALLBACK_THEME): string {
  if (!nodes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${MARGIN * 2}" height="${MARGIN * 2}" viewBox="0 0 ${MARGIN * 2} ${MARGIN * 2}"><rect width="100%" height="100%" fill="${escape(theme.bg)}"/></svg>`
  }

  // The picture starts at its own top left, wherever the boxes were placed.
  const minX = Math.min(...nodes.map((node) => node.position.x)) - MARGIN
  const minY = Math.min(...nodes.map((node) => node.position.y)) - MARGIN
  const maxX = Math.max(...nodes.map((node) => node.position.x + widthOf(node))) + MARGIN
  const maxY = Math.max(...nodes.map((node) => node.position.y + heightOf(node))) + MARGIN

  const width = Math.ceil(maxX - minX)
  const height = Math.ceil(maxY - minY)

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escape(theme.fontSans)}" font-size="12">`,
    `<defs><marker id="erd-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">`,
    `<path d="M0 0.5 L7 4 L0 7.5 Z" fill="${escape(theme.borderStrong)}" stroke="${escape(theme.borderStrong)}" stroke-linejoin="round"/>`,
    `</marker></defs>`,
    `<rect width="100%" height="100%" fill="${escape(theme.bg)}"/>`,
  )

  // Edges first, so a line that crosses a box passes behind it as on screen.
  for (const edge of edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target || !edge.data) continue

    const sx = source.position.x - minX + widthOf(source)
    const sy = rowCentre(source, edge.data.column, source.position.y - minY)
    const tx = target.position.x - minX
    const ty = rowCentre(target, edge.data.refColumn, target.position.y - minY)

    // A curve that leaves to the right and arrives from the left, however the
    // boxes stand: a target behind the source gets a wider loop rather than
    // a line drawn backwards through both.
    const reach = Math.max(40, Math.abs(tx - sx) / 2)
    const d = `M${round(sx)} ${round(sy)} C${round(sx + reach)} ${round(sy)}, ${round(tx - reach)} ${round(ty)}, ${round(tx)} ${round(ty)}`

    parts.push(
      `<path d="${d}" fill="none" stroke="${escape(theme.borderStrong)}" stroke-width="1.5" marker-end="url(#erd-arrow)"><title>${escape(String(edge.label ?? ''))}</title></path>`,
    )
  }

  nodes.forEach((node, index) => {
    const x = round(node.position.x - minX)
    const y = round(node.position.y - minY)
    const w = widthOf(node)
    const h = heightOf(node)
    const clip = `erd-clip-${index}`
    const focused = node.data.focused
    const header = focused ? theme.accent : theme.raised

    parts.push(
      `<g transform="translate(${x} ${y})">`,
      `<clipPath id="${clip}"><rect width="${w}" height="${h}" rx="6"/></clipPath>`,
      `<g clip-path="url(#${clip})">`,
      `<rect width="${w}" height="${h}" fill="${escape(theme.surface)}"/>`,
      // The focused table's bar is the accent at the same tint the app draws
      // it, as a fill opacity rather than a colour with an alpha channel: not
      // every SVG reader understands the modern colour syntax the token uses.
      `<rect width="${w}" height="${HEADER_HEIGHT}" fill="${escape(header)}"${focused ? ' fill-opacity="0.16"' : ' fill-opacity="0.6"'}/>`,
      `<line x1="0" y1="${HEADER_HEIGHT}" x2="${w}" y2="${HEADER_HEIGHT}" stroke="${escape(theme.border)}"/>`,
    )

    const count = String(node.data.columns.length)
    const countWidth = count.length * SANS_CHAR
    const kindMark = node.data.object.kind === 'view' ? '◇' : '▤'

    parts.push(
      `<text x="${ROW_INSET}" y="${HEADER_HEIGHT / 2}" dominant-baseline="central" fill="${escape(theme.textMuted)}" font-size="11">${kindMark}</text>`,
      `<text x="${ROW_INSET + 16}" y="${HEADER_HEIGHT / 2}" dominant-baseline="central" fill="${escape(theme.text)}" font-weight="500">${escape(fit(node.data.label, w - ROW_INSET * 2 - 16 - countWidth - 8, SANS_CHAR))}</text>`,
      `<text x="${w - ROW_INSET}" y="${HEADER_HEIGHT / 2}" dominant-baseline="central" text-anchor="end" fill="${escape(theme.textFaint)}" font-size="11">${count}</text>`,
    )

    node.data.columns.forEach((column, row) => {
      const cy = HEADER_HEIGHT + NODE_PADDING / 2 + row * ROW_HEIGHT + ROW_HEIGHT / 2
      const typeText = fit(column.type, w * 0.4, MONO_CHAR)
      const typeWidth = typeText.length * MONO_CHAR
      const nameRoom = w - ROW_INSET * 2 - MARKER_WIDTH - typeWidth - 8

      const marker = column.primaryKey
        ? `<text x="${ROW_INSET}" y="${cy}" dominant-baseline="central" fill="${escape(theme.warning)}" font-size="8" font-weight="600">PK</text>`
        : column.foreignKey
          ? `<text x="${ROW_INSET}" y="${cy}" dominant-baseline="central" fill="${escape(theme.accentBright)}" font-size="8" font-weight="600">FK</text>`
          : `<circle cx="${ROW_INSET + 3}" cy="${cy}" r="1.5" fill="${escape(theme.textFaint)}"/>`

      parts.push(
        marker,
        `<text x="${ROW_INSET + MARKER_WIDTH}" y="${cy}" dominant-baseline="central" fill="${escape(theme.text)}"${column.primaryKey ? ' font-weight="500"' : ''}>${escape(fit(column.name, nameRoom, SANS_CHAR))}</text>`,
        `<text x="${w - ROW_INSET}" y="${cy}" dominant-baseline="central" text-anchor="end" fill="${escape(theme.textFaint)}" font-family="${escape(theme.fontMono)}" font-size="10">${escape(typeText)}</text>`,
      )
    })

    parts.push(
      '</g>',
      `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="6" fill="none" stroke="${escape(focused ? theme.accent : theme.borderStrong)}"${focused ? ' stroke-opacity="0.6"' : ''}/>`,
      '</g>',
    )
  })

  parts.push('</svg>')

  return parts.join('\n')
}

/**
 * The SVG rasterised, as the base64 body of a PNG. Drawn at twice its size so
 * the text stays crisp wherever the file is pasted, on a background the
 * theme's, since the SVG's own is lost to the transparent canvas otherwise.
 * Browser only: it goes through an image element and a canvas.
 */
export async function svgToPng(svg: string, background: string, scale = 2): Promise<string> {
  const image = new Image()

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The diagram could not be drawn as an image'))
    // A data URL rather than a blob one: nothing to revoke afterwards.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })

  // A canvas past Chromium's side limit draws nothing and says nothing; a big
  // schema is exported at whatever scale still fits rather than as a blank.
  const longest = Math.max(image.naturalWidth, image.naturalHeight, 1)
  const fitted = Math.min(scale, MAX_CANVAS_SIDE / longest)

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(image.naturalWidth * fitted)
  canvas.height = Math.ceil(image.naturalHeight * fitted)

  const context = canvas.getContext('2d')
  if (!context) throw new Error('The diagram could not be drawn as an image')

  context.fillStyle = background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
}
