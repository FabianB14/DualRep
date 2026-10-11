/**
 * The study screens' pure helpers: wording (studyText), the plan form (planDraft), the outline
 * review's working copy (outlineDraft) and the concept map's layout (conceptMapLayout).
 */
import { describe, expect, it, jest } from '@jest/globals';

import { STUDY_API_LIMITS } from '@/features/study/studyApi';
import { STUDY_LIMITS } from '@/features/study/studyRepo';

import { boxesOverlap, MAP_MAX_NEIGHBORS, mapGeometry, mapNeighbors, radialLayout, type MapLink } from '../conceptMapLayout';
import {
  moveOutlineItem,
  OUTLINE_TITLE_MAX,
  outlineChanged,
  outlineDecisions,
  outlineErrors,
  outlineItemsFrom,
  outlineSummary,
  renameOutlineItem,
  setOutlineKeep,
} from '../outlineDraft';
import { dateInDays, EMPTY_PLAN_DRAFT, hasPlanDraftErrors, PLAN_GOAL_MAX, PLAN_TITLE_MAX, planDraftErrors, planDraftFrom, planDraftValues } from '../planDraft';
import {
  cardStatusText,
  cardTypeLabel,
  countText,
  daysUntil,
  localDateMs,
  localDateString,
  materialProgressText,
  planCountsText,
  relationLabel,
  sourceKindLabel,
  targetDateText,
} from '../studyText';

// studyRepo is imported only for its limits; its database stays untouched.
jest.mock('../../db/database', () => ({ db: {} }));

/** 9 Oct 2026, 10:00 local time. */
const NOW = new Date(2026, 9, 9, 10, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('studyText', () => {
  it('counts in plain words', () => {
    expect(countText(1, 'card')).toBe('1 card');
    expect(countText(0, 'card')).toBe('0 cards');
    expect(countText(2, 'topic')).toBe('2 topics');
  });

  it("sums up a plan's counts", () => {
    expect(planCountsText({ dueCount: 12, newCount: 30, cardCount: 80, sourceCount: 2 })).toBe('12 due · 30 new · 2 sources');
    expect(planCountsText({ dueCount: 0, newCount: 0, cardCount: 40, sourceCount: 1 })).toBe('Nothing due · 1 source');
    expect(planCountsText({ dueCount: 0, newCount: 0, cardCount: 0, sourceCount: 0 })).toBe('No cards yet · No material yet');
  });

  it('reads local calendar dates and counts days to them', () => {
    expect(localDateMs('2026-10-09')).toBe(new Date(2026, 9, 9).getTime());
    expect(localDateMs('2026-02-30')).toBeNull();
    expect(localDateMs('9 Oct')).toBeNull();
    expect(localDateString(NOW)).toBe('2026-10-09');
    expect(daysUntil('2026-10-09', NOW)).toBe(0);
    expect(daysUntil('2026-10-10', NOW)).toBe(1);
    expect(daysUntil('2026-12-14', NOW)).toBe(66);
    expect(daysUntil('2026-10-01', NOW)).toBe(-8);
    expect(daysUntil(null, NOW)).toBeNull();
  });

  it('says when the exam is', () => {
    expect(targetDateText('2026-10-09', NOW)).toMatch(/, today$/);
    expect(targetDateText('2026-10-10', NOW)).toMatch(/, tomorrow$/);
    expect(targetDateText('2026-12-14', NOW)).toMatch(/, in 66 days$/);
    expect(targetDateText('2026-10-08', NOW)).toMatch(/, yesterday$/);
    expect(targetDateText('2026-10-01', NOW)).toMatch(/, 8 days ago$/);
  });

  it("says when a card comes back, from the user's state", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(cardStatusText({ state: null, due: null, suspended: false }, NOW)).toBe('New');
    expect(cardStatusText({ state: 0, due: at(NOW), suspended: false }, NOW)).toBe('New');
    expect(cardStatusText({ state: 2, due: at(NOW - 1), suspended: true }, NOW)).toBe('Paused');
    expect(cardStatusText({ state: 2, due: at(NOW - 1), suspended: false }, NOW)).toBe('Due now');
    expect(cardStatusText({ state: 1, due: at(NOW + 10 * 60_000), suspended: false }, NOW)).toBe('Due in 10 minutes');
    expect(cardStatusText({ state: 2, due: at(NOW + 3 * HOUR), suspended: false }, NOW)).toBe('Due in 3 hours');
    expect(cardStatusText({ state: 2, due: at(NOW + 25 * HOUR), suspended: false }, NOW)).toBe('Due tomorrow');
    expect(cardStatusText({ state: 2, due: at(NOW + 5 * DAY), suspended: false }, NOW)).toBe('Due in 5 days');
    expect(cardStatusText({ state: 2, due: at(NOW + 90 * DAY), suspended: false }, NOW)).toBe('Due in 3 months');
  });

  it('names kinds, card types and relations', () => {
    expect(sourceKindLabel('notes')).toBe('Photos of notes');
    expect(sourceKindLabel(null)).toBe('Material');
    expect(cardTypeLabel('cloze')).toBe('Fill the gap');
    expect(cardTypeLabel('other')).toBe('Question');
    // A prerequisite link runs from the card that comes first.
    expect(relationLabel('prerequisite', false)).toBe('Learn this first');
    expect(relationLabel('prerequisite', true)).toBe('Builds on this');
    expect(relationLabel('analogy', true)).toBe('Similar idea');
    expect(relationLabel(null, true)).toBe('Related');
  });

  it("describes the add-material progress", () => {
    expect(materialProgressText({ phase: 'preparing', done: 1, total: 5 }, 'notes')).toBe('Getting photo 2 of 5 ready…');
    expect(materialProgressText({ phase: 'uploading', done: 0, total: 1, bytesSent: 400, totalBytes: 1000 }, 'document')).toBe(
      'Uploading the file (40%)…',
    );
    expect(materialProgressText({ phase: 'uploading', done: 2, total: 3 }, 'notes')).toBe('Uploading photo 3 of 3…');
    expect(materialProgressText({ phase: 'submitting', done: 0, total: 1 }, 'link')).toBe('Starting to read it…');
  });
});

describe('planDraft', () => {
  it('uses the same limits as the repo and the study function', () => {
    expect(PLAN_TITLE_MAX).toBe(STUDY_LIMITS.planTitle);
    expect(PLAN_GOAL_MAX).toBe(STUDY_LIMITS.planGoal);
    expect(OUTLINE_TITLE_MAX).toBe(STUDY_API_LIMITS.maxTopicTitleChars);
    expect(OUTLINE_TITLE_MAX).toBe(STUDY_LIMITS.topicTitle);
  });

  it('needs a name, a goal within the limit and a real date (or none)', () => {
    expect(planDraftErrors(EMPTY_PLAN_DRAFT).title).toBeDefined();
    const ok = { ...EMPTY_PLAN_DRAFT, title: ' Biology 101 ' };
    expect(hasPlanDraftErrors(planDraftErrors(ok))).toBe(false);
    expect(planDraftErrors({ ...ok, title: 'x'.repeat(PLAN_TITLE_MAX + 1) }).title).toBeDefined();
    expect(planDraftErrors({ ...ok, goal: 'x'.repeat(PLAN_GOAL_MAX + 1) }).goal).toBeDefined();
    expect(planDraftErrors({ ...ok, targetDate: '2026-13-01' }).targetDate).toBeDefined();
    expect(planDraftErrors({ ...ok, targetDate: '2026-12-14' }).targetDate).toBeUndefined();
  });

  it('saves trimmed values and no date as null', () => {
    expect(planDraftValues({ title: ' Bio ', scope: 'single', goal: ' pass ', targetDate: ' ' })).toEqual({
      title: 'Bio',
      scope: 'single',
      goal: 'pass',
      targetDate: null,
    });
    expect(planDraftFrom({ title: 'Bio', scope: 'cumulative', goal: '', targetDate: null }).targetDate).toBe('');
  });

  it('turns a quick choice into a local date', () => {
    expect(dateInDays(7, NOW)).toBe('2026-10-16');
    expect(dateInDays(28, NOW)).toBe('2026-11-06');
  });
});

describe('outlineDraft', () => {
  const drafts = [
    { id: 'a', title: 'Cells' },
    { id: 'b', title: 'Energy' },
    { id: 'c', title: 'Genes' },
  ];

  it('starts from the proposal, everything kept', () => {
    const items = outlineItemsFrom(drafts);
    expect(items.map((item) => [item.id, item.title, item.keep])).toEqual([
      ['a', 'Cells', true],
      ['b', 'Energy', true],
      ['c', 'Genes', true],
    ]);
    expect(outlineChanged(items, drafts)).toBe(false);
    expect(outlineSummary(items)).toBe('3 topics kept');
  });

  it('moves, cuts and renames without touching the others', () => {
    let items = outlineItemsFrom(drafts);
    items = moveOutlineItem(items, 2, -1);
    expect(items.map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(moveOutlineItem(items, 0, -1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(moveOutlineItem(items, 2, 1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
    items = setOutlineKeep(items, 'a', false);
    items = renameOutlineItem(items, 'c', '  Genetics ');
    expect(outlineChanged(items, drafts)).toBe(true);
    expect(outlineSummary(items)).toBe('2 topics kept, 1 cut');
    // Every draft is listed in the new order; only a real rename sends a title.
    expect(outlineDecisions(items)).toEqual([
      { id: 'a', keep: false },
      { id: 'c', title: 'Genetics', keep: true },
      { id: 'b', keep: true },
    ]);
  });

  it('keeps edits when drafts arrive or leave', () => {
    let items = outlineItemsFrom(drafts);
    items = moveOutlineItem(items, 0, 1);
    items = renameOutlineItem(items, 'a', 'Cell biology');
    const later = outlineItemsFrom([...drafts.filter((draft) => draft.id !== 'c'), { id: 'd', title: 'Evolution' }], items);
    expect(later.map((item) => [item.id, item.title])).toEqual([
      ['b', 'Energy'],
      ['a', 'Cell biology'],
      ['d', 'Evolution'],
    ]);
  });

  it('needs a name for every kept topic (a cut one may stay empty)', () => {
    let items = outlineItemsFrom(drafts);
    items = renameOutlineItem(items, 'a', ' ');
    items = renameOutlineItem(items, 'b', 'x'.repeat(OUTLINE_TITLE_MAX + 1));
    expect(Object.keys(outlineErrors(items))).toEqual(['a', 'b']);
    items = setOutlineKeep(items, 'a', false);
    expect(Object.keys(outlineErrors(items))).toEqual(['b']);
    // An empty name on a cut topic is not sent as a rename.
    expect(outlineDecisions(items)[0]).toEqual({ id: 'a', keep: false });
  });
});

describe('conceptMapLayout', () => {
  const link = (id: string, from: string, to: string, relation: string, center = 'm'): MapLink => ({
    id,
    from_card_id: from,
    to_card_id: to,
    relation,
    other_card_id: from === center ? to : from,
    other_question: `Q ${from === center ? to : from}`,
  });

  it('groups links by the other card, with each relation as seen from the middle', () => {
    const neighbors = mapNeighbors('m', [
      link('1', 'm', 'x', 'prerequisite'),
      link('2', 'y', 'm', 'prerequisite'),
      link('3', 'x', 'm', 'analogy'),
      link('4', 'x', 'm', 'analogy'),
    ]);
    expect(neighbors).toEqual([
      { cardId: 'x', question: 'Q x', relations: ['Builds on this', 'Similar idea'], linkIds: ['1', '3', '4'] },
      { cardId: 'y', question: 'Q y', relations: ['Learn this first'], linkIds: ['2'] },
    ]);
  });

  it('places the first card at the top and stays inside the area', () => {
    const { area, node } = mapGeometry(360);
    const [top] = radialLayout(1, area, node);
    expect(top.x).toBeCloseTo(area.width / 2);
    expect(top.y).toBeCloseTo(node.height / 2);
    for (let n = 1; n <= MAP_MAX_NEIGHBORS; n += 1) {
      for (const point of radialLayout(n, area, node)) {
        expect(point.x - node.width / 2).toBeGreaterThanOrEqual(-0.1);
        expect(point.x + node.width / 2).toBeLessThanOrEqual(area.width + 0.1);
        expect(point.y - node.height / 2).toBeGreaterThanOrEqual(-0.1);
        expect(point.y + node.height / 2).toBeLessThanOrEqual(area.height + 0.1);
      }
    }
    expect(radialLayout(10, area, node)).toHaveLength(MAP_MAX_NEIGHBORS);
    expect(radialLayout(0, area, node)).toEqual([]);
  });

  it('never overlaps two cards, or a card and the middle one, from small phones to tablets', () => {
    for (const width of [280, 320, 360, 390, 412, 600, 900]) {
      const { area, node, center } = mapGeometry(width);
      const middle = { x: area.width / 2, y: area.height / 2 };
      for (let n = 1; n <= MAP_MAX_NEIGHBORS; n += 1) {
        const points = radialLayout(n, area, node);
        for (let i = 0; i < points.length; i += 1) {
          expect(boxesOverlap(points[i], node, middle, center)).toBe(false);
          for (let j = i + 1; j < points.length; j += 1) expect(boxesOverlap(points[i], node, points[j], node)).toBe(false);
        }
      }
    }
  });
});
