import type { DashboardState } from '../../types';

/** Drill-down for the Deploy lane (Spec 2): per repo, each environment's name +
 *  short live commit sha + a reachable dot, plus the awaiting-QA/awaiting-prod
 *  drift counts. Advisory — no red/amber surfaces. */
export function DeployPanel({ repos }: { repos: DashboardState['repos'] }) {
  const active = repos.filter((r) => r.deploy);
  if (active.length === 0) return <p className="spine-panel-empty">No deploy environments configured.</p>;
  return (
    <div className="spine-deploy-list">
      {active.map((r) => {
        const d = r.deploy!;
        return (
          <div key={r.repo} data-testid={`spine-deploy-${r.repo}`}>
            {active.length > 1 && <div className="spine-panel-label">{r.repo}</div>}
            <div className="spine-deploy-envs">
              {d.envs.map((e) => (
                <span key={e.name} data-testid="spine-deploy-env" className="spine-deploy-env"
                  title={e.reachable ? `${e.name} live` : `${e.name} unreachable`}>
                  <span className={`spine-deploy-dot ${e.reachable ? 'ok' : 'off'}`} aria-hidden="true" />
                  <span className="spine-deploy-env-name">{e.name}</span>
                  {e.liveSha
                    ? <code className="spine-deploy-sha">{e.liveSha.slice(0, 7)}</code>
                    : <span className="spine-deploy-sha-none">unreachable</span>}
                </span>
              ))}
            </div>
            <div className="spine-deploy-awaiting">
              {d.awaitingQa} awaiting QA · {d.awaitingProd} awaiting prod
            </div>
          </div>
        );
      })}
    </div>
  );
}
