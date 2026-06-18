// The unified-workspace section model (spec 001, FR-001/FR-002). Five verb-named
// sections replace the four legacy tabs; each carries its "mode" (the default-vs-
// on-demand contract from the persona review). Pure — hash routing is testable
// without the DOM.

export type SectionId = 'health' | 'pipeline' | 'diagnose' | 'model-edit' | 'insights';

export interface SectionDef {
  id: SectionId;
  label: string;
  /** the section's interaction mode (drives default-vs-on-demand disclosure) */
  mode: 'monitor' | 'drill' | 'read' | 'act' | 'configure';
  /** one-line purpose for tooltips/aria */
  blurb: string;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'health',   label: 'Health',              mode: 'monitor',   blurb: 'Is delivery healthy right now?' },
  { id: 'pipeline', label: 'Pipeline',            mode: 'monitor',   blurb: 'Every open PR and where it is in the pipeline.' },
  { id: 'diagnose',   label: 'Diagnose',     mode: 'drill',   blurb: 'Why is this PR stuck?' },
  { id: 'model-edit', label: 'Model & Edit', mode: 'act',     blurb: 'Inspect what gates a merge, find waste, and shape the pipeline.' },
  { id: 'insights',   label: 'Insights',     mode: 'read',    blurb: 'Cost, queue, runners, flake, lead time, budgets, outcomes — the full analytics.' },
];

/** Retired hashes that now redirect into a surviving section (WS3 IA consolidation). */
const HASH_ALIASES: Record<string, SectionId> = {
  tune: 'insights', metrics: 'insights',
  model: 'model-edit', optimize: 'model-edit', build: 'model-edit',
};

export const DEFAULT_SECTION: SectionId = 'health';

const IDS = SECTIONS.map((s) => s.id) as readonly string[];

/** Parse a `#health` style hash into a SectionId (null if not a known section). */
export function sectionFromHash(hash: string): SectionId | null {
  const h = hash.replace(/^#/, '').trim().toLowerCase();
  if (IDS.includes(h)) return h as SectionId;
  return HASH_ALIASES[h] ?? null; // retired #tune / #metrics → #insights
}

/** The canonical hash for a section (for links + history). */
export function hashForSection(id: SectionId): string {
  return `#${id}`;
}

export function sectionDef(id: SectionId): SectionDef {
  return SECTIONS.find((s) => s.id === id)!;
}

/** Map a delivery-health lane to the workspace section that best explains it, so the
 *  Health lane chips become live deep-links instead of a dead CTA (roadmap 2.5). */
export function laneToSection(laneId: string | null): SectionId {
  switch (laneId) {
    case 'cost': return 'insights';
    case 'failures': case 'scheduled': return 'diagnose';
    default: return 'pipeline'; // pr-ci / merge-queue / main / deploy → the operational view
  }
}
