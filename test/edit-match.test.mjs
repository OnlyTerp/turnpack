import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySearchReplace } from "../dist/tools/edit-match.js";

const apply = (text, search, replace, all = false) => applySearchReplace(text, search, replace, all);

describe("ship edit matching", () => {
  it("uses the exact text when it is there, and says where an ambiguous one occurs", () => {
    const text = "a = 1\nb = 2\na = 1\n";

    const once = apply(text, "b = 2", "b = 3");
    assert.deepEqual([once.ok, once.how, once.count, once.text], [true, "exact", 1, "a = 1\nb = 3\na = 1\n"]);

    const twice = apply(text, "a = 1", "a = 9");
    assert.equal(twice.ok, false);
    assert.equal(twice.kind, "ambiguous");
    assert.match(twice.message, /matches 2 places \(lines 1, 3\)/);

    const all = apply(text, "a = 1", "a = 9", true);
    assert.deepEqual([all.count, all.text], [2, "a = 9\nb = 2\na = 9\n"]);

    // The replacement is inserted as written: no "$&" or "$1" expansion.
    assert.equal(apply("x = 1\n", "x = 1", "x = '$&$1'").text, "x = '$&$1'\n");
    assert.equal(apply("x\n", "", "y").kind, "empty");
  });

  it("matches LF text against a CRLF file and keeps the file's line endings", () => {
    const out = apply("a\r\nb\r\nc\r\n", "a\nb", "x\ny");
    assert.deepEqual([out.how, out.text], ["line-endings", "x\r\ny\r\nc\r\n"]);
  });

  it("finds a block whose indentation was remembered wrongly, and re-indents what replaces it", () => {
    const file = "function f() {\n    if (x) {\n        return 1;\n    }\n}\n";
    const out = apply(file, "if (x) {\n    return 1;\n}", "if (x) {\n    log();\n    return 2;\n}");
    assert.equal(out.how, "indentation");
    assert.equal(out.text, "function f() {\n    if (x) {\n        log();\n        return 2;\n    }\n}\n");

    // Spaces remembered where the file has tabs: converted level by level.
    const tabbed = "class A {\n\trun() {\n\t\treturn 1;\n\t}\n}\n";
    const tabs = apply(tabbed, "    run() {\n        return 1;\n    }", "    run() {\n        if (ok) {\n            return 2;\n        }\n    }");
    assert.equal(tabs.how, "indentation");
    assert.equal(tabs.text, "class A {\n\trun() {\n\t\tif (ok) {\n\t\t\treturn 2;\n\t\t}\n\t}\n}\n");

    // And the other way round, in a CRLF file, with the trailing newline included in the search.
    const crlf = "  a();\r\n  b();\r\nend\r\n";
    const mixed = apply(crlf, "\ta();\n\tb();\n", "\ta();\n\tc();\n");
    assert.equal(mixed.text, "  a();\r\n  c();\r\nend\r\n");
  });

  it("ignores line numbers copied from a listing, trailing spaces, and typographic quotes", () => {
    const file = "export const TAX = 0.08;\n\nexport function tax(n) {\n  return n * TAX;\n}\n";

    const listing = apply(file, "3 | export function tax(n) {\n4 |   return n * TAX;\n5 | }", "3 | export function tax(n) {\n4 |   return round(n * TAX);\n5 | }");
    assert.equal(listing.how, "line-numbers");
    assert.equal(listing.text, "export const TAX = 0.08;\n\nexport function tax(n) {\n  return round(n * TAX);\n}\n");

    // A file that really does contain "12 | x" is matched exactly, not stripped.
    assert.equal(apply("12 | x\n", "12 | x", "13 | y").how, "exact");

    const spaced = apply("foo();   \nbar();\n", "foo();\nbar();", "baz();");
    assert.deepEqual([spaced.how, spaced.text], ["trailing-whitespace", "baz();\n"]);

    const quoted = apply("  const s = “hello”; // it’s\n", "const s = \"hello\"; // it's", "const s = \"bye\";");
    assert.deepEqual([quoted.how, quoted.text], ["punctuation", "  const s = \"bye\";\n"]);
  });

  it("never picks between two places that only match loosely", () => {
    const file = "if (a) {\n  go();\n}\nif (b) {\n    go();\n}\n";
    const out = apply(file, "      go();", "      stop();");
    assert.equal(out.ok, false);
    assert.equal(out.kind, "ambiguous");
    assert.match(out.message, /matches 2 places \(lines 2, 5\) when indentation is ignored/);

    const all = apply(file, "      go();", "      stop();", true);
    assert.equal(all.text, "if (a) {\n  stop();\n}\nif (b) {\n    stop();\n}\n");

    // Blank lines alone are not a place.
    assert.equal(apply("a\n\n\nb\n", "   \n  ", "x").kind, "not-found");
  });

  it("shows the nearest text and the first difference when nothing matches", () => {
    const file = [
      "import { TAX } from './rates.js';",
      "",
      "export function invoiceTotal(subtotal) {",
      "  const tax = Number((subtotal * TAX).toFixed(2));",
      "  return subtotal + tax;",
      "}",
      "",
    ].join("\n");
    const out = apply(file, "export function invoiceTotal(subtotal) {\n  const tax = subtotal * TAX;\n  return subtotal + tax;\n}", "x");
    assert.equal(out.kind, "not-found");
    assert.match(out.message, /closest text is lines 3-6 \(3 of 4 line\(s\) identical/);
    assert.match(out.message, / 4 \|   const tax = Number\(\(subtotal \* TAX\)\.toFixed\(2\)\);/);
    assert.match(out.message, /First difference, at line 4:/);
    assert.match(out.message, /search has: " {2}const tax = subtotal \* TAX;"/);
    assert.match(out.message, /file has: {3}" {2}const tax = Number/);

    const nowhere = apply(file, "class Zebra extends Animal {}", "x");
    assert.match(nowhere.message, /nothing close to it is in the file \(7 lines\)/);
  });
});
