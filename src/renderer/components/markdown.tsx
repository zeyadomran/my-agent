import Markdown from 'react-markdown';

/** Transcript links stay inert until a main-owned external-navigation capability exists. */
export function SafeMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown min-w-0 wrap-anywhere">
      <Markdown
        skipHtml
        urlTransform={() => ''}
        allowedElements={[
          'p',
          'strong',
          'em',
          'del',
          'blockquote',
          'ul',
          'ol',
          'li',
          'pre',
          'code',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'hr',
          'br',
          'a',
          'img',
        ]}
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => (
            <span>[Image omitted{alt === undefined || alt === '' ? '' : `: ${alt}`}]</span>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
