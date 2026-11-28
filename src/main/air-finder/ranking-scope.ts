import { slidePresentationId } from './presentation-id'

export const FINDER_RANK_LIMIT = 40

export type FinderRankingScope = {
  presentations: readonly string[]
  wellIds: readonly string[]
  excludePresentation: string | null
}

export function finderAllows(scope: FinderRankingScope): (id: string) => boolean {
  const presentations = new Set(scope.presentations)
  const wells = new Set(scope.wellIds)
  return (id) => {
    const presentation = slidePresentationId(id)
    return presentation ? presentation !== scope.excludePresentation && presentations.has(presentation) : wells.has(id)
  }
}
