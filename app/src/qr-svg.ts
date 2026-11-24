import { encode } from 'uqr'

export interface QrSvgModel {
  readonly size: number
  readonly moduleCount: number
  readonly pathData: string
}

/**
 * Encodes a URI (such as Telegram's `tg://login?token=...`) into a compact
 * single-path SVG model with an ISO-standard 4-module quiet zone.
 */
export function buildQrSvgModel(data: string): QrSvgModel {
  const qr = encode(data, { ecc: 'M', border: 4 })
  const size = qr.size
  let moduleCount = 0
  const commands: string[] = []

  for (let y = 0; y < size; y++) {
    const row = qr.data[y]!
    let x = 0
    while (x < size) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (x < size && row[x]) {
        x++
      }
      const run = x - start
      moduleCount += run
      commands.push(`M${start} ${y}h${run}v1h-${run}z`)
    }
  }

  return {
    size,
    moduleCount,
    pathData: commands.join(''),
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Creates a safe DOM SVG element without innerHTML.
 */
export function createQrSvgElement(data: string, ariaLabel = 'Telegram login QR code'): SVGSVGElement {
  const model = buildQrSvgModel(data)
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${model.size} ${model.size}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', ariaLabel)
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.classList.add('qr-svg')

  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('width', String(model.size))
  bg.setAttribute('height', String(model.size))
  bg.classList.add('qr-svg-bg')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', model.pathData)
  path.classList.add('qr-svg-fg')

  svg.append(bg, path)
  return svg
}
