// The /deal page lets only safe URLs through from the listing HTML.
// Run with: npx tsx tools/listing-html.test.ts

import assert from 'node:assert/strict';
import { allowedUrl } from '../lib/listing-html';

const base = 'https://x.supabase.co/functions/v1/listing/abc?t=1';
assert.equal(allowedUrl('https://thecompr.com/r/1', 'link', base), true);
assert.equal(allowedUrl('mailto:rep@example.com', 'link', base), true);
assert.equal(allowedUrl('tel:+15125550100', 'link', base), true);
assert.equal(allowedUrl('#photos', 'link', base), true);
assert.equal(allowedUrl('javascript:alert(1)', 'link', base), false);
assert.equal(allowedUrl(' JaVaScRiPt:alert(1)', 'link', base), false);
assert.equal(allowedUrl('java\tscript:alert(1)', 'link', base), false);
assert.equal(allowedUrl('data:text/html,<script>alert(1)</script>', 'link', base), false);
assert.equal(allowedUrl('vbscript:x', 'link', base), false);
assert.equal(allowedUrl('https://cdn.example.com/a.jpg', 'load', base), true);
assert.equal(allowedUrl('mailto:a@b.c', 'load', base), false);
assert.equal(allowedUrl('data:image/svg+xml,<svg onload=alert(1)>', 'load', base), false);
// Relative paths resolve against the listing function, an https URL.
assert.equal(allowedUrl('/functions/v1/listing/abc/offer', 'load', base), true);

console.log('listing-html ok');
