const MAX_BYTES = 50 * 1024 * 1024
const entities = ['MANIFOLD_SOLID_BREP', 'ADVANCED_FACE', 'CYLINDRICAL_SURFACE', 'PLANE', 'EDGE_CURVE', 'CLOSED_SHELL']

export function summarizeStep(name, data) {
  try {
    if (!/\.(step|stp)$/i.test(String(name)) || data == null) return ''
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const source = bytes.subarray(0, MAX_BYTES).toString('utf8')
    if (!/ISO-10303-21\s*;/i.test(source)) return 'STEP summary: not an ISO 10303-21 file.'
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const lines = [`STEP summary (${name})${bytes.length > MAX_BYTES ? ' [truncated at 50 MiB]' : ''}:`]
    const header = text.match(/HEADER\s*;([\s\S]*?)ENDSEC\s*;/i)?.[1] ?? ''
    for (const key of ['FILE_NAME', 'FILE_DESCRIPTION', 'FILE_SCHEMA']) {
      const value = header.match(new RegExp(`\\b${key}\\s*\\(([\\s\\S]*?);`, 'i'))?.[1]
      if (value) lines.push(`${key}: ${value.replace(/\s+/g, ' ').slice(0, 500)}`)
    }
    const products = []
    for (const match of text.matchAll(/\bPRODUCT\s*\(\s*'(?:[^']|'')*'\s*,\s*'((?:[^']|'')*)'/gi)) {
      if (products.length < 20) products.push(match[1].replace(/''/g, "'"))
    }
    if (products.length) lines.push(`Products: ${products.join(', ').slice(0, 1000)}`)
    const units = []
    for (const match of text.matchAll(/#[0-9]+\s*=([^;]+);/g)) {
      if (!/\bLENGTH_UNIT\s*\(/i.test(match[1])) continue
      for (const unit of match[1].matchAll(/\b(?:SI_UNIT|CONVERSION_BASED_UNIT)\s*\(([^;]{0,300}?)\)/gi)) {
        if (units.length < 10) units.push(unit[0])
      }
    }
    lines.push(`Length unit: ${units.join('; ') || 'unspecified'}`)
    const low = [Infinity, Infinity, Infinity]
    const high = [-Infinity, -Infinity, -Infinity]
    let points = 0
    for (const match of text.matchAll(/\bCARTESIAN_POINT\s*\(\s*'(?:[^']|'')*'\s*,\s*\(([^()]+)\)\s*\)/gi)) {
      const xyz = match[1].split(',').map(value => Number(value.trim().replace(/[dD]/, 'e')))
      if (xyz.length !== 3 || !xyz.every(Number.isFinite)) continue
      points++
      xyz.forEach((value, index) => { low[index] = Math.min(low[index], value); high[index] = Math.max(high[index], value) })
    }
    if (points) lines.push(`CARTESIAN_POINT bounding box in file units: [${low.join(', ')}] to [${high.join(', ')}] (${points} points; control points, not exact solid bounds).`)
    lines.push(entities.map(key => `${key}: ${[...text.matchAll(new RegExp(`\\b${key}\\s*\\(`, 'gi'))].length}`).join('; '))
    lines.push('Cylindrical surfaces are only a hole/boss hint, not a hole count.')
    return lines.join('\n')
  } catch { return 'STEP summary unavailable.' }
}
