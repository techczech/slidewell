/**
 * The CPU-bound steps of training, as jobs the training worker runs (train-worker.ts) so the main
 * process never blocks and Stop can end them at once: grouping related screenshots (groups.ts) and
 * fitting the classifier (classifier.ts). Without a worker (unit tests) runJob runs them in-process.
 */
import { groupRelated, type GroupInput, type Grouping } from './groups'
import { train, type Classifier, type Example } from './classifier'

export type Job = { kind: 'group'; items: GroupInput[] } | { kind: 'train'; examples: Example[] }
export type JobResult<J extends Job> = J extends { kind: 'group' } ? Grouping : Classifier

export function runJob<J extends Job>(job: J): JobResult<J> {
  return (job.kind === 'group' ? groupRelated(job.items) : train(job.examples)) as JobResult<J>
}
