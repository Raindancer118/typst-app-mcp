import * as Y from "yjs";

// typst.app stores every editable file as a Y.Doc with a single Y.Text named "text".
const TEXT_KEY = "text";

function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

export function textFromState(state: Uint8Array): string {
  return docFromState(state).getText(TEXT_KEY).toString();
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Builds the smallest Yjs update (one delete + one insert around the changed span) that turns
 * the document in `state` into `newText`. Keeping the change local matters: a full rewrite would
 * clobber edits collaborators make concurrently and reset their cursors.
 */
export function updateForNewText(state: Uint8Array, newText: string): Uint8Array | null {
  const doc = docFromState(state);
  const text = doc.getText(TEXT_KEY);
  const oldText = text.toString();
  if (oldText === newText) return null;

  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--;

  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    const deleteCount = oldText.length - prefix - suffix;
    if (deleteCount > 0) text.delete(prefix, deleteCount);
    const inserted = newText.slice(prefix, newText.length - suffix);
    if (inserted.length > 0) text.insert(prefix, inserted);
  });
  return Y.encodeStateAsUpdate(doc, before);
}

export interface Replacement {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export function applyReplacements(text: string, replacements: Replacement[]): string {
  let result = text;
  replacements.forEach((r, index) => {
    const label = replacements.length > 1 ? `Edit #${index + 1}: ` : "";
    if (r.oldString.length === 0) throw new Error(`${label}old_string must not be empty.`);
    const count = countOccurrences(result, r.oldString);
    if (count === 0) {
      throw new Error(
        `${label}old_string not found in the file. Read the file again (typst_read_file) and copy the exact text, including whitespace and line breaks.`
      );
    }
    if (count > 1 && !r.replaceAll) {
      throw new Error(
        `${label}old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all=true.`
      );
    }
    result = r.replaceAll ? result.split(r.oldString).join(r.newString) : result.replace(r.oldString, () => r.newString);
  });
  return result;
}

/** Encodes a character range the way the web editor anchors comments (base64 Yjs relative positions). */
export function encodeRange(state: Uint8Array, from: number, to: number): { from: string; to: string } {
  const text = docFromState(state).getText(TEXT_KEY);
  if (from < 0 || to > text.length || from > to) {
    throw new Error(`Range ${from}..${to} is outside the document (length ${text.length}).`);
  }
  const start = Y.createRelativePositionFromTypeIndex(text, from, 1);
  const end = Y.createRelativePositionFromTypeIndex(text, to, -1);
  return {
    from: Buffer.from(Y.encodeRelativePosition(start)).toString("base64"),
    to: Buffer.from(Y.encodeRelativePosition(end)).toString("base64")
  };
}

/** Resolves a stored comment range against the current document; null if the anchored text is gone. */
export function decodeRange(state: Uint8Array, from: string, to: string): { from: number; to: number } | null {
  const doc = docFromState(state);
  const resolve = (b64: string) => {
    try {
      const rel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(b64, "base64")));
      return Y.createAbsolutePositionFromRelativePosition(rel, doc)?.index ?? null;
    } catch {
      return null;
    }
  };
  const start = resolve(from);
  const end = resolve(to);
  if (start === null || end === null) return null;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}
