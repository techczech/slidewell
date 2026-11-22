import type { Stats } from '../../preload'

function fmt(n: number): string {
  return n.toLocaleString('en-GB')
}

function StatBar({ value, max, label, suffix }: { value: number; max: number; label: string; suffix: string }): JSX.Element {
  const pct = max > 0 && value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div className="statbar-row">
      <span className="statbar-label">{label}</span>
      <span className="statbar-track">
        <span className="statbar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="statbar-val">{suffix}</span>
    </div>
  )
}

export function StatsPanel({ stats: s, onClose }: { stats: Stats | null; onClose: () => void }): JSX.Element {
  const maxYearDecks = s ? Math.max(1, ...s.byYear.map((b) => b.decks)) : 1
  const maxYearSlides = s ? Math.max(1, ...s.byYear.map((b) => b.slides)) : 1
  const maxMonth = s ? Math.max(1, ...s.byMonthOfYear.map((b) => b.decks)) : 1
  const maxSize = s ? Math.max(1, ...s.sizeBuckets.map((b) => b.decks)) : 1
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>📊 PowerPoint Through the Ages</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        {!s ? (
          <div className="results-head">crunching the numbers…</div>
        ) : (
          <div className="stats-body">
            <p className="stats-headline">
              <b>{fmt(s.totalDecks)} presentations</b> ({fmt(s.distinctTalks)} distinct talks) · <b>{fmt(s.totalSlides)} slides</b> · {fmt(s.totalImages)} images
              {s.firstYear && s.lastYear ? ` · ${s.firstYear}–${s.lastYear} · ${s.yearsActive} years` : ''}
            </p>
            <p className="stats-sub">
              avg <b>{s.avgSlidesPerDeck}</b> slides/presentation · median <b>{s.medianSlidesPerDeck}</b>
              {s.undatedDecks ? ` · ${s.undatedDecks} undated` : ''}
              {s.dateConfidence.uncertainDecks.length ? ` · ⚠️ ${s.dateConfidence.uncertainDecks.length} unreliable (re-save) dates` : ''}
            </p>
            {s.lifetimeSlidesShown > 0 && (
              <p className="stats-funfact">
                🎬 ≈ <b>{fmt(s.lifetimeSlidesShown)} slides shown on screen</b> across your career — every version / re-save counts (slide-library masters excluded; a floor).
              </p>
            )}
            {s.masterDeckCount > 0 && (
              <p className="stats-note">
                +{s.masterDeckCount} master/library presentation{s.masterDeckCount === 1 ? '' : 's'} ({fmt(s.masterSlides)} slides) excluded from slide stats.
              </p>
            )}

            <h3>🗓️ Presentations per year</h3>
            <div className="statbars">
              {s.byYear.map((y) => (
                <StatBar key={y.year} value={y.decks} max={maxYearDecks} label={String(y.year)} suffix={`${y.decks} · ${fmt(y.slides)} sl`} />
              ))}
            </div>

            <h3>📈 Slides per year</h3>
            <div className="statbars">
              {s.byYear.map((y) => (
                <StatBar key={y.year} value={y.slides} max={maxYearSlides} label={String(y.year)} suffix={fmt(y.slides)} />
              ))}
            </div>

            <h3>🌦️ Seasonality</h3>
            <div className="statbars">
              {s.byMonthOfYear.map((m) => (
                <StatBar key={m.month} value={m.decks} max={maxMonth} label={m.label} suffix={String(m.decks)} />
              ))}
            </div>

            <h3>📐 Presentation sizes</h3>
            <div className="statbars">
              {s.sizeBuckets.map((b) => (
                <StatBar key={b.label} value={b.decks} max={maxSize} label={b.label} suffix={`${b.decks} presentations`} />
              ))}
            </div>

            <div className="stats-cols">
              <div>
                <h3>🏷️ Top categories</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Category</th><th>Presentations</th><th>Slides</th></tr>
                  </thead>
                  <tbody>
                    {s.topCategoriesByDecks.slice(0, 12).map((c) => (
                      <tr key={c.category}><td>{c.category}</td><td>{c.decks}</td><td>{fmt(c.slides)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>🔥 Busiest months</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Month</th><th>Presentations</th><th>Slides</th></tr>
                  </thead>
                  <tbody>
                    {s.busiestMonths.map((m) => (
                      <tr key={m.key}><td>{m.label}</td><td>{m.decks}</td><td>{fmt(m.slides)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <h3>🏆 Superlatives</h3>
            <ul className="stats-sups">
              {s.superlatives.mostProlificYear && <li>Most prolific year: <b>{s.superlatives.mostProlificYear.year}</b> ({s.superlatives.mostProlificYear.decks} presentations)</li>}
              {s.superlatives.mostSlidesYear && <li>Most slides in a year: <b>{s.superlatives.mostSlidesYear.year}</b> ({fmt(s.superlatives.mostSlidesYear.slides)} slides)</li>}
              {s.superlatives.busiestMonth && <li>Busiest month: <b>{s.superlatives.busiestMonth.label}</b> ({s.superlatives.busiestMonth.decks} presentations)</li>}
              {s.superlatives.biggestDeck && (
                <li>Biggest presentation: <b>{s.superlatives.biggestDeck.title}</b> — {fmt(s.superlatives.biggestDeck.slides)} slides{s.superlatives.biggestDeck.year ? ` (${s.superlatives.biggestDeck.year})` : ''}</li>
              )}
              {s.superlatives.firstYearAvg && s.superlatives.lastYearAvg && (
                <li>
                  Presentation-size trend: {s.superlatives.firstYearAvg.avg}/presentation in {s.superlatives.firstYearAvg.year} → {s.superlatives.lastYearAvg.avg} in {s.superlatives.lastYearAvg.year}
                </li>
              )}
            </ul>

            {s.duplicateClusters.length > 0 && (
              <>
                <h3>🔁 Most-duplicated talks</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Talk</th><th>Files</th><th>Slides</th><th>Earliest</th></tr>
                  </thead>
                  <tbody>
                    {s.duplicateClusters.slice(0, 12).map((c) => (
                      <tr key={c.key}><td>{c.title}</td><td>{c.deckCount}</td><td>{fmt(c.maxSlides)}</td><td>{c.earliestDate ? c.earliestDate.slice(0, 10) : '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
