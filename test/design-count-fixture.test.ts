import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-count-sep20-calls.json';
import { designCountExistingInteractionStates } from './helpers/design-count-fixture';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCompletionHandoff, isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

describe('September 20 design count fixture omissions', () => {
  test('the failed retry contains eight real decisions, including three unseeded requirements', () => {
    let started = false;
    const reviewHeaders: string[] = [];
    for (const call of structuredClone(captured.calls) as NativePlanQuestionCall[]) {
      const phase = planCountQuestionPhase(nativePlanCallFingerprint(call, 0, true), started,
        designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      if (!phase.preReview && !phase.administrative) reviewHeaders.push(call.questions[0]!.header);
    }
    expect(reviewHeaders).toEqual(Array.from({ length: 8 }, (_, index) => `Issue ${index + 1}`));
    expect(captured.provenance.expectedCeiling).toBe(7);
    for (const header of captured.provenance.unseededHeaders) expect(reviewHeaders).toContain(header);
  });

  const accepted = designCountExistingInteractionStates.join(' ');

  test('the surrounding contract supplies the three missing operation-specific error strings', () => {
    expect(accepted).toContain('Save: “Couldn’t save your changes. Your edits are still here.”');
    expect(accepted).toContain('Export: “Couldn’t prepare your export.”');
    expect(accepted).toContain('Load: “Couldn’t load your settings.”');
    expect(accepted).toContain('Each uses the existing error icon and its sibling Retry');
  });

  test('the surrounding contract defines a clean Save without changing its pending or dirty behavior', () => {
    expect(accepted).toContain('Save stays enabled and focusable while idle, whether clean or dirty.');
    expect(accepted).toContain('A clean Save is a no-op: no request, validation, pending state, timestamp, status, or focus change.');
    expect(accepted).toContain('Only a dirty Save sends the existing atomic request.');
    expect(accepted).toContain('both request buttons use aria-disabled=true');
  });

  test('the surrounding contract names exports without introducing personal data or a date ambiguity', () => {
    expect(accepted).toContain('account-settings-YYYY-MM-DD.json');
    expect(accepted).toContain('the user’s local calendar date');
    expect(accepted).toContain('no account name or email');
    expect(accepted).toContain('Repeated same-day exports keep the browser’s normal collision suffix');
  });
});
