import { describe, expect, it } from '@jest/globals';

import { describeEquipment, EQUIPMENT, EQUIPMENT_LABELS } from '../equipment';

describe('describeEquipment', () => {
  it('names the gear in plain words, in the order given', () => {
    expect(describeEquipment(['dumbbell', 'bench'])).toBe('Dumbbells, Bench');
    expect(describeEquipment(['band'])).toBe('Resistance bands');
  });

  it('never names bodyweight: nothing needed reads as an empty string, for the caller to word', () => {
    expect(describeEquipment([])).toBe('');
    expect(describeEquipment(['bodyweight'])).toBe('');
    expect(describeEquipment(['bodyweight', 'dumbbell'])).toBe('Dumbbells');
  });

  it('shows gear this app version does not know as given', () => {
    expect(describeEquipment(['dumbbell', 'sandbag_v2'])).toBe('Dumbbells, sandbag_v2');
  });

  it('has a label for every item of the vocabulary', () => {
    for (const item of EQUIPMENT) {
      const text = describeEquipment([item]);
      expect(text).toBe(item === 'bodyweight' ? '' : EQUIPMENT_LABELS[item]);
    }
  });
});
