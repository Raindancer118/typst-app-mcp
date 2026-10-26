import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyReplacements,
  decodeRange,
  encodeRange,
  textFromState,
  updateForNewText
} from "../src/yjs.js";

function stateOf(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("text").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function merged(state: Uint8Array, ...updates: Uint8Array[]): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  for (const u of updates) Y.applyUpdate(doc, u);
  return doc.getText("text").toString();
}

describe("textFromState", () => {
  it("reads the text of a server state", () => {
    expect(textFromState(stateOf("= Titel\n\nAbsatz"))).toBe("= Titel\n\nAbsatz");
  });

  it("reads the real fixture captured from typst.app", () => {
    const fixture = readFileSync(new URL("./fixtures/real-state.yjs", import.meta.url));
    expect(textFromState(fixture)).toBe("= Fixture\n\nÄrger mit Umlauten? Nö. 😀\n");
  });

  it("returns an empty string for an empty state", () => {
    expect(textFromState(Y.encodeStateAsUpdate(new Y.Doc()))).toBe("");
  });
});

describe("updateForNewText", () => {
  it("produces an update that turns the old text into the new one", () => {
    const state = stateOf("Hallo Welt\n");
    const update = updateForNewText(state, "Hallo schöne Welt\n");
    expect(update).not.toBeNull();
    expect(merged(state, update!)).toBe("Hallo schöne Welt\n");
  });

  it("returns null when nothing changed", () => {
    expect(updateForNewText(stateOf("gleich"), "gleich")).toBeNull();
  });

  it("only touches the changed region, so concurrent edits elsewhere survive", () => {
    const state = stateOf("AAA\nBBB\nCCC\n");
    const ours = updateForNewText(state, "AAA\nBxB\nCCC\n")!;

    const other = new Y.Doc();
    Y.applyUpdate(other, state);
    const sv = Y.encodeStateVector(other);
    other.getText("text").insert(0, "Kollege: ");
    const theirs = Y.encodeStateAsUpdate(other, sv);

    expect(merged(state, ours, theirs)).toBe("Kollege: AAA\nBxB\nCCC\n");
    expect(merged(state, theirs, ours)).toBe("Kollege: AAA\nBxB\nCCC\n");
  });

  it("handles astral characters (emoji) without splitting surrogate pairs", () => {
    const state = stateOf("a😀b");
    expect(merged(state, updateForNewText(state, "a😀😀b")!)).toBe("a😀😀b");
    expect(merged(state, updateForNewText(state, "a🙂b")!)).toBe("a🙂b");
  });

  it("can empty and refill a document", () => {
    const state = stateOf("weg damit");
    expect(merged(state, updateForNewText(state, "")!)).toBe("");
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    expect(merged(empty, updateForNewText(empty, "neu")!)).toBe("neu");
  });
});

describe("applyReplacements", () => {
  it("replaces a unique occurrence", () => {
    expect(applyReplacements("a b c", [{ oldString: "b", newString: "B" }])).toBe("a B c");
  });

  it("rejects an ambiguous match unless replaceAll is set", () => {
    expect(() => applyReplacements("x x", [{ oldString: "x", newString: "y" }])).toThrow(/2 times/);
    expect(applyReplacements("x x", [{ oldString: "x", newString: "y", replaceAll: true }])).toBe("y y");
  });

  it("rejects a missing match with a hint", () => {
    expect(() => applyReplacements("abc", [{ oldString: "zzz", newString: "y" }])).toThrow(/not found/);
  });

  it("applies several edits in order", () => {
    const out = applyReplacements("eins zwei drei", [
      { oldString: "eins", newString: "1" },
      { oldString: "drei", newString: "3" }
    ]);
    expect(out).toBe("1 zwei 3");
  });

  it("treats $ patterns in the replacement literally", () => {
    expect(applyReplacements("preis", [{ oldString: "preis", newString: "$& $1 $$" }])).toBe("$& $1 $$");
  });
});

describe("comment ranges", () => {
  it("round-trips a range through the base64 encoding typst.app uses", () => {
    const state = stateOf("Erster Satz. Zweiter Satz.");
    const range = encodeRange(state, 13, 26);
    expect(typeof range.from).toBe("string");
    expect(decodeRange(state, range.from, range.to)).toEqual({ from: 13, to: 26 });
  });

  it("keeps anchoring to the same text after an insert before it", () => {
    const state = stateOf("Erster Satz. Zweiter Satz.");
    const range = encodeRange(state, 13, 26);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    doc.getText("text").insert(0, ">> ");
    const after = Y.encodeStateAsUpdate(doc);
    const pos = decodeRange(after, range.from, range.to)!;
    expect(textFromState(after).slice(pos.from, pos.to)).toBe("Zweiter Satz.");
  });

  it("rejects ranges outside the document", () => {
    expect(() => encodeRange(stateOf("kurz"), 2, 99)).toThrow(/outside/);
  });
});
