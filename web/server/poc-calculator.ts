import {
  reservePocCalculator, markPocCalculatorReady, markPocCalculatorFailed,
  recordManualPocCalculator,
} from './db';
import { buildPocEstimate, saveEstimate, verifyEstimate, shareUrl } from './pricing-calculator';

export interface CalculatorContext {
  name: string;
  region: string;
  mrrUsd: number;
  opportunityId: string;
  awsAccountId: string;
  createdBy: string;
  partnerKey: string;
}

export interface CalculatorOutcome {
  ledgerId: string;
  url: string;
  total: number | null;
  items: { label: string; monthly: number }[];
}

/** Reserve a unique plan before saving and verifying its calculator.aws estimate. */
export async function createUniqueCalculator(ctx: CalculatorContext): Promise<CalculatorOutcome> {
  const { entry, result } = reservePocCalculator({
    opportunityId: ctx.opportunityId,
    awsAccountId: ctx.awsAccountId,
    activityName: ctx.name,
    region: ctx.region,
    mrrUsd: ctx.mrrUsd,
    createdBy: ctx.createdBy,
    partnerKey: ctx.partnerKey,
  }, seed => {
    const built = buildPocEstimate({ name: ctx.name, mrrUsd: ctx.mrrUsd, seed, region: ctx.region });
    return { target: built.plan.target, total: built.plan.total,
      signature: built.plan.signature, built };
  });

  let key: string;
  try {
    key = await saveEstimate(result.built.estimate);
    const v = await verifyEstimate(key, result.built.plan.total,
      Object.keys(result.built.estimate.services).length);
    if (!v.ok) throw new Error(`计算器读回校验失败：${v.problems.join('；')}`);
  } catch (e) {
    markPocCalculatorFailed(entry.id, e instanceof Error ? e.message : String(e));
    throw e;
  }

  const url = shareUrl(key);
  markPocCalculatorReady(entry.id, { calculatorKey: key, calculatorUrl: url });
  return {
    ledgerId: entry.id, url, total: result.built.plan.total,
    items: result.built.plan.services.map(s => ({ label: s.label, monthly: s.monthly })),
  };
}

/** Track a user-provided calculator URL as a manual ledger entry. */
export function recordManualCalculator(ctx: CalculatorContext, url: string): CalculatorOutcome {
  const entry = recordManualPocCalculator({
    opportunityId: ctx.opportunityId,
    awsAccountId: ctx.awsAccountId,
    activityName: ctx.name,
    region: ctx.region,
    mrrUsd: ctx.mrrUsd,
    createdBy: ctx.createdBy,
    partnerKey: ctx.partnerKey,
    calculatorUrl: url,
  });
  return { ledgerId: entry.id, url, total: null, items: [] };
}
