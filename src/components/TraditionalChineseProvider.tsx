'use client';

import { ReactNode, useEffect } from 'react';

import { toSimplified, toTraditional } from '@/lib/chinese';
import { readTraditionalChinese } from '@/lib/local-preferences';

const SKIP_TAGS = new Set([
  'CODE',
  'PRE',
  'SCRIPT',
  'STYLE',
  'TEXTAREA',
  'INPUT',
]);
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title'];

function shouldSkip(node: Node): boolean {
  let current: Node | null = node;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (SKIP_TAGS.has((current as Element).tagName)) return true;
    if ((current as HTMLElement).isContentEditable) return true;
    current = current.parentNode;
  }
  return false;
}

function translateTextNode(node: Text, converter = toTraditional) {
  if (shouldSkip(node)) return;
  const next = converter(node.nodeValue || '');
  if (next !== node.nodeValue) node.nodeValue = next;
}

function translateElementAttributes(
  element: Element,
  converter = toTraditional,
) {
  if (SKIP_TAGS.has(element.tagName) || (element as HTMLElement).isContentEditable)
    return;
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const next = converter(value);
    if (next !== value) element.setAttribute(attribute, next);
  }
}

function translateTree(root: Node, converter = toTraditional) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, converter);
    return;
  }

  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
    return;
  }

  if (root.nodeType === Node.ELEMENT_NODE) {
    const element = root as Element;
    if (SKIP_TAGS.has(element.tagName) || (element as HTMLElement).isContentEditable)
      return;
    translateElementAttributes(element, converter);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) textNodes.push(current as Text);
  textNodes.forEach((node) => translateTextNode(node, converter));
}

export function TraditionalChineseProvider({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    let observer: MutationObserver | null = null;

    const stop = () => {
      observer?.disconnect();
      observer = null;
      translateTree(document.body, toSimplified);
      document.documentElement.lang = 'zh-CN';
    };

    const start = () => {
      if (observer || !readTraditionalChinese()) return;
      document.documentElement.lang = 'zh-TW';
      translateTree(document.body);
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'characterData') {
            translateTextNode(mutation.target as Text);
          } else if (mutation.type === 'attributes') {
            translateElementAttributes(mutation.target as Element);
          } else {
            mutation.addedNodes.forEach((node) => translateTree(node));
          }
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRIBUTES,
      });
    };

    const handlePreference = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail === false) stop();
      else start();
    };

    start();
    window.addEventListener(
      'traditional-chinese-preference-updated',
      handlePreference,
    );
    return () => {
      stop();
      window.removeEventListener(
        'traditional-chinese-preference-updated',
        handlePreference,
      );
    };
  }, []);

  return children;
}
