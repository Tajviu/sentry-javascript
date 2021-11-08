import { captureException, flush, getCurrentHub, Handlers, startTransaction } from '@sentry/node';
import { extractTraceparentData, hasTracingEnabled } from '@sentry/tracing';
import { Transaction } from '@sentry/types';
import { addExceptionMechanism, isString, logger, objectify, stripUrlQueryAndFragment } from '@sentry/utils';
import * as domain from 'domain';
import { NextApiHandler, NextApiResponse } from 'next';

const { parseRequest } = Handlers;

// purely for clarity
type WrappedNextApiHandler = NextApiHandler;

export type AugmentedNextApiResponse = NextApiResponse & {
  __sentryTransaction?: Transaction;
  __sentryCapturedError?: unknown;
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const withSentry = (origHandler: NextApiHandler): WrappedNextApiHandler => {
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  return async (req, res) => {
    // first order of business: monkeypatch `res.end()` so that it will wait for us to send events to sentry before it
    // fires (if we don't do this, the lambda will close too early and events will be either delayed or lost)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    res.end = wrapEndMethod(res.end);

    // use a domain in order to prevent scope bleed between requests
    const local = domain.create();
    local.add(req);
    local.add(res);

    // `local.bind` causes everything to run inside a domain, just like `local.run` does, but it also lets the callback
    // return a value. In our case, all any of the codepaths return is a promise of `void`, but nextjs still counts on
    // getting that before it will finish the response.
    const boundHandler = local.bind(async () => {
      const currentScope = getCurrentHub().getScope();

      if (currentScope) {
        currentScope.addEventProcessor(event => parseRequest(event, req));

        if (hasTracingEnabled()) {
          // If there is a trace header set, extract the data from it (parentSpanId, traceId, and sampling decision)
          let traceparentData;
          if (req.headers && isString(req.headers['sentry-trace'])) {
            traceparentData = extractTraceparentData(req.headers['sentry-trace'] as string);
            logger.log(`[Tracing] Continuing trace ${traceparentData?.traceId}.`);
          }

          const url = `${req.url}`;
          // pull off query string, if any
          let reqPath = stripUrlQueryAndFragment(url);
          // Replace with placeholder
          if (req.query) {
            // TODO get this from next if possible, to avoid accidentally replacing non-dynamic parts of the path if
            // they match dynamic parts
            for (const [key, value] of Object.entries(req.query)) {
              reqPath = reqPath.replace(`${value}`, `[${key}]`);
            }
          }
          const reqMethod = `${(req.method || 'GET').toUpperCase()} `;

          const transaction = startTransaction(
            {
              name: `${reqMethod}${reqPath}`,
              op: 'http.server',
              ...traceparentData,
            },
            // extra context passed to the `tracesSampler`
            { request: req },
          );
          currentScope.setSpan(transaction);

          // save a link to the transaction on the response, so that even if there's an error (landing us outside of
          // the domain), we can still finish it (albeit possibly missing some scope data)
          (res as AugmentedNextApiResponse).__sentryTransaction = transaction;
        }
      }

      try {
        console.log('about to call handler');
        const handlerResult = await origHandler(req, res); // Call original handler

        // Temporarily mark the response as finished, as a hack to get nextjs not to complain that we're coming back
        // from the handler successfully without `res.end()` having completed its work. This is necessary (and we know
        // we can do it safely) for a few reasons:
        //
        // - Normally, `res.end()` is sync and completes (setting `res.finished` to `true`) before the request handler
        //   returns, as part of the handler sending data back to the client. As soon as the handler is done, nextjs
        //   checks to make sure this has happened and the response is finished, and it complains if it isn't.
        //
        // - In order to prevent the lambda running the route handler from shutting down before we can send events to
        //   Sentry, we monkeypatch `res.end()` so that we can call `flush()`, wait for it to finish, and only then
        //   allow the response to be marked complete. This turns the normally-sync `res.end()` into an async function,
        //   which isn't awaited because it's assumed to still be sync. So when nextjs runs aforementioned check, it
        //   looks like the handler hasn't sent a response, even though in reality is just hasn't yet finished.
        //
        // - In order to trick nextjs into not complaining, we can set `res.finished` to `true`. If we do that, though,
        //   `res.end()` gets mad because it thinks *it* should be the one to get to mark the response complete. We
        //   therefore need to flip it back to `false` after nextjs's check but before the original `res.end()` is
        //   called.
        //
        // - The second part is easy - we control when the original `res.end()` is called, so we can do the flipping
        //   right beforehand and `res.end()` will be none the wiser. The first part isn't as obvious. How do we know we
        //   won't end up with a race condition, such that the flipping to `false` might happen before the check,
        //   negating the entire purpose of this hack? Fortunately, before it's done, our async `res.end()` wrapper has
        //   to await a `setImmediate()` callback, guaranteeing its run lasts at least until the next event loop. The
        //   check, on the other hand, happens synchronously immediately after the request handler, so in the same event
        //   loop. So as long as we wait to flip `res.finished` back to `false` until after the `setImmediate` callback
        //   has run, we know we'll be safely in the next event loop when we do so. Ta-dah! Everyone wins.

        res.finished = true;
        // res.headersSent = true;
        debugger;
        // Object.defineProperty(res, 'headersSent', {
        //   get() {
        //     return true;
        //   },
        // });

        return handlerResult;
      } catch (e) {
        console.log('in catch right after calling handler');

        // console.error(e);

        // In case we have a primitive, wrap it in the equivalent wrapper class (string -> String, etc.) so that we can
        // store a seen flag on it. (Because of the one-way-on-Vercel-one-way-off-of-Vercel approach we've been forced
        // to take, it can happen that the same thrown object gets caught in two different ways, and flagging it is a
        // way to prevent it from actually being reported twice.)
        const objectifiedErr = objectify(e);
        if (currentScope) {
          currentScope.addEventProcessor(event => {
            console.log('in event processor adding exception mechanism');
            addExceptionMechanism(event, {
              type: 'instrument',
              handled: true,
              data: {
                wrapped_handler: origHandler.name,
                function: 'withSentry',
              },
            });
            return event;
          });
          console.log('about to capture the error');
          captureException(objectifiedErr);
        }
        // (res as AugmentedNextApiResponse).__sentryCapturedError = objectifiedErr;

        // Because we're going to finish and send the transaction before passing the error onto nextjs, it won't yet
        // have had a chance to set the status to 500, so unless we do it ourselves now, we'll incorrectly report that
        // the transaction was error-free
        res.statusCode = 500;
        res.statusMessage = 'Internal Server Error';

        console.log('about to call finishSentryWork');
        await finishSentryWork(res);
        debugger;
        console.log('about to rethrow error');
        throw objectifiedErr;
        // return;
      }
    });

    return boundHandler();
  };
};

type ResponseEndMethod = AugmentedNextApiResponse['end'];
type WrappedResponseEndMethod = AugmentedNextApiResponse['end'];

function wrapEndMethod(origEnd: ResponseEndMethod): WrappedResponseEndMethod {
  console.log('wrapping end method');
  return async function newEnd(this: AugmentedNextApiResponse, ...args: unknown[]) {
    console.log('in newEnd');

    await finishSentryWork(this);

    // flip `finished` back to false so that the real `res.end()` method doesn't throw `ERR_STREAM_WRITE_AFTER_END`
    // (which it will if we don't do this, because it expects that *it* will be the one to mark the response finished).
    this.finished = false;

    console.log('about to call origEnd');
    return origEnd.call(this, ...args);
  };
}

async function finishSentryWork(res: AugmentedNextApiResponse): Promise<void> {
  const { __sentryTransaction: transaction } = res;

  if (transaction) {
    transaction.setHttpStatus(res.statusCode);

    // Push `transaction.finish` to the next event loop so open spans have a better chance of finishing before the
    // transaction closes, and make sure to wait until that's done before flushing events
    const transactionFinished: Promise<void> = new Promise(resolve => {
      setImmediate(() => {
        transaction.finish();
        resolve();
      });
    });
    await transactionFinished;
  }

  // Flush the event queue to ensure that events get sent to Sentry before the response is finished and the lambda
  // ends. If there was an error, rethrow it so that the normal exception-handling mechanisms can apply.
  try {
    logger.log('Flushing events...');
    await flush(2000);
    logger.log('Done flushing events');
  } catch (e) {
    logger.log(`Error while flushing events:\n${e}`);
  }
}
