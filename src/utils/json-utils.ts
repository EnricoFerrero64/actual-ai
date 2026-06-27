import { UnifiedResponse } from '../types';

function cleanJsonResponse(text: string): string {
  // If the text looks like a UUID or simple ID, return it as is
  if (/^[a-zA-Z0-9_-]+$/.test(text.trim())) {
    return text.trim();
  }

  // Remove markdown code fences and any surrounding text
  let cleaned = text.replace(/```json\n?|\n?```/g, '');
  cleaned = cleaned.trim();

  // If there are no JSON structure characters, return the trimmed text as is
  if (!/[{[]/.test(cleaned) || !/[}\]]/.test(cleaned)) {
    return cleaned;
  }

  // Remove leading characters up to first JSON structure character
  cleaned = cleaned.replace(/^[^{[]*?([{[])/, '$1');
  // Remove trailing characters after last JSON structure character
  cleaned = cleaned.replace(/([}\]])[^}\]]*$/, '$1');

  return cleaned.trim();
}

function parseLlmResponse(text: string): UnifiedResponse {
  const cleanedText = cleanJsonResponse(text);
  console.log('Cleaned LLM response:', cleanedText);

  try {
    let parsed: Partial<UnifiedResponse>;
    try {
      parsed = JSON.parse(cleanedText) as Partial<UnifiedResponse>;
    } catch {
      // If not valid JSON, check if it's a simple ID
      const trimmedText = cleanedText.trim().replace(/^"|"$/g, '');

      if (/^[a-zA-Z0-9_-]+$/.test(trimmedText)) {
        console.log(`LLM returned simple ID: "${trimmedText}"`);
        return {
          type: 'existing',
          categoryId: trimmedText,
        };
      }

      throw new Error('Response is neither valid JSON nor simple ID');
    }

    const confidence = typeof (parsed as any).confidence === 'number'
      ? Math.min(1, Math.max(0, (parsed as any).confidence as number))
      : undefined;

    if (parsed.type === 'existing' && parsed.categoryId) {
      return { type: 'existing', categoryId: parsed.categoryId, confidence };
    }
    if (parsed.type === 'rule' && parsed.ruleName) {
      // categoryId is optional — a rule that says "leave uncategorized"
      // matches with no category assignment.
      return {
        type: 'rule',
        ...(parsed.categoryId ? { categoryId: parsed.categoryId } : {}),
        ruleName: parsed.ruleName,
        confidence,
      };
    }
    if (parsed.type === 'new' && parsed.newCategory) {
      return {
        type: 'new',
        newCategory: parsed.newCategory,
        confidence,
      };
    }

    // If the response doesn't match expected format but has a categoryId,
    // default to treating it as an existing category
    if (parsed.categoryId) {
      console.log('LLM response missing type but has categoryId, treating as existing category');
      return {
        type: 'existing',
        categoryId: parsed.categoryId,
      };
    }
    if (parsed && typeof parsed === 'string') {
      return {
        type: 'existing',
        categoryId: parsed,
      };
    }

    console.error('Invalid response structure from LLM:', parsed);
    throw new Error('Invalid response format from LLM');
  } catch (parseError) {
    console.error('Failed to parse LLM response:', cleanedText, parseError);
    throw new Error('Invalid response format from LLM');
  }
}

export { parseLlmResponse, cleanJsonResponse };
