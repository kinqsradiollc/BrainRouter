import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuoteArg } from './shellQuote.js';
test('shellQuoteArg: Windows wraps in DOUBLE quotes (cmd.exe does not strip single quotes)', () => {
    assert.equal(shellQuoteArg('https://github.com/o/r/pull/15', true), '"https://github.com/o/r/pull/15"');
    assert.equal(shellQuoteArg('C:\\Users\\me\\proj', true), '"C:\\Users\\me\\proj"');
});
test('shellQuoteArg: the old POSIX single-quote form is NOT emitted on Windows (the bug)', () => {
    // The previous opener produced `'<url>'`; cmd.exe passed those quotes through
    // literally, so `start "" '<url>'` never opened. The fix must double-quote.
    const out = shellQuoteArg('https://x.com', true);
    assert.ok(out.startsWith('"') && out.endsWith('"'), `expected double-quoted, got ${out}`);
    assert.ok(!out.startsWith("'"), 'must not single-quote on Windows');
});
test('shellQuoteArg: Windows keeps URL query params intact (& protected inside quotes)', () => {
    assert.equal(shellQuoteArg('https://x.com/a?b=1&c=2', true), '"https://x.com/a?b=1&c=2"');
});
test('shellQuoteArg: Windows drops embedded double-quotes (cmd cannot escape them)', () => {
    assert.equal(shellQuoteArg('a"b', true), '"ab"');
});
test('shellQuoteArg: POSIX single-quotes and escapes embedded single quotes', () => {
    assert.equal(shellQuoteArg('https://x.com/path', false), "'https://x.com/path'");
    assert.equal(shellQuoteArg("a'b", false), "'a'\\''b'");
});
