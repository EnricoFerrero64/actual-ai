import type { TransactionEntity } from '@actual-app/core/src/types/models';
import type { ActualApiServiceI } from '../types';
import { APICategoryGroupEntity } from '../types';
import CategorySuggestionOptimizer from '../category-suggestion-optimizer';
import TagService from './tag-service';

function cleanPayeeName(raw: string): string {
  return raw
    .replace(/^(Facture Carte Du \d{6}|Prlv Sepa|Virement Sepa?|Retrait Dab \S+)\s+/i, '')
    .replace(/Carte \d{4}x+\d+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

class CategorySuggester {
  private readonly actualApiService: ActualApiServiceI;

  private readonly categorySuggestionOptimizer: CategorySuggestionOptimizer;

  private readonly tagService: TagService;

  private readonly autoRuleEnabled: boolean;

  // Payee ids we've already created a rule for — avoids duplicate rules
  private readonly ruledPayees = new Set<string>();

  constructor(
    actualApiService: ActualApiServiceI,
    categorySuggestionOptimizer: CategorySuggestionOptimizer,
    tagService: TagService,
    autoRuleEnabled = false,
  ) {
    this.actualApiService = actualApiService;
    this.categorySuggestionOptimizer = categorySuggestionOptimizer;
    this.tagService = tagService;
    this.autoRuleEnabled = autoRuleEnabled;
  }

  public async suggest(
    suggestedCategories: Map<string, {
            name: string;
            groupName: string;
            groupIsNew: boolean;
            groupId?: string;
            transactions: TransactionEntity[];
        }>,
    uncategorizedTransactions: TransactionEntity[],
    categoryGroups: APICategoryGroupEntity[],
  ): Promise<void> {
    // Collapse suggestions that duplicate existing categories (semantic similarity).
    // Their transactions are reassigned to the existing category, not dropped.
    const existingCategories = categoryGroups.flatMap(
      (g) => (g.categories ?? []).map((c) => ({ id: c.id, name: c.name })),
    );
    const { filtered: deduped, reassignments } = this.categorySuggestionOptimizer
      .filterAgainstExistingCategories(suggestedCategories, existingCategories);

    // Apply reassignments onto existing categories (Bug fix: no orphan transactions)
    if (reassignments.length > 0) {
      console.log(`Reassigning ${reassignments.length} transaction(s) to existing categories`);
      await Promise.all(
        reassignments.map(async ({ transaction, categoryId, categoryName }) => {
          try {
            await this.actualApiService.updateTransactionNotesAndCategory(
              transaction.id,
              this.tagService.addGuessedTag(transaction.notes ?? ''),
              categoryId,
            );
            if (this.autoRuleEnabled && transaction.payee) {
              await this.maybeCreateRule(transaction, categoryId, categoryName);
            }
          } catch (error) {
            console.error(`Error reassigning transaction ${transaction.id}:`, error);
          }
        }),
      );
    }

    // Optimize (cluster similar suggestions within the run)
    const optimizedCategories = this.categorySuggestionOptimizer
      .optimizeCategorySuggestions(deduped);

    console.log(`Creating ${optimizedCategories.size} optimized categories`);

    // Resolve unique group names to IDs sequentially before the parallel
    // category creation. The LLM-supplied `groupIsNew` flag cannot be
    // trusted (it sometimes claims existing groups are new), and creating
    // groups in parallel races on the Actual Budget API which throws
    // "category group already exists" when two creations collide.
    const uniqueGroupNames = Array.from(new Set(
      Array.from(optimizedCategories.values()).map((s) => s.groupName),
    ));
    const groupIdByName = new Map<string, string>();
    // eslint-disable-next-line no-restricted-syntax
    for (const groupName of uniqueGroupNames) {
      const existing = categoryGroups.find(
        (g) => g.name.toLowerCase() === groupName.toLowerCase(),
      );
      if (existing) {
        groupIdByName.set(groupName, existing.id);
      } else {
        try {
          const newId = await this.actualApiService.createCategoryGroup(groupName);
          groupIdByName.set(groupName, newId);
          console.log(`Created new category group "${groupName}" with ID ${newId}`);
        } catch (error) {
          console.error(`Error creating category group ${groupName}:`, error);
        }
      }
    }

    // Use optimized categories instead of original suggestions
    await Promise.all(
      Array.from(optimizedCategories.entries()).map(async ([_key, suggestion]) => {
        try {
          const groupId = groupIdByName.get(suggestion.groupName);
          if (!groupId) {
            throw new Error(`Missing groupId for category ${suggestion.name}`);
          }

          const newCategoryId = await this.actualApiService.createCategory(
            suggestion.name,
            groupId,
          );

          console.log(`Created new category "${suggestion.name}" with ID ${newCategoryId}`);

          // Use Promise.all with map for nested async operations
          await Promise.all(
            suggestion.transactions.map(async (transaction) => {
              await this.actualApiService.updateTransactionNotesAndCategory(
                transaction.id,
                this.tagService.addGuessedTag(transaction.notes ?? ''),
                newCategoryId,
              );
              console.log(`Assigned transaction ${transaction.id} to new category ${suggestion.name}`);
              // Auto-rule: future runs skip the LLM for this payee → new category
              if (this.autoRuleEnabled && transaction.payee) {
                await this.maybeCreateRule(transaction, newCategoryId, suggestion.name);
              }
            }),
          );
        } catch (error) {
          console.error(`Error creating category ${suggestion.name}:`, error);
        }
      }),
    );
  }

  private async maybeCreateRule(
    transaction: TransactionEntity,
    categoryId: string,
    categoryName: string,
  ): Promise<void> {
    if (!transaction.payee || this.ruledPayees.has(transaction.payee)) {
      return;
    }
    this.ruledPayees.add(transaction.payee);
    try {
      await this.actualApiService.createPayeeRule(
        transaction.payee,
        cleanPayeeName(transaction.imported_payee ?? ''),
        categoryId,
      );
      console.log(`[AutoRule] Created rule for payee of tx ${transaction.id} → "${categoryName}"`);
    } catch (err) {
      console.warn(`[AutoRule] Could not create rule for tx ${transaction.id}:`, err);
    }
  }
}

export default CategorySuggester;
