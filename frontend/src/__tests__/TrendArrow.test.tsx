import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TrendArrow } from '../TrendArrow';
import type { Trend } from '../lib/trend';

const t = (over: Partial<Trend>): Trend => ({ deltaPct: 0, direction: 'flat', polarity: 'neutral', significant: false, ...over });

describe('TrendArrow', () => {
  it('renders nothing when flat or insignificant', () => {
    const { container: c1 } = render(<TrendArrow trend={t({})} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<TrendArrow trend={t({ direction: 'up', significant: false, deltaPct: 3 })} />);
    expect(c2.firstChild).toBeNull();
  });
  it('renders an up arrow with good polarity class + aria-label for a significant good rise', () => {
    const { getByLabelText, container } = render(<TrendArrow trend={t({ direction: 'up', significant: true, polarity: 'good', deltaPct: 50 })} />);
    const el = getByLabelText('+50% vs prev window');
    expect(el.textContent).toBe('▲');
    expect(container.querySelector('.trend-arrow--good')).not.toBeNull();
  });
  it('renders a down arrow with bad polarity class for a significant bad fall', () => {
    const { getByLabelText, container } = render(<TrendArrow trend={t({ direction: 'down', significant: true, polarity: 'bad', deltaPct: -20 })} />);
    expect(getByLabelText('-20% vs prev window').textContent).toBe('▼');
    expect(container.querySelector('.trend-arrow--bad')).not.toBeNull();
  });
  it('uses a custom baseline label', () => {
    const { getByLabelText } = render(<TrendArrow trend={t({ direction: 'up', significant: true, polarity: 'good', deltaPct: 12 })} baselineLabel="vs last week" />);
    expect(getByLabelText('+12% vs last week')).toBeInTheDocument();
  });
});
