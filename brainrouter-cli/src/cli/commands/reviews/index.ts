import chalk from 'chalk';
import type { ReviewAssuranceDetailView, ReviewSummaryView } from '@kinqs/brainrouter-core/review';
import type { AccountApiTarget } from '../../../runtime/account/accountClient.js';
import { resolveAccountApiTarget } from '../../../runtime/account/accountClient.js';
import {
  getAccountReviewAssurance,
  listAccountReviewJobs,
} from '../../../features/reviews/reviewAccountClient.js';
import {
  renderReviewAssuranceDetail,
  renderReviewList,
} from '../../../features/reviews/reviewPresentation.js';
import type { CommandContext } from '../_context.js';

export interface ReviewsCommandDeps {
  resolveTarget?: () => AccountApiTarget | { error: string };
  list?: (target: AccountApiTarget) => Promise<{ reviews: ReviewSummaryView[]; canRun: boolean }>;
  get?: (target: AccountApiTarget, jobId: string) => Promise<ReviewAssuranceDetailView>;
}

export async function tryHandleReviewsCommand(
  ctx: CommandContext,
  deps: ReviewsCommandDeps = {},
): Promise<boolean> {
  if (ctx.command !== '/reviews') return false;
  const target = (deps.resolveTarget ?? resolveAccountApiTarget)();
  if ('error' in target) {
    console.log(chalk.yellow(target.error));
    return true;
  }
  try {
    const jobId = ctx.args.join(' ').trim();
    if (!jobId) {
      const result = await (deps.list ?? listAccountReviewJobs)(target);
      console.log(renderReviewList(result.reviews, result.canRun));
      return true;
    }
    const detail = await (deps.get ?? getAccountReviewAssurance)(target, jobId);
    console.log(renderReviewAssuranceDetail(detail));
  } catch (error) {
    console.log(chalk.red(error instanceof Error ? error.message : 'Unable to load organization reviews.'));
  }
  return true;
}
