import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeployPanel } from '../DeployPanel';
import type { DashboardState } from '../../../types';

const repos = (deploy: object | undefined) =>
  [{ repo: 'acme/widgets', hasDeploy: true, prs: [], queue: null, deploy }] as unknown as DashboardState['repos'];

describe('DeployPanel', () => {
  it('renders each env with its short live sha + reachable dot and the awaiting counts', () => {
    render(<DeployPanel repos={repos({
      envs: [{ name: 'qa', liveSha: 'a1b2c3d4e5', reachable: true },
        { name: 'prod', liveSha: null, reachable: false }],
      awaitingQa: 0, awaitingProd: 3,
    })} />);
    expect(screen.getByText('qa')).toBeInTheDocument();
    expect(screen.getByText(/a1b2c3/)).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getByText(/3 awaiting prod/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('spine-deploy-env')).toHaveLength(2);
  });

  it('shows an empty note when no repo has deploy data', () => {
    render(<DeployPanel repos={repos(undefined)} />);
    expect(screen.getByText(/no deploy/i)).toBeInTheDocument();
  });
});
