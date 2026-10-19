import type { DurableMessage, ProfileIdentity } from '../../shared/contracts';
import { SafeMarkdown } from './markdown';
import { Bubble, BubbleContent } from './ui/bubble';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { Marker, MarkerContent } from './ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from './ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from './ui/message-scroller';

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}
function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function Conversation({ messages }: { messages: DurableMessage[] }) {
  const priorProfiles: (ProfileIdentity | null)[] = [];
  let lastProfile: ProfileIdentity | null = null;
  for (const message of messages) {
    priorProfiles.push(lastProfile);
    if (message.profile !== null) lastProfile = message.profile;
  }
  return (
    <section className="min-h-0 flex-1" aria-label="Conversation">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport tabIndex={0} aria-label="Transcript">
            <MessageScrollerContent className="mx-auto max-w-3xl px-4 py-6">
              {messages.length === 0 && (
                <MessageScrollerItem messageId="empty">
                  <Empty className="min-h-60">
                    <EmptyHeader>
                      <EmptyTitle>Start the conversation</EmptyTitle>
                      <EmptyDescription>
                        One conversation across your agents. Configure a profile in settings to
                        begin.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              )}
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const priorProfile = priorProfiles[index];
                const date = dateLabel(message.createdAt);
                return (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <div className="flex min-w-0 flex-col gap-4">
                      {(previous === undefined || dateLabel(previous.createdAt) !== date) && (
                        <Marker variant="separator">
                          <MarkerContent>{date}</MarkerContent>
                        </Marker>
                      )}
                      {message.profile !== null &&
                        priorProfile != null &&
                        priorProfile.id !== message.profile.id && (
                          <Marker variant="separator">
                            <MarkerContent>Continuing with {message.profile.name}</MarkerContent>
                          </Marker>
                        )}
                      <Message align={message.role === 'user' ? 'end' : 'start'}>
                        <MessageContent>
                          {message.role !== 'user' && (
                            <MessageHeader>
                              {message.role === 'system'
                                ? 'System'
                                : (message.profile?.name ?? 'Agent')}{' '}
                              · {timeLabel(message.createdAt)}
                            </MessageHeader>
                          )}
                          <Bubble
                            variant={message.role === 'user' ? 'secondary' : 'ghost'}
                            align={message.role === 'user' ? 'end' : 'start'}
                          >
                            <BubbleContent>
                              {message.role === 'user' ? (
                                <div className="whitespace-pre-wrap wrap-anywhere">
                                  {message.content}
                                </div>
                              ) : (
                                <SafeMarkdown content={message.content} />
                              )}
                              {message.content === '' &&
                                (message.status === 'pending' ||
                                  message.status === 'streaming') && (
                                  <span className="text-muted-foreground">Responding…</span>
                                )}
                            </BubbleContent>
                          </Bubble>
                          {message.status !== 'complete' && (
                            <MessageFooter>
                              {
                                {
                                  pending: 'Pending',
                                  streaming: 'Responding…',
                                  stopped: 'Stopped',
                                  failed: 'Failed',
                                }[message.status]
                              }
                            </MessageFooter>
                          )}
                        </MessageContent>
                      </Message>
                    </div>
                  </MessageScrollerItem>
                );
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </section>
  );
}
