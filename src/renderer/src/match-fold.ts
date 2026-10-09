// The fold under the "Looks related" band: how many cards show before "Show N more · meaning X and below".
export const RELATED_SHOWN = 10

export function relatedFold(related: Array<{ score?: { value: number } }>, shown = RELATED_SHOWN): { more: number; below: string } | null {
  if (related.length <= shown) return null
  const edge = related[shown - 1].score?.value ?? 0
  return { more: related.length - shown, below: (Math.round(edge * 100) / 100).toFixed(2) }
}
