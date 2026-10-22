/**
 * Finds an element by all of its text, even when part of it sits in a child
 * element (a torrent's name in <bdi>):
 *
 *   screen.findByText(wholeText("Removed Sintel from Streamy"))
 *
 * Only the innermost element with that text matches, not its ancestors.
 */
export function wholeText(text: string) {
  return (_content: string, element: Element | null): boolean =>
    element !== null &&
    element.textContent === text &&
    !Array.from(element.children).some((child) => child.textContent === text);
}
