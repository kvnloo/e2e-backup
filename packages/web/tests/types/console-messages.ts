/** Checks that `browser.consoleMessages` and `browser.pageErrors` return the expected types and don't take any options. */
import type { Browser, WebConsoleMessage, WebPageError } from '../../src/index.ts';

declare const browser: Browser;
void (browser.consoleMessages() satisfies Promise<WebConsoleMessage[]>);
void (browser.pageErrors() satisfies Promise<WebPageError[]>);

declare const error: WebPageError;
void (error.message satisfies string);
void (error.stack satisfies string);

declare const message: WebConsoleMessage;
void (message.text satisfies string);
void ('warning' satisfies WebConsoleMessage['type']);
void ('timeLog' satisfies WebConsoleMessage['type']);
// @ts-expect-error `console.warn` has the type 'warning', not 'warn'.
void ('warn' satisfies WebConsoleMessage['type']);

// @ts-expect-error the lists always hold every entry since the tab opened, so there is no filter.
void browser.consoleMessages({ filter: 'all' });
// @ts-expect-error the lists always hold every entry since the tab opened, so there is no filter.
void browser.pageErrors({ filter: 'since-navigation' });
