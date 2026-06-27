import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  APICategoryEntity, APICategoryGroupEntity,
} from '../types';
import TransactionProcessor from './transaction-processor';

async function runWithConcurrency(
  tasks: (() => Promise<void>)[],
  concurrency: number,
): Promise<void> {
  const queue = [...tasks];
  let active = 0;

  return new Promise((resolve, reject) => {
    function next() {
      if (queue.length === 0 && active === 0) { resolve(); return; }
      while (active < concurrency && queue.length > 0) {
        const task = queue.shift()!;
        active++;
        task()
          .then(() => { active--; next(); })
          .catch(reject);
      }
    }
    next();
  });
}

class BatchTransactionProcessor {
  private readonly transactionProcessor: TransactionProcessor;

  private readonly batchSize: number;

  private readonly concurrency: number;

  constructor(
    transactionProcessor: TransactionProcessor,
    batchSize: number,
    concurrency = 1,
  ) {
    this.transactionProcessor = transactionProcessor;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
  }

  public async process(
    uncategorizedTransactions: TransactionEntity[],
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
    categories: (APICategoryEntity | APICategoryGroupEntity)[],
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ): Promise<void> {
    const total = uncategorizedTransactions.length;

    if (this.concurrency > 1) {
      console.log(`Processing ${total} transactions (concurrency=${this.concurrency})`);
    }

    for (
      let batchStart = 0;
      batchStart < total;
      batchStart += this.batchSize
    ) {
      const batchEnd = Math.min(batchStart + this.batchSize, total);
      console.log(`Processing batch ${batchStart / this.batchSize + 1} (transactions ${batchStart + 1}-${batchEnd})`);

      const batch = uncategorizedTransactions.slice(batchStart, batchEnd);

      // Use atomic counter so log lines stay meaningful even in parallel
      let completedInBatch = 0;
      const tasks = batch.map((transaction, batchIndex) => async () => {
        const globalIndex = batchStart + batchIndex;
        console.log(`${globalIndex + 1}/${total} Processing transaction '${transaction.imported_payee}'`);
        await this.transactionProcessor.process(
          transaction,
          categoryGroups,
          payees,
          rules,
          categories,
          suggestedCategories,
        );
        completedInBatch++;
      });

      await runWithConcurrency(tasks, this.concurrency);

      if (batchEnd < total) {
        console.log('Pausing for 2 seconds before next batch...');
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
      }
    }
  }
}

export default BatchTransactionProcessor;
