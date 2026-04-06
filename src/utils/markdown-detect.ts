/**
 * Detect whether a text string contains Markdown syntax.
 *
 * Checks for: headings (#), bold (**), italic (* / _), code blocks (```),
 * inline code (`), links ([]()),  lists (- / * / 1.), horizontal rules (---).
 */
export function isMarkdown(text: string): boolean {
  // Heading: line starting with 1-6 # followed by a space
  if (/^#{1,6}\s/m.test(text)) return true;
  // Bold: **text**
  if (/\*\*.+?\*\*/s.test(text)) return true;
  // Italic: *text* or _text_ (single delimiter)
  if (/(?<!\*)\*(?!\*).+?(?<!\*)\*(?!\*)/s.test(text)) return true;
  if (/(?<!_)_(?!_).+?(?<!_)_(?!_)/s.test(text)) return true;
  // Fenced code block: ```
  if (/```/.test(text)) return true;
  // Inline code: `text`
  if (/`.+?`/.test(text)) return true;
  // Link: [text](url)
  if (/\[.+?\]\(.+?\)/.test(text)) return true;
  // Unordered list: line starting with - or * followed by a space
  if (/^[\-\*]\s/m.test(text)) return true;
  // Ordered list: line starting with digits followed by . and space
  if (/^\d+\.\s/m.test(text)) return true;
  // Horizontal rule: line with only --- (3+ dashes)
  if (/^-{3,}\s*$/m.test(text)) return true;

  return false;
}
