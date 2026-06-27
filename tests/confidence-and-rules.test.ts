import InMemoryActualApiService from './test-doubles/in-memory-actual-api-service';
import MockedLlmService from './test-doubles/mocked-llm-service';
import MockedPromptGenerator from './test-doubles/mocked-prompt-generator';
import GivenActualData from './test-doubles/given/given-actual-data';
import * as config from '../src/config';
import SimilarityCalculator from '../src/similarity-calculator';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import TagService from '../src/transaction/tag-service';
import RuleMatchStrategy from '../src/transaction/processing-strategy/rule-match-strategy';
import ExistingCategoryStrategy from '../src/transaction/processing-strategy/existing-category-strategy';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import CategorySuggester from '../src/transaction/category-suggester';
import BatchTransactionProcessor from '../src/transaction/batch-transaction-processor';
import TransactionProcessor, { TransactionProcessorOptions } from '../src/transaction/transaction-processor';
import TransactionFilterer from '../src/transaction/transaction-filterer';
import TransactionService from '../src/transaction-service';
import ActualAiService from '../src/actual-ai';
import NotesMigrator from '../src/transaction/notes-migrator';
import { TransactionEntity } from '@actual-app/core/src/types/models';

const GUESSED_TAG = '#actual-ai';
const NOT_GUESSED_TAG = '#actual-ai-miss';

const originalIsFeatureEnabled = config.isFeatureEnabled;
const mockIsFeatureEnabled = jest.spyOn(config, 'isFeatureEnabled');

function buildSut(
  api: InMemoryActualApiService,
  llm: MockedLlmService,
  options: TransactionProcessorOptions = {},
  autoRuleEnabled = true,
  concurrency = 1,
) {
  const tagService = new TagService(NOT_GUESSED_TAG, GUESSED_TAG);
  const promptGenerator = new MockedPromptGenerator();
  const processor = new TransactionProcessor(
    api,
    llm,
    promptGenerator,
    tagService,
    [
      new RuleMatchStrategy(api, tagService),
      new ExistingCategoryStrategy(api, tagService),
      new NewCategoryStrategy(),
    ],
    options,
  );
  const batch = new BatchTransactionProcessor(processor, 20, concurrency);
  const suggester = new CategorySuggester(
    api,
    new CategorySuggestionOptimizer(new SimilarityCalculator()),
    tagService,
    autoRuleEnabled,
  );
  const service = new TransactionService(
    api,
    suggester,
    batch,
    new TransactionFilterer(tagService),
    false,
  );
  return new ActualAiService(
    service,
    api,
    new NotesMigrator(api, tagService),
  );
}

function seed(api: InMemoryActualApiService, transactions: TransactionEntity[]): void {
  api.setCategoryGroups(GivenActualData.createSampleCategoryGroups());
  api.setCategories(GivenActualData.createSampleCategories());
  api.setPayees(GivenActualData.createSamplePayees());
  api.setAccounts(GivenActualData.createSampleAccounts());
  api.setRules([]);
  api.setTransactions(transactions);
}

describe('confidence gating and auto-rules', () => {
  let api: InMemoryActualApiService;
  let llm: MockedLlmService;

  beforeEach(() => {
    mockIsFeatureEnabled.mockImplementation((feature: string) => {
      if (feature === 'rerunMissedTransactions') return false;
      if (feature === 'suggestNewCategories') return true;
      return originalIsFeatureEnabled(feature);
    });
    api = new InMemoryActualApiService();
    llm = new MockedLlmService();
  });

  afterEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('marks a low-confidence "new" suggestion as miss instead of creating a junk category', async () => {
    const tx = GivenActualData.createTransaction('1', -510, 'Jujuhatvint', '', GivenActualData.PAYEE_GOOGLE);
    seed(api, [tx]);
    llm.setUnifiedResponse({
      type: 'new',
      newCategory: { name: 'Streaming Services', groupName: 'Usual Expenses', groupIsNew: false },
      confidence: 0.25,
    });
    const createCategorySpy = jest.spyOn(api, 'createCategory');

    await buildSut(api, llm, { newCategoryConfidenceThreshold: 0.5 }).classify();

    const updated = await api.getTransactions();
    expect(updated[0].category).toBeUndefined();
    expect(updated[0].notes).toContain(NOT_GUESSED_TAG);
    expect(createCategorySpy).not.toHaveBeenCalled();
  });

  it('marks a "new" suggestion as miss when suggestNewCategories is disabled', async () => {
    mockIsFeatureEnabled.mockImplementation((feature: string) => {
      if (feature === 'suggestNewCategories') return false;
      if (feature === 'rerunMissedTransactions') return false;
      return originalIsFeatureEnabled(feature);
    });
    const tx = GivenActualData.createTransaction('1', -50, 'New Shop', '', GivenActualData.PAYEE_GOOGLE);
    seed(api, [tx]);
    llm.setUnifiedResponse({
      type: 'new',
      newCategory: { name: 'Whatever', groupName: 'Usual Expenses', groupIsNew: false },
      confidence: 0.99,
    });

    await buildSut(api, llm).classify();

    const updated = await api.getTransactions();
    expect(updated[0].category).toBeUndefined();
    expect(updated[0].notes).toContain(NOT_GUESSED_TAG);
  });

  it('creates an auto-rule for a high-confidence existing classification', async () => {
    const tx = GivenActualData.createTransaction('1', -30, 'Carrefour', '', GivenActualData.PAYEE_CARREFOUR);
    seed(api, [tx]);
    llm.setUnifiedResponse({
      type: 'existing',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
      confidence: 0.95,
    });

    await buildSut(api, llm, { autoRuleThreshold: 0.9 }).classify();

    expect(api.createdPayeeRules).toHaveLength(1);
    expect(api.createdPayeeRules[0]).toMatchObject({
      payeeId: GivenActualData.PAYEE_CARREFOUR,
      categoryId: GivenActualData.CATEGORY_GROCERIES,
    });
  });

  it('does NOT create an auto-rule when confidence is below the threshold', async () => {
    const tx = GivenActualData.createTransaction('1', -30, 'Carrefour', '', GivenActualData.PAYEE_CARREFOUR);
    seed(api, [tx]);
    llm.setUnifiedResponse({
      type: 'existing',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
      confidence: 0.7,
    });

    await buildSut(api, llm, { autoRuleThreshold: 0.9 }).classify();

    expect(api.createdPayeeRules).toHaveLength(0);
  });

  it('reuses the payee cache for a repeated payee (single LLM call)', async () => {
    const tx1 = GivenActualData.createTransaction('1', -30, 'Carrefour', '', GivenActualData.PAYEE_CARREFOUR);
    const tx2 = GivenActualData.createTransaction('2', -45, 'Carrefour', '', GivenActualData.PAYEE_CARREFOUR);
    seed(api, [tx1, tx2]);
    llm.setUnifiedResponse({
      type: 'existing',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
      confidence: 0.95,
    });
    const askSpy = jest.spyOn(llm, 'ask');

    await buildSut(api, llm, { autoRuleThreshold: 0.9 }).classify();

    expect(askSpy).toHaveBeenCalledTimes(1);
    const updated = await api.getTransactions();
    expect(updated[0].category).toBe(GivenActualData.CATEGORY_GROCERIES);
    expect(updated[1].category).toBe(GivenActualData.CATEGORY_GROCERIES);
    // Rule deduped: only one despite two transactions of the same payee
    expect(api.createdPayeeRules).toHaveLength(1);
  });
});

describe('CategorySuggestionOptimizer.filterAgainstExistingCategories', () => {
  const optimizer = new CategorySuggestionOptimizer(new SimilarityCalculator());

  it('collapses a similar suggestion onto the existing category and reassigns its transactions', () => {
    const tx = GivenActualData.createTransaction('1', -20, 'Shop', '', GivenActualData.PAYEE_GOOGLE);
    const suggestions = new Map([
      ['Usual Expenses:Groceries Store', {
        name: 'Groceries Store',
        groupName: 'Usual Expenses',
        groupIsNew: false,
        transactions: [tx],
      }],
    ]);

    const { filtered, reassignments } = optimizer.filterAgainstExistingCategories(
      suggestions,
      [{ id: GivenActualData.CATEGORY_GROCERIES, name: 'Groceries' }],
    );

    expect(filtered.size).toBe(0);
    expect(reassignments).toHaveLength(1);
    expect(reassignments[0]).toMatchObject({
      transaction: tx,
      categoryId: GivenActualData.CATEGORY_GROCERIES,
    });
  });

  it('keeps a genuinely new suggestion that has no similar existing category', () => {
    const tx = GivenActualData.createTransaction('1', -20, 'Shop', '', GivenActualData.PAYEE_GOOGLE);
    const suggestions = new Map([
      ['Usual Expenses:Pet Supplies', {
        name: 'Pet Supplies',
        groupName: 'Usual Expenses',
        groupIsNew: false,
        transactions: [tx],
      }],
    ]);

    const { filtered, reassignments } = optimizer.filterAgainstExistingCategories(
      suggestions,
      [{ id: GivenActualData.CATEGORY_GROCERIES, name: 'Groceries' }],
    );

    expect(filtered.size).toBe(1);
    expect(reassignments).toHaveLength(0);
  });
});
