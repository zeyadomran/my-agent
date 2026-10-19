import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { SafeMarkdown } from './markdown';

it('renders Markdown/code while refusing HTML, image loading, and transcript navigation', () => {
  const html = renderToStaticMarkup(
    createElement(SafeMarkdown, {
      content:
        '**Safe**\n\n```js\nconst x = "<tag>";\n```\n\n<img src="file:///private">\n\n![remote](https://example.invalid/pixel)\n\n[open](javascript:alert(1)) [local](file:///private) [web](https://example.invalid)',
    }),
  );
  expect(html).toContain('<strong>Safe</strong>');
  expect(html).toContain('const x = &quot;&lt;tag&gt;&quot;;');
  expect(html).not.toMatch(/<img|<a\b|href=|src=/);
});
