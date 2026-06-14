import type { DashboardState } from '../../types';

/** Drill-down for the main lane: the latest repo's push:main last-green commit
 *  + a discrete green/red/grey sparkline of the recent main-commit series. */
export function MainPanel({ repos }: { repos: DashboardState['repos'] }) {
  const lh = repos.map((r) => r.laneHealth).find((h) => h?.mainSeries?.length) ?? repos[0]?.laneHealth;
  if (!lh || !lh.mainSeries?.length) return <p className="spine-panel-empty">main: no signal yet.</p>;
  const color = (ok: boolean | null) => ok == null ? 'var(--muted, #888)' : ok ? 'var(--done)' : 'var(--fail)';
  return (
    <div className="spine-main-panel">
      <div className="spine-main-lastgreen">
        {lh.lastGreenSha
          ? <>last green <code>{lh.lastGreenSha.slice(0, 7)}</code>{lh.lastGreenAt ? ` · ${new Date(lh.lastGreenAt).toLocaleString()}` : ''}</>
          : 'no green commit in window'}
      </div>
      <div className="spine-main-spark" aria-label="recent main-branch CI results, oldest to newest">
        {lh.mainSeries.map((p, i) => (
          <span key={i} data-testid="spine-main-spark-bar" className="spine-main-spark-bar"
            style={{ background: color(p.ok) }} title={p.ok == null ? 'no signal' : p.ok ? 'green' : 'red'} />
        ))}
      </div>
    </div>
  );
}
