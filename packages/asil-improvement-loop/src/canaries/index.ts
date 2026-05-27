import type { Canary } from '../types.js';
import { destructiveDiffCanary } from './destructive-diff.js';
import { emptyContentCanary } from './empty-content.js';
import { domainQuestionCanary } from './domain-question.js';

export { destructiveDiffCanary } from './destructive-diff.js';
export { emptyContentCanary } from './empty-content.js';
export { domainQuestionCanary } from './domain-question.js';

export const DEFAULT_CANARIES: Canary[] = [
  destructiveDiffCanary,
  emptyContentCanary,
  domainQuestionCanary,
];
