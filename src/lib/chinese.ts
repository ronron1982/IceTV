import { Converter } from 'opencc-js';

const toSimplifiedConverter = Converter({ from: 'twp', to: 'cn' });
const toTraditionalConverter = Converter({ from: 'cn', to: 'twp' });

function convert(
  converter: (text: string) => string,
  text: string,
  fallbackLabel: string,
): string {
  if (!text) return text;
  try {
    return converter(text);
  } catch (error) {
    console.warn(`${fallbackLabel}失败:`, error);
    return text;
  }
}

export function toSimplified(text: string): string {
  return convert(toSimplifiedConverter, text, '繁体转简体');
}

export function toTraditional(text: string): string {
  return convert(toTraditionalConverter, text, '简体转繁体');
}

export function getSearchQueryVariants(query: string): string[] {
  const variants = [query, toSimplified(query), toTraditional(query)];
  return [...new Set(variants.filter(Boolean))];
}
