import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { TILE_DEFINITIONS } from './StatusStrip';
import { METRIC_DEFINITIONS, SUBLINE_TERMS } from './definitions';

interface LegendPanelProps {
  open: boolean;
  onClose: () => void;
  /** Element to return focus to on close (the `?` header button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** A node circle exactly as the live MetroTrack renders it (same classes). */
function ExampleNode({ status, glyph }: { status: string; glyph: string }) {
  return (
    <span className={`node ${status}`}>
      <span className="c" aria-hidden="true">{glyph}</span>
    </span>
  );
}

function LegendRow({ example, children }: { example: ReactNode; children: ReactNode }) {
  return (
    <div className="legend-row">
      <span className="legend-ex">{example}</span>
      <span className="legend-text">{children}</span>
    </div>
  );
}

/** Mini queue-train car reusing the live `.car` classes. */
function ExampleCar({ cls, header, body }: { cls: string; header: string; body: string }) {
  return (
    <div className={`car ${cls}`}>
      <div className="car-header">{header}</div>
      <span className="car-numbers">{body}</span>
    </div>
  );
}

/** Mini Gantt bar row reusing the live `.g-row` / `.g-bar` classes. */
function ExampleBar({ kind, name, fillPct, time, band, tick, nameTitle }: {
  kind: string; name: string; fillPct: number; time: string;
  band?: [number, number]; tick?: number; nameTitle?: string;
}) {
  return (
    <li className={`g-row ${kind}`}>
      <span className="g-name" title={nameTitle}>{name}</span>
      <span className="g-bar">
        {band && <span className="band" style={{ left: `${band[0]}%`, width: `${band[1] - band[0]}%` }} />}
        <i style={{ width: `${fillPct}%` }} />
        {tick != null && <span className="exp" style={{ left: `${tick}%` }} />}
      </span>
      <span className="g-t">{time}</span>
    </li>
  );
}

// Sub-line terms + metric definitions are shared with the in-place tooltips
// (issue #66) via definitions.ts — the legend is the deep-dive view of the
// SAME copy, so the two layers can't drift.

export function LegendPanel({ open, onClose, returnFocusRef }: LegendPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  // Esc to close + focus management — same mechanics as SettingsPanel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? panelRef.current;
    focusTarget?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      returnFocusRef?.current?.focus();
    };
  }, [open, onClose, returnFocusRef]);

  if (!open) return null;

  return (
    <>
      <div className="settings-overlay" data-testid="legend-overlay" onClick={onClose} />
      <div
        className="settings-panel legend-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="settings-head">
          <h2 id={headingId}>Legend</h2>
          <button type="button" className="settings-close" aria-label="Close legend" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="settings-body">
          {/* (a) Pipeline track */}
          <section className="settings-section">
            <h3>Pipeline track</h3>
            <LegendRow example={<ExampleNode status="done" glyph="✓" />}>
              <b>Done</b> — stage complete
            </LegendRow>
            <LegendRow example={<ExampleNode status="active" glyph="2" />}>
              <b>Active</b> — current stage in progress (pulses; shows its label and <code>~ETA</code> underneath)
            </LegendRow>
            <LegendRow example={<ExampleNode status="fail" glyph="✗" />}>
              <b>Failed</b> — CI failed (at the CI node) or the merge-group build failed (at the Queue node)
            </LegendRow>
            <LegendRow example={<ExampleNode status="pending" glyph="3" />}>
              <b>Pending</b> — stage not reached yet (numbered)
            </LegendRow>
            <LegendRow example={<ExampleNode status="parked" glyph="!" />}>
              <b>Parked</b> — needs attention before it can advance: draft, conflicting,
              unmergeable, or blocked behind a queue conflict (the node label names the reason)
            </LegendRow>
            <LegendRow example={
              <span className="legend-track-segs">
                <i className="seg done" />
                <i className="seg part"
                  style={{ background: 'linear-gradient(90deg, var(--accent) 60%, var(--border) 60%)' }} />
                <i className="seg" />
              </span>
            }>
              <b>Segments</b> — green: stage behind it is complete; partial blue fill:
              progress % of the active stage; gray: not reached
            </LegendRow>
          </section>

          {/* (b) Row sub-line terms */}
          <section className="settings-section">
            <h3>Row sub-line terms</h3>
            <dl className="legend-dl">
              {SUBLINE_TERMS.map(({ term, text }) => (
                <div className="legend-dl-row" key={term}>
                  <dt>{term}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* (c) Expanded job bars */}
          <section className="settings-section">
            <h3>Expanded job bars</h3>
            <ul className="checks gantt legend-gantt">
              <ExampleBar kind="g-done" name="passed" fillPct={70} time="4m ✓" />
              <ExampleBar kind="g-running" name="running" fillPct={45} time="2m / ~5m"
                band={[40, 75]} tick={55} />
              <ExampleBar kind="g-overdue" name="running long" fillPct={95} time="9m ⚠ overdue" />
              <ExampleBar kind="g-failed" name="failed" fillPct={35} time="1m ✗" />
              <ExampleBar kind="g-queued" name="queued" fillPct={15} time="—" />
              <ExampleBar kind="g-queued g-runner-wait" name="runner wait" fillPct={15}
                time="⧗ waiting for runner" />
              <ExampleBar kind="g-queued g-runner-wait g-runner-wait-amber" name="slow runner wait"
                fillPct={15} time="⧗ 2× typical" />
              <ExampleBar kind="g-done" name="required job" fillPct={60} time="3m ✓" />
              <ExampleBar kind="g-done g-advisory" name="advisory job" fillPct={50} time="2m ✓"
                nameTitle="advisory — does not gate merging" />
            </ul>
            <p className="legend-caption">
              Bar fill = elapsed time on a shared scale. Tinted <b>band</b> = the job&apos;s typical
              p10–p90 duration range; dark <b>tick</b> = its typical (p50) duration.
              Striped fill = waiting for a CI runner (amber once the wait exceeds 2× typical).
            </p>
            <p className="legend-caption">
              <b>Required</b> job names render normally — a failure blocks merge.{' '}
              <em style={{ color: 'var(--muted)' }}>Advisory</em> job names are italic and muted — they
              run but do not gate merging (hover for tooltip).
            </p>
            <p className="legend-caption">
              <code>⧗ waiting for runner</code> — queued, no runner assigned yet ·{' '}
              <code>⊘ blocked on X</code> — waiting for upstream job X to finish ·{' '}
              <code>–</code> — skipped
            </p>
            <p className="legend-caption">
              <code>⚐ flakes N%</code> — this failing check has failed-then-passed on the
              same commit in N% of its recent runs (7 days) — likely a flake; consider a
              re-run before debugging. The row stays red: a flake rate is a probability,
              not a verdict.
            </p>
          </section>

          {/* (d) Queue train */}
          <section className="settings-section">
            <h3>Queue train</h3>
            <p className="legend-caption">One car per merge-queue grouping, front of the queue first.</p>
            <div className="queue-train legend-train">
              <ExampleCar cls="building" header="▶ group" body="#101 #102" />
              <ExampleCar cls="building failed" header="✗ failing" body="#103" />
              <ExampleCar cls="queued" header="next batch" body="#104 #105" />
              <ExampleCar cls="unmergeable" header="✗ unmergeable" body="#106" />
              <ExampleCar cls="queue-blocked" header="⊘ blocked behind conflict" body="#107" />
            </div>
            <dl className="legend-dl">
              <div className="legend-dl-row">
                <dt>solid blue</dt>
                <dd>merge group building — speculative merge running the full CI suite (shows % and ETA)</dd>
              </div>
              <div className="legend-dl-row">
                <dt>solid red</dt>
                <dd>that group&apos;s build failed — the queue re-batches without the culprit</dd>
              </div>
              <div className="legend-dl-row">
                <dt>dashed gray</dt>
                <dd>waiting — &ldquo;next batch&rdquo; starts building when a slot frees; &ldquo;then&rdquo; collapses the rest</dd>
              </div>
              <div className="legend-dl-row">
                <dt>dashed red</dt>
                <dd>unmergeable — conflicts with the base branch; needs a rebase, facing ejection</dd>
              </div>
              <div className="legend-dl-row">
                <dt>dashed amber</dt>
                <dd>blocked behind a conflicting entry ahead — not conflicting itself; revalidates once the culprit is ejected</dd>
              </div>
            </dl>
          </section>

          {/* (e) Status tiles */}
          <section className="settings-section">
            <h3>Status tiles</h3>
            <dl className="legend-dl">
              {TILE_DEFINITIONS.map(({ bucket, label, cssClass, title }) => (
                <div className="legend-dl-row" key={bucket}>
                  <dt>
                    <span className={`legend-swatch ${cssClass}`} aria-hidden="true" /> {label}
                  </dt>
                  <dd>{title}</dd>
                </div>
              ))}
            </dl>
            <p className="legend-caption">Click a tile to filter the board to that bucket; click again to clear.</p>
          </section>

          {/* (f) Metrics & ops figures — the same copy the in-place tooltips
              carry (issue #66); this is the browsable deep-dive. */}
          <section className="settings-section">
            <h3>Metrics &amp; ops figures</h3>
            <p className="legend-caption">
              Every headline number also explains itself in place — hover it.
              The full vocabulary:
            </p>
            <dl className="legend-dl">
              {Object.entries(METRIC_DEFINITIONS).map(([key, def]) => (
                <div className="legend-dl-row" key={key}>
                  <dt>{def.label}</dt>
                  <dd>{def.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
