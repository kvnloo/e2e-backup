/** Which annotations a report shows for a test, and how a line names one. */

import type { TestAnnotation } from '@e2e-dev/core/lib/types';

export interface Annotated {
  readonly annotations?: readonly TestAnnotation[] | undefined;
}

/**
 * An attempt that ran shows its own annotations, the declared ones and those
 * pushed at runtime; a test that never ran shows what it `declared`.
 */
export function shownAnnotations(ran: Annotated | undefined, declared: readonly TestAnnotation[] | undefined): readonly TestAnnotation[] {
  return ran === undefined ? (declared ?? []) : (ran.annotations ?? []);
}

const asIs = (text: string): string => text;

/** `type`, or `type: description`, each part passed through its formatter. */
export function annotationLabel(
  annotation: TestAnnotation,
  type: (text: string) => string = asIs,
  description: (text: string) => string = type,
): string {
  return annotation.description === undefined ? type(annotation.type) : `${type(annotation.type)}: ${description(annotation.description)}`;
}
