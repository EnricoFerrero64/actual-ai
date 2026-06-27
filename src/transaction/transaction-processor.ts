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

class TransactionProcessor {
  private readonly actualApiService: ActualApiServiceI;

  private readonly llmService: LlmServiceI;

  private readonly promptGenerator: PromptGeneratorI;

  private readonly tagService: TagService;

  private readonly processingStrategies: ProcessingStrategyI[];

  private readonly searchEnrichment?: SearchEnrichmentServiceI;

  private readonly confidenceThreshold: number;

  constructor(
    actualApiClient: ActualApiServiceI,
    llmService: LlmServiceI,
    promptGenerator: PromptGeneratorI,
    tagService: TagService,
    processingStrategies: ProcessingStrategyI[],
    searchEnrichment?: SearchEnrichmentServiceI,
    confidenceThreshold = 0.6,
  ) {
    this.actualApiService = actualApiClient;
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.tagService = tagService;
    this.processingStrategies = processingStrategies;
    this.searchEnrichment = searchEnrichment;
    this.confidenceThreshold = confidenceThreshold;
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
      const prompt = this.promptGenerator.generate(
        categoryGroups,
        transaction,
        payees,
        rules,
      );

      let response: UnifiedResponse = await this.llmService.ask(prompt);

      // Two-pass: if confidence is low and search enrichment is available, retry with context
      if (
        response.type !== 'rule'
        && response.confidence !== undefined
        && response.confidence < this.confidenceThreshold
        && this.searchEnrichment?.isAvailable()
      ) {
        const payeeName = payees.find((p) => p.id === transaction.payee)?.name
          ?? transaction.imported_payee
          ?? '';

        // Strip French bank noise from raw payee strings
        const cleanedPayee = payeeName
          .replace(/^(Facture Carte Du \d{6}|Prlv Sepa|Virement)\s+/i, '')
          .replace(/Carte \d{4}x+\d+.*$/i, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (cleanedPayee) {
          console.log(`[TransactionProcessor] Low confidence (${response.confidence.toFixed(2)}) for "${cleanedPayee}", enriching with web search`);
          const searchContext = await this.searchEnrichment.enrich(cleanedPayee);

          if (searchContext) {
            const enrichedPrompt = this.promptGenerator.generate(
              categoryGroups,
              transaction,
              payees,
              rules,
              searchContext,
            );
            const enrichedResponse = await this.llmService.ask(enrichedPrompt);
            console.log(`[TransactionProcessor] After enrichment: confidence ${enrichedResponse.confidence?.toFixed(2) ?? 'n/a'}, type=${enrichedResponse.type}`);
            response = enrichedResponse;
          }
        }
      }

      const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(response));
      if (strategy) {
        await strategy.process(transaction, response, categories, suggestedCategories);
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
