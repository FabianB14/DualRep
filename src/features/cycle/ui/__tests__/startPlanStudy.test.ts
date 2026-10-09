/** The start panel's study choice (pure): which plan is picked, and the cycle plan it makes. */
import { describe, expect, it } from '@jest/globals';

import { normalizePlan, studyPlanOf } from '../../cycleMachine';
import {
  chosenStudy,
  offersStudyFilter,
  planChoiceSubtitle,
  planFromChoices,
  STUDY_FILTER_OPTIONS,
  studyFilterNote,
  type StartChoices,
} from '../startPlan';

const BIO = '90000000-0000-4000-8000-000000000001';
const CHEM = '90000000-0000-4000-8000-000000000002';
const PLANS = [
  { id: BIO, title: 'Biology 101', scope: 'cumulative' as const },
  { id: CHEM, title: 'Organic chemistry', scope: 'single' as const },
];

const BASE: StartChoices = {
  focusSubject: '  Typed subject  ',
  blockMinutes: 25,
  preset: { id: 'preset-1', split: { lower: 25, upper: 25, core: 25, cardio: 25 } },
  setup: { id: 'setup-1', location: 'home', equipment: [] },
  quick: null,
  moveLength: '10',
  fullMinutes: 45,
};

describe('chosenStudy', () => {
  it('untouched: the last choice on this phone, while that plan is still here', () => {
    expect(chosenStudy(null, { planId: BIO, filter: 'newest' }, PLANS)).toEqual({ planId: BIO, title: 'Biology 101', filter: 'newest' });
    expect(chosenStudy(null, { planId: null, filter: 'all' }, PLANS)).toBeNull();
    expect(chosenStudy(null, null, PLANS)).toBeNull();
  });

  it('a remembered plan that left the phone falls back to just a timer', () => {
    expect(chosenStudy(null, { planId: '90000000-0000-4000-8000-00000000dead', filter: 'all' }, PLANS)).toBeNull();
    expect(chosenStudy(null, { planId: BIO, filter: 'all' }, [])).toBeNull();
  });

  it('the user’s pick wins over the remembered one, "Just a timer" included', () => {
    expect(chosenStudy({ planId: CHEM, filter: 'all' }, { planId: BIO, filter: 'newest' }, PLANS)?.planId).toBe(CHEM);
    expect(chosenStudy({ planId: null, filter: 'all' }, { planId: BIO, filter: 'all' }, PLANS)).toBeNull();
  });

  it('a single-source plan always studies everything', () => {
    expect(chosenStudy({ planId: CHEM, filter: 'newest' }, null, PLANS)?.filter).toBe('all');
  });
});

describe('planFromChoices with a study plan', () => {
  it('quizzes from the plan, and the session’s subject is its title', () => {
    const plan = planFromChoices({ ...BASE, study: { planId: BIO, title: ' Biology 101 ', filter: 'newest' } });
    expect(plan).toMatchObject({ focusSubject: 'Biology 101', studyPlanId: BIO, studyFilter: 'newest' });
    expect(studyPlanOf(normalizePlan(plan!))).toEqual({ planId: BIO, filter: 'newest' });
  });

  it('without one, the plan is exactly Phase 1’s', () => {
    for (const study of [undefined, null]) {
      const plan = planFromChoices({ ...BASE, study });
      expect(plan).not.toHaveProperty('studyPlanId');
      expect(plan).not.toHaveProperty('studyFilter');
      expect(plan?.focusSubject).toBe('Typed subject');
    }
  });

  it('still needs a place to move', () => {
    expect(planFromChoices({ ...BASE, setup: null, study: { planId: BIO, title: 'Biology 101', filter: 'all' } })).toBeNull();
  });
});

describe('the picker’s words', () => {
  it('says what each plan has', () => {
    expect(planChoiceSubtitle({ cardCount: 0, dueCount: 0, newCount: 0 })).toBe('No cards yet');
    expect(planChoiceSubtitle({ cardCount: 40, dueCount: 12, newCount: 5 })).toBe('12 due · 5 new');
    expect(planChoiceSubtitle({ cardCount: 40, dueCount: 0, newCount: 5 })).toBe('5 new');
    expect(planChoiceSubtitle({ cardCount: 40, dueCount: 3, newCount: 0 })).toBe('3 due');
    expect(planChoiceSubtitle({ cardCount: 40, dueCount: 0, newCount: 0 })).toBe('Nothing due');
  });

  it('offers the filter only for a cumulative plan with more than one source', () => {
    expect(offersStudyFilter({ scope: 'cumulative', sourceCount: 2 })).toBe(true);
    expect(offersStudyFilter({ scope: 'cumulative', sourceCount: 1 })).toBe(false);
    expect(offersStudyFilter({ scope: 'single', sourceCount: 3 })).toBe(false);
    expect(offersStudyFilter(null)).toBe(false);
    expect(STUDY_FILTER_OPTIONS.map((option) => option.value)).toEqual(['all', 'newest']);
  });

  it('explains the filter', () => {
    expect(studyFilterNote('all', 3, 'Lecture 5')).toBe('All 3 sources, mixed together.');
    expect(studyFilterNote('newest', 3, 'Lecture 5')).toBe('Only Lecture 5.');
    expect(studyFilterNote('newest', 3, null)).toBe('Only the newest source.');
  });
});
