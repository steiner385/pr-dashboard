// Cost/capacity forecast banner (spec 001, Group J1/J2 / FR-037). A budget-warning
// surfaced on the Health monitor: "at the current trend you'll hit the budget in
// N days." Honest about confidence (low → hedged wording) and silent when there's
// no series or no rising trend (nothing alarming to say). API injected.
import { useEffect, useState } from 'react';
import type { WorkspaceApi, ForecastDto } from './workspaceApi';

export function ForecastBanner({ api, repo, warnWithinDays = 14 }: { api: WorkspaceApi; repo: string | null; warnWithinDays?: number }) {
  const [f, setF] = useState<ForecastDto | null>(null);
  useEffect(() => {
    if (!repo) { setF(null); return; }
    let alive = true;
    api.forecast(repo).then((r) => { if (alive) setF(r); }).catch(() => { if (alive) setF(null); });
    return () => { alive = false; };
  }, [api, repo]);

  // nothing worth saying: no data, or not trending toward the budget
  if (!f || !f.available) return null;
  const days = f.daysToThreshold;
  if (days == null) return null;

  const within = days <= warnWithinDays;
  if (!within) return null; // only surface when the breach is near

  const hedge = f.confidence === 'high' ? '' : f.confidence === 'medium' ? ' (rough estimate)' : ' (low-confidence — sparse/noisy data)';
  const unit = f.unit ?? 'budget';
  return (
    <div className={`forecast-banner conf-${f.confidence}`} role="status">
      ⏳ At the current trend you’ll hit the {unit} budget in <strong>~{days} day{days === 1 ? '' : 's'}</strong>{hedge}.
    </div>
  );
}
