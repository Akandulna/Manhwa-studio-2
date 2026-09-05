/**
 * URL Pattern Inference Engine
 * Detects chapter numbering patterns from seed URLs and generates templates
 */

export interface PatternResult {
  template: string;
  confidence: 'high' | 'medium' | 'low';
  startNumber: number;
  increment: number;
  padding: number;
  message?: string;
}

interface Token {
  type: 'text' | 'number';
  value: string;
  numericValue?: number;
  padding?: number;
}

/**
 * Tokenize a URL into text and number segments
 */
function tokenize(url: string): Token[] {
  const tokens: Token[] = [];
  const regex = /(\d+)|([^\d]+)/g;
  let match;
  
  while ((match = regex.exec(url)) !== null) {
    if (match[1]) {
      // Numeric token
      const value = match[1];
      tokens.push({
        type: 'number',
        value,
        numericValue: parseInt(value, 10),
        padding: value.length
      });
    } else if (match[2]) {
      // Text token
      tokens.push({
        type: 'text',
        value: match[2]
      });
    }
  }
  
  return tokens;
}

/**
 * Check if numbers form an arithmetic sequence
 */
function isArithmeticSequence(numbers: number[]): { isValid: boolean; increment: number } {
  if (numbers.length < 2) {
    return { isValid: true, increment: 1 };
  }
  
  const increment = numbers[1] - numbers[0];
  
  for (let i = 2; i < numbers.length; i++) {
    if (numbers[i] - numbers[i - 1] !== increment) {
      return { isValid: false, increment: 0 };
    }
  }
  
  return { isValid: true, increment };
}

/**
 * Infer URL pattern from 3 seed URLs
 */
export function inferPattern(seedUrls: string[]): PatternResult {
  if (seedUrls.length < 2) {
    return {
      template: '',
      confidence: 'low',
      startNumber: 1,
      increment: 1,
      padding: 0,
      message: 'Need at least 2 seed URLs to infer a pattern'
    };
  }

  // Tokenize all URLs
  const tokenizedUrls = seedUrls.map(url => tokenize(url));
  
  // Check all URLs have the same structure
  const firstTokenCount = tokenizedUrls[0].length;
  if (!tokenizedUrls.every(t => t.length === firstTokenCount)) {
    return {
      template: '',
      confidence: 'low',
      startNumber: 1,
      increment: 1,
      padding: 0,
      message: 'URLs have different structures - cannot infer pattern automatically'
    };
  }
  
  // Find the token position that differs and forms an arithmetic sequence
  let changingIndex = -1;
  let candidateNumbers: number[] = [];
  let candidatePadding = 0;
  
  for (let i = 0; i < firstTokenCount; i++) {
    const tokensAtPosition = tokenizedUrls.map(t => t[i]);
    
    // Check if all tokens at this position are the same type
    const firstType = tokensAtPosition[0].type;
    if (!tokensAtPosition.every(t => t.type === firstType)) {
      return {
        template: '',
        confidence: 'low',
        startNumber: 1,
        increment: 1,
        padding: 0,
        message: 'URL structure varies between samples'
      };
    }
    
    // For number tokens, check if they differ
    if (firstType === 'number') {
      const numbers = tokensAtPosition.map(t => t.numericValue!);
      const uniqueNumbers = [...new Set(numbers)];
      
      if (uniqueNumbers.length > 1) {
        // This position has varying numbers
        const { isValid, increment } = isArithmeticSequence(numbers);
        
        if (isValid && increment !== 0) {
          if (changingIndex !== -1) {
            // Multiple changing positions - can't determine which is the chapter number
            return {
              template: '',
              confidence: 'low',
              startNumber: 1,
              increment: 1,
              padding: 0,
              message: 'Multiple numeric parts change between URLs - please specify the pattern manually'
            };
          }
          
          changingIndex = i;
          candidateNumbers = numbers;
          candidatePadding = tokensAtPosition[0].padding || 0;
        }
      }
    } else {
      // Text tokens should be identical
      const firstValue = tokensAtPosition[0].value;
      if (!tokensAtPosition.every(t => t.value === firstValue)) {
        return {
          template: '',
          confidence: 'low',
          startNumber: 1,
          increment: 1,
          padding: 0,
          message: 'Text parts of URLs differ - cannot infer pattern'
        };
      }
    }
  }
  
  if (changingIndex === -1) {
    return {
      template: '',
      confidence: 'low',
      startNumber: 1,
      increment: 1,
      padding: 0,
      message: 'No changing numeric part found in the URLs'
    };
  }
  
  // Build the template
  const template = tokenizedUrls[0].map((token, i) => {
    if (i === changingIndex) {
      return '{n}';
    }
    return token.value;
  }).join('');
  
  const { increment } = isArithmeticSequence(candidateNumbers);
  
  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' = 'high';
  let message: string | undefined;
  
  if (seedUrls.length < 3) {
    confidence = 'medium';
    message = 'Pattern detected with only 2 URLs - recommend confirming with the third URL';
  }
  
  if (Math.abs(increment) !== 1) {
    confidence = 'medium';
    message = `Chapter numbers increment by ${increment} (not 1) - please verify`;
  }
  
  return {
    template,
    confidence,
    startNumber: Math.min(...candidateNumbers),
    increment: Math.abs(increment) || 1,
    padding: candidatePadding,
    message
  };
}

/**
 * Generate a URL from a template and chapter number
 */
export function generateUrl(template: string, chapterNumber: number, padding: number = 0): string {
  const paddedNumber = padding > 0 
    ? String(chapterNumber).padStart(padding, '0')
    : String(chapterNumber);
  
  return template.replace('{n}', paddedNumber);
}

/**
 * Extract chapter number from a URL using the template
 */
export function extractChapterNumber(url: string, template: string): number | null {
  // Escape special regex characters in template, except {n}
  const escapedTemplate = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{n\\}', '(\\d+)');
  
  const regex = new RegExp(`^${escapedTemplate}$`);
  const match = url.match(regex);
  
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  
  return null;
}

/**
 * Sanitize a title for use in filesystem paths
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Zero-pad a number for filesystem sorting
 */
export function zeroPad(num: number, width: number = 3): string {
  const intPart = Math.floor(num);
  const decimalPart = num % 1;
  
  if (decimalPart > 0) {
    // Handle decimal chapter numbers like 10.5
    const decStr = decimalPart.toString().slice(2); // Remove "0."
    return `${String(intPart).padStart(width, '0')}.${decStr}`;
  }
  
  return String(intPart).padStart(width, '0');
}
