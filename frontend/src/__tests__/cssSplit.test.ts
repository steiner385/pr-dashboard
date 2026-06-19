import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

it('moves body styling to standalone.css and keeps :root vars in styles.css', () => {
  const styles = read('../styles.css');
  const standalone = read('../standalone.css');
  expect(styles).not.toMatch(/^\s*body\s*\{/m);   // body rule no longer in the scoped sheet
  expect(styles).toMatch(/:root\s*\{/);            // CSS vars stay
  expect(standalone).toMatch(/body\s*\{/);         // full-viewport lives standalone-only
});

// Fix 3 (#175): .cmdk-input:focus-visible ring must exist in workspace.css
it('workspace.css has a :focus-visible ring for .cmdk-input (a11y Fix 3 — #175)', () => {
  const css = read('../shell/workspace.css');
  expect(css).toContain('.cmdk-input:focus-visible');
});
