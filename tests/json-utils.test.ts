import { parseLlmResponse } from '../src/utils/json-utils';

describe('parseLlmResponse', () => {
  it('parses an existing-category response', () => {
    const result = parseLlmResponse('{"type": "existing", "categoryId": "abc"}');
    expect(result).toEqual({ type: 'existing', categoryId: 'abc' });
  });

  it('parses a rule match with a categoryId', () => {
    const result = parseLlmResponse(
      '{"type": "rule", "categoryId": "def", "ruleName": "Coffee Shop"}',
    );
    expect(result).toEqual({ type: 'rule', categoryId: 'def', ruleName: 'Coffee Shop' });
  });

  it('parses a "leave uncategorized" rule match — ruleName without categoryId', () => {
    const result = parseLlmResponse(
      '{"type": "rule", "ruleName": "Amazon leave uncategorized"}',
    );
    expect(result).toEqual({ type: 'rule', ruleName: 'Amazon leave uncategorized' });
    expect(result.categoryId).toBeUndefined();
  });

  it('treats rule match with explicit null categoryId as leave-uncategorized', () => {
    const result = parseLlmResponse(
      '{"type": "rule", "categoryId": null, "ruleName": "Skip Me"}',
    );
    expect(result.type).toBe('rule');
    expect(result.ruleName).toBe('Skip Me');
    expect(result.categoryId).toBeUndefined();
  });

  it('parses a new-category response', () => {
    const result = parseLlmResponse(
      '{"type": "new", "newCategory": {"name": "Pets", "groupName": "Home", "groupIsNew": true}}',
    );
    expect(result.type).toBe('new');
    expect(result.newCategory).toEqual({ name: 'Pets', groupName: 'Home', groupIsNew: true });
  });

  it('decodes HTML entities in new-category names so they do not fork into duplicates', () => {
    const result = parseLlmResponse(
      '{"type": "new", "newCategory": {"name": "Travel &amp; Accommodation", "groupName": "Bills &amp; Utilities", "groupIsNew": false}, "confidence": 0.8}',
    );
    expect(result.newCategory).toEqual({
      name: 'Travel & Accommodation',
      groupName: 'Bills & Utilities',
      groupIsNew: false,
    });
  });
});
