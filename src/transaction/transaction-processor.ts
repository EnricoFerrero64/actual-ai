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
import TagService from './tag-service';

function cleanPayeeName(raw: string): string {
  return raw
    .replace(/^(Facture Carte Du \d{6}|Prlv Sepa|Virement Sepa?|Retrait Dab \S+)\s+/i, '')
    .replace(/Carte \d{4}x+\d+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

  // In-memory payee cache: normalized payee name → response
  private readonly payeeCache = new Map<string, UnifiedResponse>();

  constructor(
    actualApiClient: ActualApiServiceI,
    llmService: LlmServiceI,
    promptGenerator: PromptGeneratorI,
    tagService: TagService,
    processingStrategies: ProcessingStrategyI[],
    searchEnrichment?: SearchEnrichmentServiceI,
    confidenceThreshold = 0.6,
    autoRuleThreshold = 0.9,
  ) {
    this.actualApiService = actualApiClient;
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.tagService = tagService;
    this.processingStrategies = processingStrategies;
    this.searchEnrichment = searchEnrichment;
    this.confidenceThreshold = confidenceThreshold;
    this.autoRuleThreshold = autoRuleThreshold;
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

      const prompt = this.promptGenerator.generate(
        categoryGroups,
        transaction,
        payees,
        rules,
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
            );
            const enrichedResponse = await this.llmService.ask(enrichedPrompt);
            console.log(`[TransactionProcessor] After enrichment: confidence=${enrichedResponse.confidence?.toFixed(2) ?? 'n/a'}, type=${enrichedResponse.type}`);
            response = enrichedResponse;
          }
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
        if (
          response.type === 'existing'
          && response.categoryId
          && response.confidence !== undefined
          && response.confidence >= this.autoRuleThreshold
        ) {
          try {
            await this.actualApiService.createPayeeRule(
              transaction.payee ?? undefined,
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
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    } catch (error) {
      console.error(`Error processing transaction ${transaction.id}:`, error);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    }
  }
}

export default TransactionProcessor;
