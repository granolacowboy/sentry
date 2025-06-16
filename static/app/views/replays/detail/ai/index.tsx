import styled from '@emotion/styled';
import {reset} from 'mockdate';

import {CodeSnippet} from 'sentry/components/codeSnippet';
import {Alert} from 'sentry/components/core/alert';
import {Badge} from 'sentry/components/core/badge';
import {Button} from 'sentry/components/core/button';
import EmptyMessage from 'sentry/components/emptyMessage';
import ErrorBoundary from 'sentry/components/errorBoundary';
import LoadingIndicator from 'sentry/components/loadingIndicator';
import {useReplayContext} from 'sentry/components/replays/replayContext';
import {t} from 'sentry/locale';
import {space} from 'sentry/styles/space';
import type {ApiQueryKey} from 'sentry/utils/queryClient';
import {dataTagErrorSymbol, useApiQuery, useQuery} from 'sentry/utils/queryClient';
import {decodeScalar} from 'sentry/utils/queryString';
import {
  type BreadcrumbFrame,
  isBreadcrumbFrame,
  isSpanFrame,
  type SpanFrame,
} from 'sentry/utils/replays/types';
import useLocationQuery from 'sentry/utils/url/useLocationQuery';
import useOrganization from 'sentry/utils/useOrganization';
import useProjectFromId from 'sentry/utils/useProjectFromId';
import BreadcrumbRow from 'sentry/views/replays/detail/breadcrumbs/breadcrumbRow';
import FluidHeight from 'sentry/views/replays/detail/layout/fluidHeight';
import TabItemContainer from 'sentry/views/replays/detail/tabItemContainer';
import TimestampButton from 'sentry/views/replays/detail/timestampButton';
import type {ReplayRecord} from 'sentry/views/replays/types';

interface Props {
  replayRecord: ReplayRecord | undefined;
}

interface SummaryResponse {
  data: {
    summary: string;
    time_ranges: Array<{period_end: number; period_start: number; period_title: string}>;
    title: string;
  };
}

function createAISummaryQueryKey(
  orgSlug: string,
  projectSlug: string | undefined,
  replayId: string
): ApiQueryKey {
  return [
    `/projects/${orgSlug}/${projectSlug}/replays/${replayId}/summarize/breadcrumbs/`,
  ];
}
enum EventType {
  CLICK = 0,
  DEAD_CLICK = 1,
  RAGE_CLICK = 2,
  NAVIGATION = 3,
  CONSOLE = 4,
  UI_BLUR = 5,
  UI_FOCUS = 6,
  RESOURCE_FETCH = 7,
  RESOURCE_XHR = 8,
  LCP = 9,
  FCP = 10,
  HYDRATION_ERROR = 11,
  MUTATIONS = 12,
  UNKNOWN = 13,
  FEEDBACK = 14,
}

/**
 * Identity the passed event.
 * This function helpfully hides the dirty data munging necessary to identify an event type and
 * helpfully reduces the number of operations required by reusing context from previous branches.
 */
export function which(payload: SpanFrame | BreadcrumbFrame): EventType {
  if (isBreadcrumbFrame(payload)) {
    const category = payload.category;

    if (category === 'ui.click') {
      return EventType.CLICK;
    }
    if (category === 'ui.slowClickDetected') {
      const isTimeoutReason = payload.data?.endReason === 'timeout';
      const isTargetTagname = payload.data?.node?.tagName in ['a', 'button', 'input'];
      const timeout =
        payload.data?.timeAfterClickMs || payload.data?.timeafterclickms || 0;
      if (isTimeoutReason && isTargetTagname && timeout >= 7000) {
        const isRage = (payload.data?.clickCount || payload.data?.clickcount || 0) >= 5;
        return isRage ? EventType.RAGE_CLICK : EventType.DEAD_CLICK;
      }
    } else if (category === 'navigation') {
      return EventType.NAVIGATION;
    } else if (category === 'console') {
      return EventType.CONSOLE;
    } else if (category === 'ui.blur') {
      return EventType.UI_BLUR;
    } else if (category === 'ui.focus') {
      return EventType.UI_FOCUS;
    } else if (category === 'replay.hydrate-error') {
      return EventType.HYDRATION_ERROR;
    } else if (category === 'replay.mutations') {
      return EventType.MUTATIONS;
    } else if (category === 'sentry.feedback') {
      return EventType.FEEDBACK;
    }
  }

  if (isSpanFrame(payload)) {
    const op = payload.op;

    if (op === 'resource.fetch') {
      return EventType.RESOURCE_FETCH;
    }
    if (op === 'resource.xhr') {
      return EventType.RESOURCE_XHR;
    }
    if (op === 'web-vital') {
      if (payload.description === 'largest-contentful-paint') {
        return EventType.LCP;
      }
      if (payload.description === 'first-contentful-paint') {
        return EventType.FCP;
      }
    }
  }
  return EventType.UNKNOWN;
}

/**
 * Return an event as a log message.
 * Useful in AI contexts where the event's structure is an impediment to the AI's understanding
 * of the interaction log. Not every event produces a log message. This function is overly coupled
 * to the AI use case. In later iterations, if more or all log messages are desired, this function
 * should be forked.
 */
export function asLogMessage(payload: BreadcrumbFrame | SpanFrame): string | null {
  const eventType = which(payload);
  const timestamp = payload.timestampMs || 0.0;
  if (isBreadcrumbFrame(payload)) {
    switch (eventType) {
      case EventType.CLICK:
        return `User clicked on ${payload.message} at ${timestamp}`;
      case EventType.DEAD_CLICK:
        return `User clicked on ${payload.message} but the triggered action was slow to complete at ${timestamp}`;
      case EventType.RAGE_CLICK:
        return `User rage clicked on ${payload.message} but the triggered action was slow to complete at ${timestamp}`;
      case EventType.NAVIGATION:
        return `User navigated to: ${payload.data?.to} at ${timestamp}`;
      case EventType.CONSOLE:
        return `Logged: ${payload.message} at ${timestamp}`;
      case EventType.UI_BLUR:
        return `User looked away from the tab at ${timestamp}.`;
      case EventType.UI_FOCUS:
        return `User returned to tab at ${timestamp}.`;
      default:
        return '';
    }
  }

  if (isSpanFrame(payload)) {
    switch (eventType) {
      case EventType.RESOURCE_FETCH: {
        const parsedUrl = new URL(payload.description || '');
        const path = `${parsedUrl.pathname}?${parsedUrl.search}`;
        const size = payload.data?.response?.size;
        const statusCode = payload.data?.statusCode;
        const duration = (payload.endTimestamp || 0) - (payload.startTimestamp || 0);
        const method = payload.data?.method;
        return `Application initiated request: "${method} ${path} HTTP/2.0" ${statusCode} ${size}; took ${duration} milliseconds at ${timestamp}`;
      }
      case EventType.RESOURCE_XHR:
        return null;
      case EventType.LCP: {
        const duration = payload.data?.size;
        const rating = payload.data?.rating;
        return `Application largest contentful paint: ${duration} ms and has a ${rating} rating`;
      }
      case EventType.FCP: {
        const duration = payload.data?.size;
        const rating = payload.data?.rating;
        return `Application first contentful paint: ${duration} ms and has a ${rating} rating`;
      }
      case EventType.HYDRATION_ERROR:
        return `There was a hydration error on the page at ${timestamp}.`;
      case EventType.MUTATIONS:
        return null;
      case EventType.UNKNOWN:
        return null;
      case EventType.FEEDBACK:
        return 'The user filled out a feedback form describing their experience using the application.';
      default:
        return '';
    }
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function useAiSummary(replayRecord: ReplayRecord | undefined) {
  const organization = useOrganization();
  const {project: project_id} = useLocationQuery({
    fields: {project: decodeScalar},
  });
  const project = useProjectFromId({project_id});

  return useApiQuery<SummaryResponse>(
    createAISummaryQueryKey(organization.slug, project?.slug, replayRecord?.id ?? ''),
    {
      staleTime: 0,
      enabled: Boolean(
        replayRecord?.id &&
          project?.slug &&
          organization.features.includes('replay-ai-summaries')
      ),
      retry: false,
    }
  );
}

interface ReplayPrompt {
  body: {logs: string[]};
  signature: string;
}

function useReplayPrompt(replayRecord: ReplayRecord | undefined, logs: string[]) {
  const {project: project_id} = useLocationQuery({
    fields: {project: decodeScalar},
  });
  const project = useProjectFromId({project_id});
  const body = {
    logs,
  };

  return useQuery<ReplayPrompt | null>({
    queryKey: ['replay-prompt', project?.id, replayRecord?.id, body],
    queryFn: async () => {
      try {
        const key = await window.crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode('seers-also-very-long-value-haha'),
          {name: 'HMAC', hash: {name: 'SHA-256'}},
          false,
          ['sign', 'verify']
        );
        const signature = await window.crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(JSON.stringify(body))
        );

        return {
          body,
          signature: Buffer.from(signature).toString('base64'),
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
        return null;
      }
    },
  });
}
function useLocalAiSummary(
  replayRecord: ReplayRecord | undefined,
  logs: string[],
  enabled: boolean
) {
  const {data} = useReplayPrompt(replayRecord, logs);

  return useQuery<SummaryResponse | null>({
    queryKey: ['ai-summary-seer', replayRecord?.id, data],
    queryFn: async () => {
      if (!data) {
        return null;
      }

      const response = await fetch(`/v1/automation/summarize/replay/breadcrumbs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=utf-8',
          Authorization: `Rpcsignature rpc0:${data.signature}`,
        },
        body: JSON.stringify(data.body ?? {}),
      });

      const json = await response.json();
      return json.data;
    },
    enabled,
    retry: false,
  });
}

export default function Ai({replayRecord}: Props) {
  return (
    <PaddedFluidHeight>
      <TabItemContainer data-test-id="replay-details-ai-summary-tab">
        <ErrorBoundary mini>
          <AiContent replayRecord={replayRecord} />
        </ErrorBoundary>
      </TabItemContainer>
    </PaddedFluidHeight>
  );
}

function AiContent({replayRecord}: Props) {
  const organization = useOrganization();
  const {replay} = useReplayContext();

  // const {data: summaryData, isPending, isRefetching, refetch, isError} = useAiSummary(replayRecord);
  // const logs = [...replay?.getChapterFrames()].map(asLogMessage).filter(Boolean) ?? [];
  // const logs = [JSON.stringify(replay?.getChapterFrames?.())];
  const data = replay?._attachments
    ?.filter(({type}) => type === 5)
    .filter(
      ({data}) =>
        (data.tag !== 'performanceSpan' ||
          (!data.payload.op.startsWith('resource') && data.payload.op !== 'memory') ||
          ['resource.xhr', 'resource.fetch'].includes(data.payload.op)) &&
        data.tag !== 'options'
    )
    .map(ev => {
      if (['ui.click', 'ui.input'].includes(ev.data.payload.category)) {
        const {message: _, type: _1, ...rest} = ev.data.payload;
        return rest;
      }

      if (['console'].includes(ev.data.payload.category)) {
        const {type: _1, data, _2, ...rest} = ev.data.payload;
        return rest;
      }

      if (['resource.xhr', 'resource.fetch'].includes(ev.data.payload.op)) {
        const {type: _1, data, startTimestamp, ...rest} = ev.data.payload;
        return {
          timestamp: startTimestamp,
          ...rest,
          data: {
            method: data.method,
            statusCode: data.statusCode,
          },
        };
      }
      const ts =
        ev.data.payload.timestamp || ev.data.payload.startTimestamp || ev.timestamp;

      return {
        timestamp: ts,
        ...ev.data.payload,
      };
    });
  console.log(replay?._attachments, data);
  const logs = [JSON.stringify(data)];

  const {
    data: summaryData,
    isPending,
    isRefetching,
    refetch,
    isError,
    error,
  } = useLocalAiSummary(replayRecord, logs, Boolean(replay?._attachments));

  if (!organization.features.includes('replay-ai-summaries')) {
    return (
      <SummaryContainer>
        <Alert type="info">
          {t('Replay AI summary is not available for this organization.')}
        </Alert>
      </SummaryContainer>
    );
  }

  if (isPending || isRefetching) {
    return (
      <LoadingContainer>
        <LoadingIndicator />
      </LoadingContainer>
    );
  }

  if (isError) {
    return (
      <SummaryContainer>
        <Alert type="error">{t('Failed to load AI summary')}</Alert>
      </SummaryContainer>
    );
  }

  if (!summaryData) {
    return (
      <SummaryContainer>
        <Alert type="info">{t('No summary available for this replay.')}</Alert>
      </SummaryContainer>
    );
  }

  const chapterData = summaryData?.data.time_ranges.map(
    ({period_title, period_start, period_end}) => ({
      title: period_title,
      start: period_start * 1000,
      end: period_end * 1000,
      breadcrumbs:
        replay
          ?.getChapterFrames()
          .filter(
            breadcrumb =>
              breadcrumb.timestampMs >= period_start * 1000 &&
              breadcrumb.timestampMs <= period_end * 1000
          ) ?? [],
    })
  );

  return (
    <ErrorBoundary mini>
      <SummaryContainer>
        <SummaryHeader>
          <SummaryHeaderTitle>
            <span>{t('Replay Summary')}</span>
            <Badge type="internal">{t('Internal')}</Badge>
          </SummaryHeaderTitle>
          <Button priority="primary" size="xs" onClick={() => refetch()}>
            {t('Regenerate')}
          </Button>
        </SummaryHeader>
        <SummaryText>{summaryData.data.summary}</SummaryText>
        <details>
          <Summary>Prompt Logs</Summary>
          <CodeSnippet language="json">{JSON.stringify(logs, null, 4)}</CodeSnippet>
        </details>
        <div>
          {chapterData.map(({title, start, breadcrumbs}, i) => (
            <Details key={i}>
              <Summary>
                <SummaryTitle>
                  <span>{title}</span>

                  <ReplayTimestamp>
                    <TimestampButton
                      startTimestampMs={replay?.getStartTimestampMs() ?? 0}
                      timestampMs={start}
                    />
                  </ReplayTimestamp>
                </SummaryTitle>
              </Summary>
              <div>
                {!breadcrumbs.length && (
                  <EmptyMessage>{t('No breadcrumbs for this chapter')}</EmptyMessage>
                )}
                {breadcrumbs.map((breadcrumb, j) => (
                  <BreadcrumbRow
                    frame={breadcrumb}
                    index={j}
                    onClick={() => {}}
                    onInspectorExpanded={() => {}}
                    onShowSnippet={() => {}}
                    showSnippet={false}
                    allowShowSnippet={false}
                    startTimestampMs={breadcrumb.timestampMs}
                    key={`breadcrumb-${j}`}
                    style={{}}
                  />
                ))}
              </div>
            </Details>
          ))}
        </div>
      </SummaryContainer>
    </ErrorBoundary>
  );
}

const PaddedFluidHeight = styled(FluidHeight)`
  padding-top: ${space(1)};
`;

const Summary = styled('summary')`
  cursor: pointer;
  display: list-item;
`;

const LoadingContainer = styled('div')`
  display: flex;
  justify-content: center;
  padding: ${space(4)};
`;

const SummaryContainer = styled('div')`
  padding: ${space(2)};
  overflow: auto;
`;

const SummaryHeader = styled('h3')`
  display: flex;
  align-items: center;
  gap: ${space(1)};
  justify-content: space-between;
`;

const SummaryHeaderTitle = styled('div')`
  display: flex;
  align-items: center;
  gap: ${space(1)};
`;

const Details = styled('details')`
  &[open] > summary::before {
    content: '-';
  }
`;

const Summary = styled('summary')`
  cursor: pointer;
  display: list-item;
  padding: ${space(1)} 0;
  font-size: ${p => p.theme.fontSizeLarge};

  /* sorry */
  &:focus-visible {
    outline: none;
  }

  list-style-type: none;
  &::-webkit-details-marker {
    display: none;
  }
  &::before {
    content: '+';
    float: left;
    display: inline-block;
    width: 14px;
    margin-right: ${space(1)};
    font-size: ${p => p.theme.fontSizeExtraLarge};
  }
`;

const SummaryTitle = styled('div')`
  display: flex;
  align-items: center;
  gap: ${space(1)};
  justify-content: space-between;
`;

const SummaryText = styled('p')`
  line-height: 1.6;
  white-space: pre-wrap;
`;

// Copied from breadcrumbItem
const ReplayTimestamp = styled('div')`
  color: ${p => p.theme.textColor};
  font-size: ${p => p.theme.fontSizeSmall};
`;
