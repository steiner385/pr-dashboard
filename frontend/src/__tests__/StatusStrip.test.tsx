import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusStrip, bucketPr, type Bucket } from '../StatusStrip';
import type { PrView } from '../types';

const pr = (stage: string, substate: string | null = null): PrView => ({
  repo: 'x', number: 1, title: 'pr', url: 'u',
  stage: { stage: stage as PrView['stage']['stage'], substate, percent: null,
    etaSeconds: null, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null, checks: [], groupChecks: null,
});

describe('bucketPr', () => {
  it('classifies ci stage as running', () => {
    expect(bucketPr(pr('ci'))).toBe('running');
  });

  it('classifies queue stage as queued', () => {
    expect(bucketPr(pr('queue'))).toBe('queued');
  });

  it('classifies qa-deploy as deploy', () => {
    expect(bucketPr(pr('qa-deploy'))).toBe('deploy');
  });

  it('classifies awaiting-prod as deploy', () => {
    expect(bucketPr(pr('awaiting-prod'))).toBe('deploy');
  });

  it('classifies merged as idle — retention-window stage for repos with no deploy environments', () => {
    expect(bucketPr(pr('merged'))).toBe('idle');
  });

  it('classifies parked/ci-failed as failed', () => {
    expect(bucketPr(pr('parked', 'ci-failed'))).toBe('failed');
  });

  it('classifies queue/group-failed as failed', () => {
    expect(bucketPr(pr('queue', 'group-failed'))).toBe('failed');
  });

  it('classifies parked (draft) as idle', () => {
    expect(bucketPr(pr('parked', 'draft'))).toBe('idle');
  });

  it('classifies parked (conflicting) as idle', () => {
    expect(bucketPr(pr('parked', 'conflicting'))).toBe('idle');
  });

  it('classifies ready as idle', () => {
    expect(bucketPr(pr('ready'))).toBe('idle');
  });
});

describe('StatusStrip', () => {
  const prs: PrView[] = [
    pr('ci'),
    pr('ci'),
    pr('queue'),
    pr('queue'),
    pr('queue'),
    pr('qa-deploy'),
    pr('awaiting-prod'),
    pr('merged'),
    pr('parked', 'ci-failed'),
    pr('parked', 'draft'),
    pr('ready'),
  ];

  it('renders all five tiles with correct counts', () => {
    render(<StatusStrip prs={prs} activeFilter={null} onFilter={() => {}} />);
    // running=2, queued=3, deploy=2 (qa-deploy + awaiting-prod only), failed=1,
    // idle=3 (merged + parked/draft + ready)
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    const countFor = (label: string) =>
      screen.getByText(label).closest('button')!.querySelector('b')!.textContent;
    expect(countFor('CI running')).toBe('2');
    expect(countFor('In queue')).toBe('3');
    expect(countFor('Awaiting prod')).toBe('2');
    expect(countFor('Failed')).toBe('1');
    expect(countFor('Ready / other')).toBe('3');
  });

  it('empty buckets still render but are disabled', () => {
    const onlyRunning: PrView[] = [pr('ci')];
    render(<StatusStrip prs={onlyRunning} activeFilter={null} onFilter={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    // queued, deploy, failed, idle all have count=0 and should be disabled
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(4);
    zeros.forEach((el) => {
      expect(el.closest('button')).toHaveAttribute('disabled');
    });
    // running (count=1) is not disabled
    const runningBtn = screen.getByText('1').closest('button')!;
    expect(runningBtn).not.toHaveAttribute('disabled');
  });

  it('active tile has aria-pressed=true, others false', () => {
    render(<StatusStrip prs={prs} activeFilter="running" onFilter={() => {}} />);
    const buttons = screen.getAllByRole('button');
    const pressedBtns = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressedBtns).toHaveLength(1);
    // The pressed button should correspond to the running bucket
    expect(pressedBtns[0]).toHaveTextContent('CI running');
  });

  it('clicking a tile calls onFilter with the bucket name', () => {
    const onFilter = vi.fn();
    render(<StatusStrip prs={prs} activeFilter={null} onFilter={onFilter} />);
    fireEvent.click(screen.getByText('CI running').closest('button')!);
    expect(onFilter).toHaveBeenCalledWith('running');
  });

  it('clicking the active tile calls onFilter with null (clear)', () => {
    const onFilter = vi.fn();
    render(<StatusStrip prs={prs} activeFilter="running" onFilter={onFilter} />);
    fireEvent.click(screen.getByText('CI running').closest('button')!);
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  it('clicking a disabled tile does not fire onFilter', () => {
    const onFilter = vi.fn();
    const onlyRunning: PrView[] = [pr('ci')];
    render(<StatusStrip prs={onlyRunning} activeFilter={null} onFilter={onFilter} />);
    // find a disabled button (count=0) and click it
    const disabledBtn = screen.getAllByRole('button').find((b) => b.hasAttribute('disabled'))!;
    fireEvent.click(disabledBtn);
    expect(onFilter).not.toHaveBeenCalled();
  });

  it('active bucket with count 0 stays enabled so filter can be cleared (V1 stuck-filter fix)', () => {
    // Filter was set to 'running' while PRs existed; now zero PRs remain in that bucket.
    // The tile must NOT be disabled — the user must be able to click it to clear the filter.
    const onFilter = vi.fn();
    const noPrs: PrView[] = []; // all buckets empty
    render(<StatusStrip prs={noPrs} activeFilter="running" onFilter={onFilter} />);
    // The running tile has count=0 but is the active filter
    const runningBtn = screen.getByText('CI running').closest('button')!;
    expect(runningBtn).not.toHaveAttribute('disabled');
    // Clicking it calls onFilter(null) to clear
    fireEvent.click(runningBtn);
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  // ---- in-place tooltips (legend feature) ----

  describe('tile title tooltips', () => {
    it('every tile carries a one-line bucket definition', () => {
      render(<StatusStrip prs={[pr('ci'), pr('queue'), pr('qa-deploy'),
        pr('parked', 'ci-failed'), pr('ready')]} activeFilter={null} onFilter={() => {}} />);
      const titles = screen.getAllByRole('button').map((b) => b.getAttribute('title'));
      expect(titles).toEqual([
        'CI running on the head commit',
        'In the merge queue — building or waiting for a slot',
        'Merged — deploying to QA or awaiting production deploy',
        'CI failed or the merge-group build failed',
        'Ready, draft, conflicting, or recently merged — nothing running',
      ]);
    });
  });
});
