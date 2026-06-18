// Insights section (roadmap WS3a) — the analytics + retrospect home. Folds the old
// Metrics tab (cost/queue/runners/flake/lead-time + ranked tuning actions) and the
// old Tune tab (budgets/policy/outcomes/changelog) into ONE section, removing the IA
// overlap both reviewers flagged ("Tuning" lived in Metrics while "Tune" was empty).
// Pure composition of the two existing, already-tested surfaces.
import { MetricsView } from '../../MetricsView';
import { TuneView } from '../tune/TuneView';
import type { WorkspaceApi } from '../../shell/workspaceApi';

export function InsightsView({ repo, api }: { repo: string | null; api: WorkspaceApi }) {
  return (
    <div className="insights-view">
      <MetricsView />
      <TuneView repo={repo} api={api} />
    </div>
  );
}
