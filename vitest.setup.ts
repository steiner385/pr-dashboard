import '@testing-library/jest-dom/vitest';

// jsdom ships no working clipboard / execCommand. Give component tests a
// deterministic copy path (individual tests can still override navigator.clipboard
// with their own spy) so PromptButton's truthful "✓ Copied!" confirmation resolves.
if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async () => {} }, configurable: true, writable: true,
  });
}
if (typeof document !== 'undefined') {
  document.execCommand = (() => true) as typeof document.execCommand;
}
