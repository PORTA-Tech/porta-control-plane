import { describe, expect, it } from 'vitest';
import { buildSituationFacts, sanitizeNarrativeTasks, type NarrativeSituation } from '../src/core/narrativeService.js';

// 2026-08-10 — the model was written to from the morning goal SENTENCE alone, which is never
// revised. So a task the user abandoned still read as today's plan, and Ari opened the next morning
// proposing "writting" back — dropped the previous afternoon after 20s of a planned 3h.
//
// These pin the outcomes into the fact sheet. If a future change stops sending or stops rendering
// them, the suite fails rather than the user finding out from Ari.
describe('task outcomes on the narrative fact sheet', () => {
  const base: NarrativeSituation = {
    goalToday: 'keep improving the system; writting; working on apollo',
    localTimeHHmm: '07:39',
  };

  const withTasks: NarrativeSituation = {
    ...base,
    tasks: [
      { title: 'keep improving the system', state: 'done', plannedSeconds: 7200, actualSeconds: 6815 },
      { title: 'writting', state: 'abandoned', plannedSeconds: 10800, actualSeconds: 20 },
      { title: 'working on apollo', state: 'abandoned', plannedSeconds: 3600, actualSeconds: 0 },
    ],
  };

  it('states what became of each task, not just what was planned', () => {
    const facts = buildSituationFacts('morning', withTasks, {});

    expect(facts).toContain('"writting"');
    expect(facts).toMatch(/"writting" — dropped/);
    expect(facts).toMatch(/"keep improving the system" — finished/);
  });

  it('carries planned against actual for each task', () => {
    const facts = buildSituationFacts('morning', withTasks, {});

    // 6815s of a planned 7200s: the pairing is the whole point of the section.
    expect(facts).toMatch(/planned .*, actually worked /);
  });

  it('names dropped work and tells the model not to propose it back', () => {
    const facts = buildSituationFacts('morning', withTasks, {});

    expect(facts).toMatch(/deliberately dropped/);
    expect(facts).toContain('Do not suggest picking those back up');
  });

  it('marks the outcomes as superseding the stated goal', () => {
    const facts = buildSituationFacts('morning', withTasks, {});

    // The stated goal still lists all three titles; without this the sentence wins.
    expect(facts).toContain(base.goalToday!);
    expect(facts).toContain('supersedes the stated goal');
  });

  it('distinguishes open work from finished work', () => {
    const facts = buildSituationFacts('midday', {
      ...base,
      tasks: [
        { title: 'continue to improve the system', state: 'active', plannedSeconds: 7200, actualSeconds: 1410 },
        { title: 'continue writting', state: 'pending', plannedSeconds: 7200, actualSeconds: 0 },
      ],
    }, {});

    expect(facts).toMatch(/"continue to improve the system" — in progress/);
    expect(facts).toMatch(/"continue writting" — not started/);
    // Nothing was dropped, so no drop instruction should appear at all.
    expect(facts).not.toMatch(/deliberately dropped/);
  });

  it('omits the section entirely when there is nothing to report', () => {
    const facts = buildSituationFacts('morning', base, {});

    expect(facts).not.toContain('What happened to each task');
    expect(facts).not.toMatch(/deliberately dropped/);
  });

  it('still renders the rest of the sheet when tasks are absent', () => {
    const facts = buildSituationFacts('morning', { ...base, trackedSeconds: 3600 }, {});

    expect(facts).toContain('Local time: 07:39');
    expect(facts).toContain(base.goalToday!);
  });
});

// Titles are free text the user typed and they land in a model prompt, so the route re-validates
// rather than trusting the situation cast.
describe('sanitizeNarrativeTasks', () => {
  it('keeps a well-formed outcome intact', () => {
    expect(sanitizeNarrativeTasks([
      { title: '  writting  ', state: 'abandoned', plannedSeconds: 10800, actualSeconds: 20 },
    ])).toEqual([
      { title: 'writting', state: 'abandoned', plannedSeconds: 10800, actualSeconds: 20 },
    ]);
  });

  it('drops entries with an unknown state, so nothing invented reaches the prompt', () => {
    expect(sanitizeNarrativeTasks([
      { title: 'x', state: 'deleted', plannedSeconds: 60, actualSeconds: 0 },
      { title: 'y', state: 'done', plannedSeconds: 60, actualSeconds: 0 },
    ]).map((t) => t.title)).toEqual(['y']);
  });

  it('drops blank titles and non-finite or negative numbers', () => {
    expect(sanitizeNarrativeTasks([
      { title: '   ', state: 'done', plannedSeconds: 60, actualSeconds: 0 },
      { title: 'a', state: 'done', plannedSeconds: Number.NaN, actualSeconds: 0 },
      { title: 'b', state: 'done', plannedSeconds: 60, actualSeconds: -5 },
      { title: 'c', state: 'done', plannedSeconds: 0, actualSeconds: 0 },
    ])).toEqual([]);
  });

  it('clamps a very long title rather than passing it through', () => {
    const [only] = sanitizeNarrativeTasks([
      { title: 'z'.repeat(500), state: 'done', plannedSeconds: 60, actualSeconds: 0 },
    ]);

    expect(only.title).toHaveLength(80);
  });

  it('caps the count at ten, matching what the agent sends', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      title: `task ${i}`, state: 'done', plannedSeconds: 60, actualSeconds: 0,
    }));

    expect(sanitizeNarrativeTasks(many)).toHaveLength(10);
  });

  it('treats anything that is not an array as nothing', () => {
    expect(sanitizeNarrativeTasks(undefined)).toEqual([]);
    expect(sanitizeNarrativeTasks('writting')).toEqual([]);
    expect(sanitizeNarrativeTasks({ title: 'x' })).toEqual([]);
  });
});
