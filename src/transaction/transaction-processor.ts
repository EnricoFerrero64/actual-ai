import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  ActualApiServiceI, APICategoryEntity, APICategoryGroupEntity,
  LlmServiceI, ProcessingStrategyI,
  PromptGeneratorI,
  SearchEnrichmentServiceI,
  UnifiedResponse,
} from '../types';
import { isFeatureEnabled } from '../config';
import TagService from './tag-service';

function cleanPayeeName(raw: string): string {
  return raw
    .replace(/^(Facture Carte Du \d{6}|Prlv Sepa|Virement Sepa?|Retrait Dab \S+)\s+/i, '')
    .replace(/Carte \d{4}x+\d+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface TransactionProcessorOptions {
  searchEnrichment?: SearchEnrichmentServiceI;
  confidenceThreshold?: number;
  autoRuleThreshold?: number;
  newCategoryConfidenceThreshold?: number;
}

class TransactionProcessor {
  private readonly actualApiService: ActualApiServiceI;

  private readonly llmService: LlmServiceI;

  private readonly promptGenerator: PromptGeneratorI;

  private readonly tagService: TagService;

  private readonly processingStrategies: ProcessingStrategyI[];

  private readonly searchEnrichment?: SearchEnrichmentServiceI;

  private readonly confidenceThreshold: number;

  private readonly autoRuleThreshold: number;

  private readonly newCategoryConfidenceThreshold: number;

  // In-memory payee cache: normalized payee name → response
  private readonly payeeCache = new Map<string, UnifiedResponse>();

  constructor(
    actualApiClient: ActualApiServiceI,
    llmService: LlmServiceI,
    promptGenerator: PromptGeneratorI,
    tagService: TagService,
    processingStrategies: ProcessingStrategyI[],
    options: TransactionProcessorOptions = {},
  ) {
    this.actualApiService = actualApiClient;
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.tagService = tagService;
    this.processingStrategies = processingStrategies;
    this.searchEnrichment = options.searchEnrichment;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.6;
    this.autoRuleThreshold = options.autoRuleThreshold ?? 0.9;
    this.newCategoryConfidenceThreshold = options.newCategoryConfidenceThreshold ?? 0.5;
  }

  public async process(
    transaction: TransactionEntity,
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
    try {
      const payeeEntity = payees.find((p) => p.id === transaction.payee);
      const rawPayeeName = payeeEntity?.name ?? transaction.imported_payee ?? '';
      const cacheKey = rawPayeeName.toLowerCase().trim();

      // --- Payee cache hit ---
      const cached = this.payeeCache.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Hit for "${rawPayeeName}" → reusing previous classification`);
        const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(cached));
        if (strategy) {
          await strategy.process(transaction, cached, categories, suggestedCategories);
          return;
        }
      }

      // --- Determine if this is a previously missed transaction ---
      const isPreviousMiss = this.tagService.isNotGuessed(transaction.notes ?? '');

      // Pending categories suggested earlier in this run, so the model can reuse them
      const pendingCategories = Array.from(
        new Set(Array.from(suggestedCategories.values()).map((s) => s.name)),
      );

      const prompt = this.promptGenerator.generate(
        categoryGroups,
        transaction,
        payees,
        rules,
        undefined,
        pendingCategories,
      );

      let response: UnifiedResponse = await this.llmService.ask(prompt);

      // --- Web search enrichment ---
      // Trigger if: low confidence OR previously missed (force search on retry)
      const needsSearch = response.type !== 'rule' && this.searchEnrichment?.isAvailable() && (
        isPreviousMiss
        || (response.confidence !== undefined && response.confidence < this.confidenceThreshold)
      );

      if (needsSearch) {
        const cleanedPayee = cleanPayeeName(rawPayeeName);
        if (cleanedPayee) {
          const reason = isPreviousMiss ? 'previous miss (forced)' : `low confidence (${response.confidence?.toFixed(2)})`;
          console.log(`[TransactionProcessor] ${reason} for "${cleanedPayee}", enriching with web search`);

          const searchContext = await this.searchEnrichment!.enrich(cleanedPayee);
          if (searchContext) {
            const enrichedPrompt = this.promptGenerator.generate(
              categoryGroups,
              transaction,
              payees,
              rules,
              searchContext,
              pendingCategories,
            );
            const enrichedResponse = await this.llmService.ask(enrichedPrompt);
            console.log(`[TransactionProcessor] After enrichment: confidence=${enrichedResponse.confidence?.toFixed(2) ?? 'n/a'}, type=${enrichedResponse.type}`);
            response = enrichedResponse;
          }
        }
      }

      // --- Gate new-category suggestions ---
      if (response.type === 'new') {
        if (!isFeatureEnabled('suggestNewCategories')) {
          // Feature off: don't silently drop — tag as miss so it's visible & retryable
          console.log('[TransactionProcessor] "new" suggestion but suggestNewCategories disabled → tagging as miss');
          await this.markAsMiss(transaction);
          return;
        }
        if (
          response.confidence !== undefined
          && response.confidence < this.newCategoryConfidenceThreshold
        ) {
          console.log(`[TransactionProcessor] "new" suggestion confidence ${response.confidence.toFixed(2)} < ${this.newCategoryConfidenceThreshold} → tagging as miss instead of creating junk category`);
          await this.markAsMiss(transaction);
          return;
        }
      }

      // --- Apply strategy ---
      const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(response));
      if (strategy) {
        await strategy.process(transaction, response, categories, suggestedCategories);

        // --- Cache result for same payee in this run ---
        if (cacheKey) {
          this.payeeCache.set(cacheKey, response);
        }

        // --- Auto-rule creation for high-confidence existing category ---
        // Only when a stable payee entity id exists. Falling back to an
        // `imported_payee contains` rule on raw bank strings (which embed
        // unique transaction refs/dates) would create rules that never match
        // future transactions yet bloat every prompt — so we skip those.
        if (
          response.type === 'existing'
          && response.categoryId
          && transaction.payee
          && response.confidence !== undefined
          && response.confidence >= this.autoRuleThreshold
        ) {
          try {
            await this.actualApiService.createPayeeRule(
              transaction.payee,
              cleanPayeeName(rawPayeeName),
              response.categoryId,
            );
            console.log(`[AutoRule] Created rule for "${rawPayeeName}" → ${response.categoryId} (confidence: ${response.confidence.toFixed(2)})`);
          } catch (err) {
            // Rule may already exist — not fatal
            console.warn(`[AutoRule] Could not create rule for "${rawPayeeName}":`, err);
          }
        }

        return;
      }

      console.warn(`Unexpected response format: ${JSON.stringify(response)}`);
      await this.markAsMiss(transaction);
    } catch (error) {
      console.error(`Error processing transaction ${transaction.id}:`, error);
      await this.markAsMiss(transaction);
    }
  }

  private async markAsMiss(transaction: TransactionEntity): Promise<void> {
    await this.actualApiService.updateTransactionNotes(
      transaction.id,
      this.tagService.addNotGuessedTag(transaction.notes ?? ''),
    );
  }
}

export default TransactionProcessor;
